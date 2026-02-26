/**
 * Ranking Video Assembler — Pure FFmpeg, no AI APIs.
 * 
 * Overlay layout (like real ranking videos):
 *   - Title at top center (highlighted keyword in yellow)
 *   - ALL numbers (1-N) stacked on left side, visible the ENTIRE video
 *   - As each clip plays, its label fades in next to its number
 *   - Currently playing number is highlighted
 *   - Black bars top/bottom, hard cuts between clips
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
        } catch (err) { return 0; }
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
        } catch (err) { return { width: 0, height: 0, duration: 0 }; }
    }

    async trimClip(inputPath, startTime, endTime, outputPath) {
        var duration = endTime - startTime;
        if (duration <= 0) throw new Error('Invalid trim range');
        await this.ffmpeg([
            '-ss', String(startTime), '-i', inputPath, '-t', String(duration),
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-c:a', 'aac', '-b:a', '128k',
            '-avoid_negative_ts', 'make_zero', '-y', outputPath
        ]);
        return outputPath;
    }

    /**
     * Assemble ranking video.
     * clips: [{ path, number, label }] in playback order (highest number first, #1 last)
     * title: { text, highlightWord }
     * options: { layout: { listXPercent, titleYPercent, titleFontSize }, commentary: [{ clipIndex, audioPath }] }
     */
    async assemble(clips, title, options) {
        var jobId = 'ranking-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        var jobDir = path.join(this.tempDir, jobId);
        fs.mkdirSync(jobDir, { recursive: true });

        var commentary = (options && options.commentary) || [];
        console.log('\n🏆 Ranking assembly: ' + clips.length + ' clips' + (commentary.length > 0 ? ' + ' + commentary.filter(function(c) { return c.audioPath; }).length + ' commentary lines' : ''));

        try {
            // Step 1: Normalize each clip
            var normalizedPaths = [];
            var durations = [];
            for (var i = 0; i < clips.length; i++) {
                var outPath = path.join(jobDir, 'norm-' + i + '.ts');
                await this.normalizeClip(clips[i].path, outPath);
                var dur = await this.getDuration(outPath);
                normalizedPaths.push(outPath);
                durations.push(dur);
                console.log('  ✓ Clip ' + (i + 1) + '/' + clips.length + ' (' + dur.toFixed(1) + 's)');
            }

            // Calculate time offsets for each clip
            var offsets = [0];
            for (var i = 0; i < durations.length - 1; i++) {
                offsets.push(offsets[i] + durations[i]);
            }

            // Step 2: Hard-cut concat
            var concatList = path.join(jobDir, 'concat.txt');
            fs.writeFileSync(concatList, normalizedPaths.map(function(p) { return "file '" + p + "'"; }).join('\n'));
            var concatPath = path.join(jobDir, 'concat.mp4');
            await this.ffmpeg(['-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', '-y', concatPath]);

            // Step 3: Generate ASS overlay
            var assPath = path.join(jobDir, 'overlay.ass');
            this.generateASS(assPath, clips, durations, title, options);

            // Step 4: Burn subtitles
            var subtitledPath = path.join(jobDir, 'subtitled.mp4');
            var escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

            await this.ffmpeg([
                '-i', concatPath,
                '-vf', 'ass=' + escapedAss,
                '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
                '-c:a', 'copy', '-y', subtitledPath
            ]);

            // Step 5: Mix commentary audio (if any)
            var outputName = 'ranking-' + Date.now() + '.mp4';
            var finalPath = path.join(this.outputDir, outputName);

            var commentaryWithAudio = commentary.filter(function(c) {
                return c.audioPath && fs.existsSync(c.audioPath);
            });

            if (commentaryWithAudio.length > 0) {
                console.log('  🎙️ Mixing ' + commentaryWithAudio.length + ' commentary audio tracks...');
                await this._mixCommentaryAudio(subtitledPath, commentaryWithAudio, offsets, durations, finalPath, jobDir);
            } else {
                // No commentary — just copy subtitled as final
                fs.copyFileSync(subtitledPath, finalPath);
            }

            var duration = await this.getDuration(finalPath);
            console.log('🏆 Ranking video complete: ' + duration.toFixed(1) + 's');

            return {
                videoUrl: '/studio/generated/final/' + outputName,
                duration: duration,
                clipCount: clips.length
            };
        } finally {
            try { if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true }); }
            catch (e) { console.warn('Cleanup:', e.message); }
        }
    }

    /**
     * Mix commentary audio tracks into the video at the correct timestamps.
     * Each commentary line plays at the start of its corresponding clip.
     * Commentary is mixed on top of existing audio (lowered volume during commentary).
     */
    async _mixCommentaryAudio(videoPath, commentary, offsets, durations, outputPath, jobDir) {
        // Build FFmpeg filter to overlay commentary at correct timestamps
        // Strategy: create a single commentary track with all lines placed at their timestamps,
        // then mix it with the original audio using smooth ducking via sidechaincompress

        var totalDuration = offsets[offsets.length - 1] + durations[durations.length - 1];

        // Build individual delayed commentary tracks and amerge them
        var inputs = ['-i', videoPath];
        var filterParts = [];
        var commentaryLabels = [];

        for (var i = 0; i < commentary.length; i++) {
            var c = commentary[i];
            var startMs = Math.round((offsets[c.clipIndex] || 0) * 1000);
            inputs.push('-i', c.audioPath);
            // Normalize commentary volume (loudnorm) then delay to clip start
            filterParts.push('[' + (i + 1) + ':a]loudnorm=I=-14:TP=-1:LRA=7,adelay=' + startMs + '|' + startMs + ',apad=whole_dur=' + totalDuration.toFixed(2) + '[c' + i + ']');
            commentaryLabels.push('[c' + i + ']');
        }

        // Mix all commentary tracks into one
        var commentaryMix;
        if (commentaryLabels.length === 1) {
            commentaryMix = commentaryLabels[0].replace('[', '').replace(']', '');
            filterParts[filterParts.length - 1] = filterParts[filterParts.length - 1].replace('[c0]', '[cmix]');
            commentaryMix = 'cmix';
        } else {
            filterParts.push(commentaryLabels.join('') + 'amix=inputs=' + commentaryLabels.length + ':duration=longest[cmix]');
            commentaryMix = 'cmix';
        }

        // Smooth ducking: use sidechaincompress so original audio ducks when commentary plays
        // This gives a smooth fade-down/fade-up instead of a hard volume cut
        filterParts.push('[0:a][' + commentaryMix + ']sidechaincompress=threshold=0.01:ratio=6:attack=80:release=400:level_sc=1[ducked]');
        filterParts.push('[ducked][' + commentaryMix + ']amix=inputs=2:duration=first:dropout_transition=0[aout]');

        var filterComplex = filterParts.join(';');

        var args = inputs.concat([
            '-filter_complex', filterComplex,
            '-map', '0:v', '-map', '[aout]',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
            '-shortest', '-y', outputPath
        ]);

        try {
            await this.ffmpeg(args);
        } catch (err) {
            // Fallback: if sidechaincompress not available, use simple volume ducking
            console.warn('sidechaincompress failed, falling back to volume ducking:', err.message);
            filterParts.pop(); filterParts.pop();
            filterParts.push('[0:a]volume=0.55[orig]');
            filterParts.push('[orig][' + commentaryMix + ']amix=inputs=2:duration=first:dropout_transition=0[aout]');
            var fallbackFilter = filterParts.join(';');
            var fallbackArgs = inputs.concat([
                '-filter_complex', fallbackFilter,
                '-map', '0:v', '-map', '[aout]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
                '-shortest', '-y', outputPath
            ]);
            await this.ffmpeg(fallbackArgs);
        }
    }

    /**
     * Generate ASS subtitle file with ranking-style overlays.
     * 
     * Layout (1080x1920):
     *   - Title at top center, entire duration
     *   - Numbers stacked on left side, ALL visible entire duration
     *   - Number order: #1 at top, ascending down (#1, #2, #3...)
     *   - When a clip plays, its label fades in next to its number
     *   - Currently playing number is highlighted
     *   - Position controlled by layout params from frontend
     */
    generateASS(outputPath, clips, durations, title, options) {
        var totalClips = clips.length;
        var lo = (options && options.layout) || {};
        var listXPct = lo.listXPercent || 5;
        var titleYPct = lo.titleYPercent || 6;
        var titleFontSize = lo.titleFontSize || 48;
        var palette = (options && options.colorPalette) || 'yellow';
        var checkered = !!(options && options.checkeredMode);

        // ASS color format: &H00BBGGRR (BGR, not RGB)
        var colorMap = {
            yellow:  { active: '&H0015CCFA', done: '&H0000AACC', hl: '&H0015CCFA' },
            cyan:    { active: '&H00EED322', done: '&H00B59A0E', hl: '&H00EED322' },
            green:   { active: '&H0099D334', done: '&H006E9A1A', hl: '&H0099D334' },
            red:     { active: '&H007171F8', done: '&H004040C4', hl: '&H007171F8' },
            pink:    { active: '&H00B672F4', done: '&H008A4AC4', hl: '&H00B672F4' },
            orange:  { active: '&H003C92FB', done: '&H00206AC8', hl: '&H003C92FB' },
            white:   { active: '&H00FFFFFF', done: '&H00CCCCCC', hl: '&H00FFFFFF' }
        };
        var colors = colorMap[palette] || colorMap.yellow;
        var whiteASS = '&H00FFFFFF';

        // Convert percentages to pixel positions (1080x1920)
        var listX = Math.round((listXPct / 100) * 1080);
        var titleY = Math.round((titleYPct / 100) * 1920);

        // Calculate time offsets
        var offsets = [0];
        for (var i = 0; i < durations.length - 1; i++) {
            offsets.push(offsets[i] + durations[i]);
        }
        var totalDuration = offsets[offsets.length - 1] + durations[durations.length - 1];

        // Sort numbers ascending for display (#1 at top, #2 below, etc.)
        var allNumbers = clips.map(function(c) { return c.number; });
        var sortedNumbers = allNumbers.slice().sort(function(a, b) { return a - b; });

        // Calculate vertical positions — centered in content area
        var rowHeight = 65;
        var listHeight = sortedNumbers.length * rowHeight;
        var listStartY = Math.max(400, Math.floor(960 - listHeight / 2));

        var numberYMap = {};
        for (var n = 0; n < sortedNumbers.length; n++) {
            numberYMap[sortedNumbers[n]] = listStartY + n * rowHeight;
        }

        var labelX = listX + 80;

        var ass = '';
        ass += '[Script Info]\n';
        ass += 'ScriptType: v4.00+\n';
        ass += 'PlayResX: 1080\n';
        ass += 'PlayResY: 1920\n';
        ass += 'WrapStyle: 0\n';
        ass += 'ScaledBorderAndShadow: yes\n\n';

        ass += '[V4+ Styles]\n';
        ass += 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n';

        // Title style — uses custom font size and Y position via MarginV
        ass += 'Style: Title,Arial,' + titleFontSize + ',&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,8,20,20,' + titleY + ',1\n';

        // Number styles — use palette colors
        ass += 'Style: NumDim,Arial,50,&H00888888,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,7,0,0,0,1\n';
        ass += 'Style: NumActive,Arial,56,' + colors.active + ',&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,7,0,0,0,1\n';
        ass += 'Style: NumDone,Arial,50,' + colors.done + ',&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,7,0,0,0,1\n';
        // Checkered alternate style (white or palette color depending on row)
        ass += 'Style: NumDoneAlt,Arial,50,' + whiteASS + ',&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,7,0,0,0,1\n';
        ass += 'Style: Label,Arial,32,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,7,0,0,0,1\n';

        // Commentary subtitle style — font and Y position from options
        var subFont = (options && options.subtitleFont) || 'Arial';
        var subYPct = (options && options.subtitleY != null) ? options.subtitleY : 82;
        var subY = Math.round((subYPct / 100) * 1920);
        ass += 'Style: ComSub,' + subFont + ',42,&H00FFFFFF,&H000000FF,&H00000000,&HC0000000,-1,0,0,0,100,100,0,0,1,3,2,2,40,40,' + subY + ',1\n';

        ass += '\n[Events]\n';
        ass += 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

        var t0 = this.assTime(0);
        var tEnd = this.assTime(totalDuration);

        // Title (entire duration)
        if (title && title.text) {
            var titleText = title.text;
            if (title.highlightWord && titleText.toLowerCase().includes(title.highlightWord.toLowerCase())) {
                var idx = titleText.toLowerCase().indexOf(title.highlightWord.toLowerCase());
                var before = titleText.substring(0, idx);
                var hl = titleText.substring(idx, idx + title.highlightWord.length);
                var after = titleText.substring(idx + title.highlightWord.length);
                titleText = before + '{\\c' + colors.hl + '}' + hl + '{\\c&HFFFFFF&}' + after;
            }
            ass += 'Dialogue: 2,' + t0 + ',' + tEnd + ',Title,,0,0,0,,' + titleText + '\n';
        }

        // Build lookup: number → clip info
        var numberInfo = {};
        for (var c = 0; c < clips.length; c++) {
            numberInfo[clips[c].number] = {
                clipIndex: c, offset: offsets[c], duration: durations[c], label: clips[c].label || ''
            };
        }

        // Numbers — #1 at top, ascending
        for (var s = 0; s < sortedNumbers.length; s++) {
            var num = sortedNumbers[s];
            var y = numberYMap[num];
            var info = numberInfo[num];
            var clipStart = info.offset;
            var clipEnd = info.offset + info.duration;

            // Phase 1: Before clip plays — dim
            if (clipStart > 0.1) {
                ass += 'Dialogue: 1,' + t0 + ',' + this.assTime(clipStart) + ',NumDim,,0,0,0,,{\\pos(' + listX + ',' + y + ')}' + num + '.\n';
            }

            // Phase 2: While clip plays — active yellow
            ass += 'Dialogue: 3,' + this.assTime(clipStart) + ',' + this.assTime(clipEnd) + ',NumActive,,0,0,0,,{\\pos(' + listX + ',' + y + ')}' + num + '.\n';
            if (info.label) {
                ass += 'Dialogue: 3,' + this.assTime(clipStart) + ',' + this.assTime(clipEnd) + ',Label,,0,0,0,,{\\pos(' + labelX + ',' + y + ')\\fad(300,0)}' + info.label + '\n';
            }

            // Phase 3: After clip plays — stays revealed (checkered: alternate style)
            if (clipEnd < totalDuration - 0.1) {
                // Determine row index for checkered mode
                var rowIdx = sortedNumbers.indexOf(num);
                var doneStyle = (checkered && rowIdx % 2 === 1) ? 'NumDoneAlt' : 'NumDone';
                ass += 'Dialogue: 1,' + this.assTime(clipEnd) + ',' + tEnd + ',' + doneStyle + ',,0,0,0,,{\\pos(' + listX + ',' + y + ')}' + num + '.\n';
                if (info.label) {
                    ass += 'Dialogue: 1,' + this.assTime(clipEnd) + ',' + tEnd + ',Label,,0,0,0,,{\\pos(' + labelX + ',' + y + ')}' + info.label + '\n';
                }
            }
        }

        // Commentary subtitles — show each line during its clip
        var commentaryLines = (options && options.commentaryLines) || [];
        for (var cl = 0; cl < commentaryLines.length; cl++) {
            var cLine = commentaryLines[cl];
            if (!cLine.line) continue;
            var cInfo = numberInfo[clips[cLine.clipIndex] && clips[cLine.clipIndex].number];
            if (!cInfo) continue;
            var cStart = cInfo.offset;
            // Show subtitle for 2.5 seconds or clip duration, whichever is shorter
            var cEnd = Math.min(cInfo.offset + cInfo.duration, cStart + 2.5);
            ass += 'Dialogue: 4,' + this.assTime(cStart) + ',' + this.assTime(cEnd) + ',ComSub,,0,0,0,,{\\fad(200,200)}' + cLine.line.replace(/\n/g, ' ') + '\n';
        }

        fs.writeFileSync(outputPath, ass);
        console.log('  ASS overlay generated (' + totalClips + ' numbers, ' + totalDuration.toFixed(1) + 's, listX=' + listX + ', titleY=' + titleY + ', titleSize=' + titleFontSize + ')');
    }

    assTime(seconds) {
        var h = Math.floor(seconds / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        var s = Math.floor(seconds % 60);
        var cs = Math.floor((seconds % 1) * 100);
        return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
    }

    async normalizeClip(inputPath, outputPath) {
        var filterStr = [
            'scale=1080:-2',
            'crop=1080:min(ih\\,1440):0:(ih-min(ih\\,1440))/2',
            'pad=1080:1920:0:(oh-ih)/2:black'
        ].join(',');
        await this.ffmpeg([
            '-i', inputPath, '-vf', filterStr,
            '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
            '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
            '-c:a', 'aac', '-b:a', '128k',
            '-f', 'mpegts', '-y', outputPath
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
