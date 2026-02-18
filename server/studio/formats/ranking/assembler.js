/**
 * Ranking Video Assembler — Pure FFmpeg, no AI APIs.
 * 
 * Takes user-uploaded/downloaded clips, trims them, adds:
 *   - Black bars top/bottom (letterbox for 9:16)
 *   - Numbered list on left side
 *   - Title text overlay with highlighted keyword
 *   - Concatenates clips in user-specified order
 * 
 * Phase 1: Upload + trim + basic concat with black bars
 * Phase 2: Title overlay + numbered list
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');

const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

class RankingAssembler {
    constructor() {
        this.tempDir = path.join(__dirname, '../../../public/studio/generated/temp');
        this.outputDir = path.join(__dirname, '../../../public/studio/generated/final');
        this.uploadDir = path.join(__dirname, '../../../public/studio/ranking-uploads');

        for (var dir of [this.tempDir, this.outputDir, this.uploadDir]) {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        }

        // Find a usable font for drawtext
        this.fontPath = this.findFont();
    }

    /**
     * Find a font file that exists on this system
     */
    findFont() {
        var candidates = [
            '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
            '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
            '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
            '/System/Library/Fonts/Helvetica.ttc',
            '/System/Library/Fonts/SFNSMono.ttf'
        ];
        for (var i = 0; i < candidates.length; i++) {
            if (fs.existsSync(candidates[i])) return candidates[i];
        }
        return null; // Will use FFmpeg default font
    }

    /**
     * Get video duration in seconds
     */
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

    /**
     * Get video dimensions
     */
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
            return {
                width: stream.width || 0,
                height: stream.height || 0,
                duration: duration
            };
        } catch (err) {
            return { width: 0, height: 0, duration: 0 };
        }
    }

    /**
     * Trim a clip: extract from startTime to endTime
     * Returns path to trimmed file
     */
    async trimClip(inputPath, startTime, endTime, outputPath) {
        var duration = endTime - startTime;
        if (duration <= 0) throw new Error('Invalid trim range');

        await this.ffmpeg([
            '-i', inputPath,
            '-ss', String(startTime),
            '-t', String(duration),
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '128k',
            '-y', outputPath
        ]);

        return outputPath;
    }

    /**
     * Assemble ranking video from trimmed clips.
     * 
     * clips: [{ path, label, number }] — in playback order
     * title: { text, highlightWord, highlightColor }
     * 
     * Output: 1080x1920 (9:16) with black bars, numbered list, title
     */
    async assemble(clips, title, options) {
        options = options || {};
        var jobId = 'ranking-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        var jobDir = path.join(this.tempDir, jobId);
        fs.mkdirSync(jobDir, { recursive: true });

        console.log('\n🏆 Ranking assembly: ' + clips.length + ' clips');

        try {
            // Step 1: Normalize each clip to 1080x1920 with black bars
            var normalizedPaths = [];
            for (var i = 0; i < clips.length; i++) {
                var clip = clips[i];
                var outPath = path.join(jobDir, 'norm-' + i + '.ts');
                await this.normalizeClip(clip.path, outPath, clip.number, clip.label, title);
                normalizedPaths.push(outPath);
                console.log('  ✓ Clip ' + (i + 1) + '/' + clips.length + ' normalized');
            }

            // Step 2: Concat all normalized clips
            var concatList = path.join(jobDir, 'concat.txt');
            var lines = normalizedPaths.map(function(p) { return "file '" + p + "'"; });
            fs.writeFileSync(concatList, lines.join('\n'));

            var concatPath = path.join(jobDir, 'concat.mp4');
            await this.ffmpeg([
                '-f', 'concat', '-safe', '0', '-i', concatList,
                '-c', 'copy', '-y', concatPath
            ]);

            // Step 3: Move to output
            var outputName = 'ranking-' + Date.now() + '.mp4';
            var finalPath = path.join(this.outputDir, outputName);
            fs.copyFileSync(concatPath, finalPath);

            // Get duration
            var duration = await this.getDuration(finalPath);

            console.log('🏆 Ranking video complete: ' + duration.toFixed(1) + 's');

            return {
                videoUrl: '/studio/generated/final/' + outputName,
                duration: duration,
                clipCount: clips.length
            };

        } finally {
            // Cleanup temp
            try {
                if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
            } catch (e) { console.warn('Cleanup:', e.message); }
        }
    }

    /**
     * Normalize a single clip to 1080x1920 with:
     * - Black bars top/bottom
     * - Number overlay on left
     * - Clip label next to number
     * - Title at top
     */
    async normalizeClip(inputPath, outputPath, number, label, title) {
        var filters = [];
        var fontOpt = this.fontPath ? ':fontfile=' + this.fontPath : '';

        // Scale + pad to 1080x1920 with black bars
        filters.push(
            'scale=1080:1440:force_original_aspect_ratio=decrease',
            'pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black'
        );

        // Number overlay — big yellow number on left
        if (number) {
            filters.push(
                "drawtext=text='" + number + "'" +
                ":fontsize=120:fontcolor=yellow" +
                ":x=40:y=(h/2)-60" +
                fontOpt +
                ":borderw=4:bordercolor=black"
            );
        }

        // Label next to number
        if (label) {
            var safeLabel = label.replace(/'/g, "'\\''").replace(/:/g, '\\:');
            filters.push(
                "drawtext=text='" + safeLabel + "'" +
                ":fontsize=36:fontcolor=white" +
                ":x=180:y=(h/2)-18" +
                fontOpt +
                ":borderw=2:bordercolor=black"
            );
        }

        // Title at top center
        if (title && title.text) {
            var safeTitle = title.text.replace(/'/g, "'\\''").replace(/:/g, '\\:');
            filters.push(
                "drawtext=text='" + safeTitle + "'" +
                ":fontsize=48:fontcolor=white" +
                ":x=(w-text_w)/2:y=60" +
                fontOpt +
                ":borderw=3:bordercolor=black"
            );
        }

        var filterStr = filters.join(',');

        await this.ffmpeg([
            '-i', inputPath,
            '-vf', filterStr,
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '128k',
            '-f', 'mpegts',
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
