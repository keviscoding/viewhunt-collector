/**
 * Ranking Video Assembler — Pure FFmpeg, no AI APIs.
 * 
 * Takes user-uploaded/downloaded clips, trims them:
 *   - Scales to fill 1080px wide (crops height if needed)
 *   - Black bars top/bottom only (1080x1920 output)
 *   - Hard cuts between clips (no fades)
 *   - ASS subtitle overlays for title, numbers, and labels
 *     (uses libass which IS in ffmpeg-static, unlike drawtext/libfreetype)
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
     * Assemble ranking video from clips.
     * Hard cuts, ASS subtitle overlays for title + numbers + labels.
     * 
     * clips: [{ path, number, label }] — in playback order
     * title: { text, highlightWord }
     * Output: 1080x1920 (9:16), black bars top/bottom only
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
                var outPath = path.join(jobDir, 'norm-' + i + '.ts');
                await this.normalizeClip(clip.path, outPath);
                var dur = await this.getDuration(outPath);
                normalizedPaths.push(outPath);
                durations.push(dur);
                console.log('  ✓ Clip ' + (i + 1) + '/' + clips.length + ' normalized (' + dur.toFixed(1) + 's)');
            }

            // Step 2: Hard-cut concat (no fades)
            var concatList = path.join(jobDir, 'concat.txt');
            var lines = normalizedPaths.map(function(p) { return "file '" + p + "'"; });
            fs.writeFileSync(concatList, lines.join('\n'));

            var concatPath = path.join(jobDir, 'concat.mp4');
            await this.ffmpeg([
                '-f', 'concat', '-safe', '0', '-i', concatList,
                '-c', 'copy', '-y', concatPath
            ]);

            // Step 3: Generate ASS subtitle file for overlays
            var assPath = path.join(jobDir, 'overlays.ass');
            this.generateASS(assPath, clips, durations, title);

            // Step 4: Burn subtitles onto the concat video
            // Escape the ASS path for FFmpeg filter syntax (colons, backslashes, brackets)
            var escapedAssPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\\\\\''");
            var outputName = 'ranking-' + Date.now() + '.mp4';
            var finalPath = path.join(this.outputDir, outputName);

            await this.ffmpeg([
                '-i', concatPath,
                '-vf', 'ass=' + escapedAssPath,
                '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
                '-c:a', 'copy',
                '-y', finalPath
            ]);

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
     * Generate ASS subtitle file with:
     * - Title text at top center (with highlighted word in yellow)
     * - Number on left side for each clip
     * - Label next to number for each clip
     * 
     * ASS uses a coordinate system based on PlayResX/PlayResY.
     * We set PlayResX=1080, PlayResY=1920 to match our output.
     */
    generateASS(outputPath, clips, durations, title) {
        // Calculate time offsets for each clip
        var offsets = [0];
        for (var i = 0; i < durations.length - 1; i++) {
            offsets.push(offsets[i] + durations[i]);
        }
        var totalDuration = offsets[offsets.length - 1] + durations[durations.length - 1];

        // ASS header
        var ass = '';
        ass += '[Script Info]\n';
        ass += 'ScriptType: v4.00+\n';
        ass += 'PlayResX: 1080\n';
        ass += 'PlayResY: 1920\n';
        ass += 'WrapStyle: 0\n';
        ass += 'ScaledBorderAndShadow: yes\n';
        ass += '\n';

        // Styles
        // Title style: big bold white text, centered at top, black outline
        ass += '[V4+ Styles]\n';
        ass += 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n';
        // Title: top center (Alignment 8 = top center)
        ass += 'Style: Title,Arial,52,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,8,20,20,55,1\n';
        // Title highlight word: yellow (Alignment 8 = top center)
        ass += 'Style: TitleHL,Arial,52,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,8,20,20,55,1\n';
        // Number: big yellow, left side (Alignment 4 = middle left)
        ass += 'Style: Number,Arial,110,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,3,4,40,20,0,1\n';
        // Label: white, next to number (Alignment 4 = middle left)
        ass += 'Style: Label,Arial,38,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,2,4,190,20,0,1\n';
        ass += '\n';

        // Events (dialogue lines)
        ass += '[Events]\n';
        ass += 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

        // Title — shown for entire video duration
        if (title && title.text) {
            var titleStart = this.assTime(0);
            var titleEnd = this.assTime(totalDuration);

            if (title.highlightWord && title.text.toLowerCase().includes(title.highlightWord.toLowerCase())) {
                // Split title into parts: before highlight, highlight, after highlight
                var idx = title.text.toLowerCase().indexOf(title.highlightWord.toLowerCase());
                var before = title.text.substring(0, idx);
                var hl = title.text.substring(idx, idx + title.highlightWord.length);
                var after = title.text.substring(idx + title.highlightWord.length);
                // Use override tags to color the highlight word yellow within the title
                var titleText = before + '{\\c&H00FFFF&}' + hl + '{\\c&HFFFFFF&}' + after;
                ass += 'Dialogue: 1,' + titleStart + ',' + titleEnd + ',Title,,0,0,0,,' + titleText + '\n';
            } else {
                ass += 'Dialogue: 1,' + titleStart + ',' + titleEnd + ',Title,,0,0,0,,' + title.text + '\n';
            }
        }

        // Numbers and labels for each clip
        for (var j = 0; j < clips.length; j++) {
            var clip = clips[j];
            var start = this.assTime(offsets[j]);
            var end = this.assTime(offsets[j] + durations[j]);

            // Number
            if (clip.number) {
                ass += 'Dialogue: 1,' + start + ',' + end + ',Number,,0,0,0,,' + clip.number + '\n';
            }

            // Label
            if (clip.label) {
                ass += 'Dialogue: 1,' + start + ',' + end + ',Label,,0,0,0,,' + clip.label + '\n';
            }
        }

        fs.writeFileSync(outputPath, ass);
        console.log('  ✓ ASS subtitle file generated (' + clips.length + ' clips, ' + totalDuration.toFixed(1) + 's)');
    }

    /**
     * Convert seconds to ASS time format: H:MM:SS.CC
     */
    assTime(seconds) {
        var h = Math.floor(seconds / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        var s = Math.floor(seconds % 60);
        var cs = Math.floor((seconds % 1) * 100);
        return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
    }

    /**
     * Normalize a single clip to 1080x1920.
     * - Scale to fill 1080px wide (crop excess height if needed)
     * - Pad to 1080x1920 with black bars on top/bottom only
     */
    async normalizeClip(inputPath, outputPath) {
        var filterStr = [
            'scale=1080:-2',
            'crop=1080:min(ih\\,1440):0:(ih-min(ih\\,1440))/2',
            'pad=1080:1920:0:(oh-ih)/2:black'
        ].join(',');

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
