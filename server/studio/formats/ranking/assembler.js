/**
 * Ranking Video Assembler — Pure FFmpeg, no AI APIs.
 * 
 * Takes user-uploaded/downloaded clips, trims them:
 *   - Scales to fill 1080px wide (crops height if needed)
 *   - Black bars top/bottom only (1080x1920 output)
 *   - Crossfade transitions between clips
 * 
 * Phase 1: Upload + trim + concat with black bars + crossfade
 * Phase 2: Title overlay + numbered list (image-based overlays)
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');

const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

const XFADE_DURATION = 0.5; // seconds of crossfade between clips

class RankingAssembler {
    constructor() {
        this.tempDir = path.join(__dirname, '../../../public/studio/generated/temp');
        this.outputDir = path.join(__dirname, '../../../public/studio/generated/final');
        this.uploadDir = path.join(__dirname, '../../../public/studio/ranking-uploads');

        for (var dir of [this.tempDir, this.outputDir, this.uploadDir]) {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        }
    }

    async getDuration(filePath) {
        try {
            var r = await execFileAsync(ffprobePath, [
                '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath
            ]);
            return parseFloat(r.stdout.trim()) || 0;
        } catch (err) {
            console.warn('Could not get duration:', err.message);
            return 0;
        }
    }

    async getVideoInfo(filePath) {
        try {
            var r = await execFileAsync(ffprobePath, [
                '-v', 'quiet', '-select_streams', 'v:0',
                '-show_entries', 'stream=width,height,duration',
                '-show_entries', 'format=duration',
                '-of', 'json', filePath
            ]);
            var info = JSON.parse(r.stdout);
            var stream = (info.streams && info.streams[0]) || {};
            var duration = parseFloat(stream.duration) || parseFloat((info.format || {}).duration) || 0;
            return { width: stream.width || 0, height: stream.height || 0, duration: duration };
        } catch (err) {
            return { width: 0, height: 0, duration: 0 };
        }
    }

    async trimClip(inputPath, startTime, endTime, outputPath) {
        var duration = endTime - startTime;
        if (duration <= 0) throw new Error('Invalid trim range');

        await this.ffmpeg([
            '-ss', String(startTime),
            '-i', inputPath,
            '-t', String(duration),
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '128k',
            '-avoid_negative_ts', 'make_zero',
            '-y', outputPath
        ]);
        return outputPath;
    }

    /**
     * Assemble ranking video from clips with crossfade transitions.
     * 
     * clips: [{ path, number }] — in playback order
     * Output: 1080x1920 (9:16), black bars top/bottom only, crossfade between clips
     */
    async assemble(clips, title, options) {
        options = options || {};
        var jobId = 'ranking-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        var jobDir = path.join(this.tempDir, jobId);
        fs.mkdirSync(jobDir, { recursive: true });

        console.log('\n🏆 Ranking assembly: ' + clips.length + ' clips');

        try {
            // Step 1: Normalize each clip to 1080x1920 (fill width, black bars top/bottom)
            var normalizedPaths = [];
            var durations = [];
            for (var i = 0; i < clips.length; i++) {
                var clip = clips[i];
                var outPath = path.join(jobDir, 'norm-' + i + '.mp4');
                await this.normalizeClip(clip.path, outPath);
                var dur = await this.getDuration(outPath);
                normalizedPaths.push(outPath);
                durations.push(dur);
                console.log('  ✓ Clip ' + (i + 1) + '/' + clips.length + ' normalized (' + dur.toFixed(1) + 's)');
            }

            // Step 2: Crossfade concat
            var outputName = 'ranking-' + Date.now() + '.mp4';
            var finalPath = path.join(this.outputDir, outputName);

            if (normalizedPaths.length === 1) {
                // Single clip — just copy
                fs.copyFileSync(normalizedPaths[0], finalPath);
            } else {
                // Build xfade chain for 2+ clips
                await this.crossfadeConcat(normalizedPaths, durations, finalPath, jobDir);
            }

            var duration = await this.getDuration(finalPath);
            console.log('🏆 Ranking video complete: ' + duration.toFixed(1) + 's');

            return {
                videoUrl: '/studio/generated/final/' + outputName,
                duration: duration,
                clipCount: clips.length
            };

        } finally {
            try {
                if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
            } catch (e) { console.warn('Cleanup:', e.message); }
        }
    }

    /**
     * Crossfade concat: chain xfade filters between clips.
     * For N clips, we do N-1 xfade operations sequentially
     * to keep memory low (process pairs one at a time).
     */
    async crossfadeConcat(paths, durations, outputPath, jobDir) {
        // Sequential approach: merge clip 0+1 → temp, then temp+2 → temp2, etc.
        // This keeps memory usage low (only 2 clips in memory at a time).
        var currentPath = paths[0];
        var currentDur = durations[0];

        for (var i = 1; i < paths.length; i++) {
            var nextPath = paths[i];
            var nextDur = durations[i];
            var isLast = (i === paths.length - 1);
            var outPath = isLast ? outputPath : path.join(jobDir, 'xfade-' + i + '.mp4');

            // xfade offset = duration of current clip minus crossfade duration
            var offset = Math.max(0, currentDur - XFADE_DURATION);

            await this.ffmpeg([
                '-i', currentPath,
                '-i', nextPath,
                '-filter_complex',
                '[0:v][1:v]xfade=transition=fade:duration=' + XFADE_DURATION + ':offset=' + offset.toFixed(3) + '[v];' +
                '[0:a][1:a]acrossfade=d=' + XFADE_DURATION + '[a]',
                '-map', '[v]', '-map', '[a]',
                '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
                '-c:a', 'aac', '-b:a', '128k',
                '-y', outPath
            ]);

            // Update current for next iteration
            currentPath = outPath;
            // New duration = currentDur + nextDur - crossfade overlap
            currentDur = currentDur + nextDur - XFADE_DURATION;
        }
    }

    /**
     * Normalize a single clip to 1080x1920.
     * - Scale to fill 1080px wide (crop excess height if wider than 9:16)
     * - Pad to 1080x1920 with black bars on top/bottom only
     * - No side bars ever
     */
    async normalizeClip(inputPath, outputPath) {
        // Strategy:
        // 1. scale=1080:-2 → force width to 1080, height auto (keeps aspect ratio)
        // 2. If height > 1440: crop to 1440 from center
        // 3. If height < 1440: keep as-is
        // 4. pad to 1080x1920 centered → black bars only on top/bottom
        var filterStr = [
            'scale=1080:-2',                                    // fill 1080 wide
            'crop=1080:min(ih\\,1440):0:(ih-min(ih\\,1440))/2', // crop height to max 1440 from center
            'pad=1080:1920:0:(oh-ih)/2:black'                   // black bars top/bottom
        ].join(',');

        await this.ffmpeg([
            '-i', inputPath,
            '-vf', filterStr,
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '128k',
            '-y', outputPath
        ]);
    }

    async ffmpeg(args) {
        try {
            return await execFileAsync(ffmpegPath, args, { timeout: 600000, maxBuffer: 10 * 1024 * 1024 });
        } catch (error) {
            if (error.code) {
                var msg = (error.stderr || '').substring(0, 500);
                console.error('FFmpeg error:', msg);
                throw new Error('FFmpeg failed (code ' + error.code + '): ' + msg.substring(0, 200));
            }
            return { stdout: error.stdout, stderr: error.stderr };
        }
    }
}

module.exports = RankingAssembler;
