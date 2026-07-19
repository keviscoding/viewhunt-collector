/**
 * Ranking Video Assembler — Pure FFmpeg, no AI APIs.
 *
 * Overlay modes:
 *   viral (default with commentary): black title bar, multi-color title,
 *     centered "N. LABEL" under the bar, thick karaoke captions mid-frame
 *   classic: left number stack + single highlight word in title
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');

const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');
const ffprobePath = process.env.FFPROBE_PATH || require('ffprobe-static').path;

class RankingAssembler {
    constructor() {
        // On Fly workers, never mkdir under /public (paths resolve outside /app)
        if (process.env.JOB_ID || process.env.JOB_TYPE === 'ranking_assemble') {
            this.tempDir = path.join('/tmp', 'ranking-temp');
            this.outputDir = path.join('/tmp', 'ranking-final');
            this.uploadDir = path.join('/tmp', 'ranking-uploads');
        } else {
            this.tempDir = path.join(__dirname, '../../../public/studio/generated/temp');
            this.outputDir = path.join(__dirname, '../../../public/studio/generated/final');
            this.uploadDir = path.join(__dirname, '../../../public/studio/ranking-uploads');
        }

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
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-threads', '1',
            '-c:a', 'aac', '-b:a', '128k',
            '-avoid_negative_ts', 'make_zero', '-y', outputPath
        ]);
        return outputPath;
    }

    /**
     * Assemble ranking video.
     * clips: [{ path, number, label }] in playback order (highest number first, #1 last)
     * title: { text, highlightWord }
     * options: { layout, commentary, commentaryLines, colorPalette, checkeredMode, subtitleFont, subtitleY, subtitleColor, hookEnabled, overlayStyle, stylePreset }
     */
    async assemble(clips, title, options) {
        var jobId = 'ranking-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        var jobDir = path.join(this.tempDir, jobId);
        fs.mkdirSync(jobDir, { recursive: true });

        var commentary = (options && options.commentary) || [];
        // Flash-montage hook is opt-in only — viral format cold-opens on clip 0
        var hookEnabled = !!(options && options.hookEnabled);
        var overlayStyle = (options && options.overlayStyle)
            || ((options && options.stylePreset === 'viral') ? 'viral' : null)
            || (commentary.length > 0 ? 'viral' : 'classic');
        options = Object.assign({}, options || {}, { overlayStyle: overlayStyle });
        console.log('\n🏆 Ranking assembly: ' + clips.length + ' clips' + (commentary.length > 0 ? ' + ' + commentary.filter(function(c) { return c.audioPath; }).length + ' commentary lines' : '') + (hookEnabled ? ' + hook montage' : '') + ' [' + overlayStyle + ']');

        try {
            // Step 1: Normalize each clip
            console.log('  [Step 1] Normalizing clips...');
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

            // Step 1b: Optional legacy flash-montage hook
            var hookPath = null;
            var hookDuration = 0;
            var introCommentary = commentary.find(function(c) { return c.clipIndex === 0; });
            if (hookEnabled && introCommentary && introCommentary.audioPath && fs.existsSync(introCommentary.audioPath)) {
                console.log('  [Step 1b] Building hook intro...');
                var hookResult = await this._buildHookIntro(normalizedPaths, durations, introCommentary.audioPath, jobDir, options);
                hookPath = hookResult.path;
                hookDuration = hookResult.duration;
                console.log('  ✓ Hook intro: ' + hookDuration.toFixed(1) + 's');
            }

            // Probe TTS durations
            var commentaryDurations = {};
            for (var cd = 0; cd < commentary.length; cd++) {
                var cItem = commentary[cd];
                if (cItem.audioPath && fs.existsSync(cItem.audioPath)) {
                    try {
                        var ttsDur = await this.getDuration(cItem.audioPath);
                        if (ttsDur > 0) commentaryDurations[cItem.clipIndex] = ttsDur;
                    } catch (e) { /* skip */ }
                }
            }

            // Viral white-card beats: before mid clips, VO+karaoke on solid white (Jinxy style)
            var useWhiteCards = overlayStyle === 'viral' && commentary.length > 0 && !hookEnabled;
            var clipOffsets = [];
            var voiceOffsets = {}; // clipIndex → when VO/karaoke starts
            var whiteMeta = {}; // clipIndex → { offset, duration }
            var concatEntries = [];
            if (hookPath) concatEntries.push("file '" + hookPath + "'");

            var cursor = hookDuration;
            for (var i = 0; i < normalizedPaths.length; i++) {
                var isMid = i > 0 && i < normalizedPaths.length - 1;
                var midLine = commentary.find(function(c) { return c.clipIndex === i; });
                var hasMidVo = !!(useWhiteCards && isMid && midLine && midLine.audioPath && fs.existsSync(midLine.audioPath));

                if (hasMidVo) {
                    var wDur = Math.max(1.1, Math.min(4.5, (commentaryDurations[i] || 2) + 0.12));
                    var whitePath = path.join(jobDir, 'white-' + i + '.ts');
                    await this.createWhiteCard(whitePath, wDur);
                    concatEntries.push("file '" + whitePath + "'");
                    voiceOffsets[i] = cursor;
                    whiteMeta[i] = { offset: cursor, duration: wDur };
                    cursor += wDur;
                    console.log('  ✓ White card before clip ' + (i + 1) + ' (' + wDur.toFixed(1) + 's)');
                }

                concatEntries.push("file '" + normalizedPaths[i] + "'");
                clipOffsets[i] = cursor;
                if (!hasMidVo) {
                    // Hook / CTA / no-white: VO sits on the clip itself
                    voiceOffsets[i] = cursor;
                }
                cursor += durations[i];
            }

            // Legacy offsets alias (clip starts) for mix helper
            var offsets = clipOffsets;

            // Step 2: Hard-cut concat
            console.log('  [Step 2] Concatenating...');
            var concatList = path.join(jobDir, 'concat.txt');
            fs.writeFileSync(concatList, concatEntries.join('\n'));
            var concatPath = path.join(jobDir, 'concat.mp4');
            await this.ffmpeg(['-f', 'concat', '-safe', '0', '-i', concatList, '-c', 'copy', '-y', concatPath]);

            // Step 3: Generate ASS overlay
            console.log('  [Step 3] Generating ASS overlay...');
            var assPath = path.join(jobDir, 'overlay.ass');
            this.generateASS(assPath, clips, durations, title, options, hookDuration, commentaryDurations, {
                clipOffsets: clipOffsets,
                voiceOffsets: voiceOffsets,
                whiteMeta: whiteMeta
            });

            // Step 4: Burn subtitles
            console.log('  [Step 4] Burning subtitles...');
            var subtitledPath = path.join(jobDir, 'subtitled.mp4');
            var escapedAss = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

            await this.ffmpeg([
                '-i', concatPath,
                '-vf', 'ass=' + escapedAss,
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-threads', '1',
                '-r', '30',
                '-c:a', 'copy', '-y', subtitledPath
            ]);

            // Step 5: Mix commentary audio at voiceOffsets
            console.log('  [Step 5] Mixing commentary audio...');
            var outputName = 'ranking-' + Date.now() + '.mp4';
            var finalPath = path.join(this.outputDir, outputName);

            var commentaryWithAudio = commentary.filter(function(c) {
                if (hookEnabled && c.clipIndex === 0) return false;
                return c.audioPath && fs.existsSync(c.audioPath);
            });

            if (commentaryWithAudio.length > 0) {
                console.log('  🎙️ Mixing ' + commentaryWithAudio.length + ' commentary audio tracks...');
                await this._mixCommentaryAudio(subtitledPath, commentaryWithAudio, voiceOffsets, durations, finalPath, jobDir, cursor);
            } else {
                fs.copyFileSync(subtitledPath, finalPath);
            }

            var duration = await this.getDuration(finalPath);
            console.log('🏆 Ranking video complete: ' + duration.toFixed(1) + 's');

            return {
                videoUrl: '/studio/generated/final/' + outputName,
                duration: duration,
                clipCount: clips.length,
                hookDuration: hookDuration
            };
        } finally {
            try { if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true }); }
            catch (e) { console.warn('Cleanup:', e.message); }
        }
    }

    /**
     * Build hook intro — rapid-fire cycling through random moments of all clips.
     * Single FFmpeg call using filter_complex: all clips as inputs, trim each, concat video.
     * Intro audio is mixed in, with click SFX at each cut boundary.
     * Output matches normalizeClip format (stereo AAC 128k) for seamless concat.
     */
    async _buildHookIntro(normalizedPaths, durations, introAudioPath, jobDir, options) {
        var introDur = await this.getDuration(introAudioPath);
        if (introDur <= 0) introDur = 3;

        var cutDuration = 0.4;
        var targetDur = introDur + 0.15;
        var numCuts = Math.ceil(targetDur / cutDuration);
        var clipCount = normalizedPaths.length;

        // Load click SFX
        var clickSfxPath = null;
        try {
            var sfxDir = path.join(__dirname, '../../editor/assets/sfx');
            var hookFile = path.join(sfxDir, 'hook.mp3');
            if (fs.existsSync(hookFile)) clickSfxPath = hookFile;
        } catch (e) {}

        // Build the cut list — which clip and where to seek
        var cuts = [];
        for (var i = 0; i < numCuts; i++) {
            var clipIdx = i < clipCount ? i : Math.floor(Math.random() * clipCount);
            var clipDur = durations[clipIdx];
            var maxStart = Math.max(0, clipDur - cutDuration - 0.3);
            var ss = maxStart > 0 ? (Math.random() * maxStart) + 0.1 : 0;
            cuts.push({ clipIdx: clipIdx, ss: ss });
        }

        // Build inputs: all normalized clips + intro audio + (optional) click SFX
        var inputs = [];
        for (var c = 0; c < normalizedPaths.length; c++) {
            inputs.push('-i', normalizedPaths[c]);
        }
        inputs.push('-i', introAudioPath);
        var introIdx = normalizedPaths.length;
        var clickIdx = -1;
        if (clickSfxPath) {
            inputs.push('-i', clickSfxPath);
            clickIdx = introIdx + 1;
        }

        // Build filter_complex
        var filterParts = [];
        var concatVideoInputs = '';

        // Video: trim each cut from its source clip
        for (var j = 0; j < cuts.length; j++) {
            var cut = cuts[j];
            filterParts.push('[' + cut.clipIdx + ':v]trim=start=' + cut.ss.toFixed(2) + ':duration=' + cutDuration.toFixed(2) + ',setpts=PTS-STARTPTS[hv' + j + ']');
            concatVideoInputs += '[hv' + j + ']';
        }
        filterParts.push(concatVideoInputs + 'concat=n=' + cuts.length + ':v=1:a=0[hookv]');

        // Audio: intro TTS (convert to stereo 44100 to match normalized clips)
        filterParts.push('[' + introIdx + ':a]aresample=44100,pan=stereo|c0=c0|c1=c0[introtts]');

        // Click SFX: pad to cutDuration, loop, trim, mix with intro
        if (clickIdx >= 0) {
            var loopCount = Math.max(numCuts - 1, 1);
            filterParts.push('[' + clickIdx + ':a]aresample=44100,apad=whole_dur=' + cutDuration.toFixed(2) + '[clickpad]');
            filterParts.push('[clickpad]aloop=loop=' + loopCount + ':size=' + Math.round(cutDuration * 44100) + '[clickloop]');
            filterParts.push('[clickloop]atrim=0:' + targetDur.toFixed(2) + ',volume=0.4,pan=stereo|c0=c0|c1=c0[clicks]');
            filterParts.push('[introtts][clicks]amix=inputs=2:duration=first:dropout_transition=0[aout]');
        } else {
            filterParts.push('[introtts]acopy[aout]');
        }

        var filterComplex = filterParts.join(';');

        var hookFinalPath = path.join(jobDir, 'hook-final.ts');
        await this.ffmpeg(inputs.concat([
            '-filter_complex', filterComplex,
            '-map', '[hookv]', '-map', '[aout]',
            '-t', targetDur.toFixed(2),
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26',
            '-r', '30',
            '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
            '-shortest', '-f', 'mpegts', '-y', hookFinalPath
        ]));

        var finalDur = await this.getDuration(hookFinalPath);
        console.log('  🎬 Hook: ' + cuts.length + ' cuts, ' + finalDur.toFixed(1) + 's' + (clickIdx >= 0 ? ' + clicks' : ''));
        return { path: hookFinalPath, duration: finalDur };
    }

    /**
     * Solid white 1080x1920 card (mpegts) for viral caption beats.
     */
    async createWhiteCard(outputPath, durationSeconds) {
        var dur = Math.max(0.8, durationSeconds || 2);
        await this.ffmpeg([
            '-f', 'lavfi', '-i', 'color=c=white:s=1080x1920:r=30:d=' + dur.toFixed(3),
            '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
            '-t', dur.toFixed(3),
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-threads', '1',
            '-r', '30', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
            '-f', 'mpegts', '-y', outputPath
        ]);
        return outputPath;
    }

    /**
     * Mix commentary audio tracks into the video at the correct timestamps.
     * offsets may be an array (clip index → time) or map-like object (voiceOffsets).
     */
    async _mixCommentaryAudio(videoPath, commentary, offsets, durations, outputPath, jobDir, totalDurationOverride) {
        var totalDuration = totalDurationOverride;
        if (!(totalDuration > 0)) {
            if (Array.isArray(offsets)) {
                totalDuration = offsets[offsets.length - 1] + durations[durations.length - 1];
            } else {
                totalDuration = 0;
                Object.keys(offsets || {}).forEach(function(k) {
                    var idx = parseInt(k, 10);
                    var start = offsets[k] || 0;
                    var end = start + (durations[idx] || 2) + 1;
                    if (end > totalDuration) totalDuration = end;
                });
                if (!(totalDuration > 0)) totalDuration = 60;
            }
        }

        var inputs = ['-i', videoPath];
        var filterParts = [];
        var commentaryLabels = [];

        for (var i = 0; i < commentary.length; i++) {
            var c = commentary[i];
            var startSec = Array.isArray(offsets)
                ? (offsets[c.clipIndex] || 0)
                : ((offsets && offsets[c.clipIndex] != null) ? offsets[c.clipIndex] : 0);
            var startMs = Math.round(startSec * 1000);
            inputs.push('-i', c.audioPath);
            // Boost VO hard — clip bed often buries TTS
            filterParts.push(
                '[' + (i + 1) + ':a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,' +
                'volume=2.6,alimiter=limit=0.97:level=false,' +
                'adelay=' + startMs + '|' + startMs + ',apad=whole_dur=' + totalDuration.toFixed(2) + '[c' + i + ']'
            );
            commentaryLabels.push('[c' + i + ']');
        }

        var commentaryMix;
        if (commentaryLabels.length === 1) {
            filterParts[filterParts.length - 1] = filterParts[filterParts.length - 1].replace('[c0]', '[cmix]');
            commentaryMix = 'cmix';
        } else {
            filterParts.push(
                commentaryLabels.join('') +
                'amix=inputs=' + commentaryLabels.length + ':duration=longest:normalize=0[cmix]'
            );
            commentaryMix = 'cmix';
        }

        // Aggressive duck of clip audio when VO speaks + keep VO loud (no amix normalize)
        filterParts.push(
            '[0:a]aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.85[bed]'
        );
        filterParts.push(
            '[bed][' + commentaryMix + ']sidechaincompress=threshold=0.012:ratio=18:attack=12:release=220:makeup=1:knee=2:link=average[ducked]'
        );
        filterParts.push(
            '[ducked]volume=0.7[ducked2]'
        );
        filterParts.push(
            '[ducked2][' + commentaryMix + ']amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]'
        );

        var filterComplex = filterParts.join(';');

        var args = inputs.concat([
            '-filter_complex', filterComplex,
            '-map', '0:v', '-map', '[aout]',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
            '-shortest', '-y', outputPath
        ]);

        try {
            await this.ffmpeg(args);
        } catch (err) {
            console.warn('sidechaincompress failed, falling back to hard duck:', err.message);
            // Rebuild a simple loud-VO mix without sidechain
            var simpleParts = [];
            for (var j = 0; j < commentary.length; j++) {
                var cj = commentary[j];
                var ss = Array.isArray(offsets)
                    ? (offsets[cj.clipIndex] || 0)
                    : ((offsets && offsets[cj.clipIndex] != null) ? offsets[cj.clipIndex] : 0);
                var ms = Math.round(ss * 1000);
                simpleParts.push(
                    '[' + (j + 1) + ':a]aresample=44100,volume=2.8,adelay=' + ms + '|' + ms +
                    ',apad=whole_dur=' + totalDuration.toFixed(2) + '[c' + j + ']'
                );
            }
            var labels = commentary.map(function(_, idx) { return '[c' + idx + ']'; });
            if (labels.length === 1) {
                simpleParts[0] = simpleParts[0].replace('[c0]', '[cmix]');
            } else {
                simpleParts.push(labels.join('') + 'amix=inputs=' + labels.length + ':duration=longest:normalize=0[cmix]');
            }
            simpleParts.push('[0:a]volume=0.22[orig]');
            simpleParts.push('[orig][cmix]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]');
            var fallbackArgs = inputs.concat([
                '-filter_complex', simpleParts.join(';'),
                '-map', '0:v', '-map', '[aout]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
                '-shortest', '-y', outputPath
            ]);
            await this.ffmpeg(fallbackArgs);
        }
    }

    /**
     * Multi-color viral title (white / pink / yellow / cyan), optional highlight override.
     */
    formatViralTitleASS(text, highlightWord) {
        var words = String(text || '').trim().split(/\s+/).filter(Boolean);
        if (!words.length) return '';
        var white = '&H00FFFFFF';
        var pink = '&H00B672F4';
        var yellow = '&H0015CCFA';
        var cyan = '&H00EED322';
        var hl = highlightWord ? String(highlightWord).toLowerCase().trim() : '';
        var n = words.length;
        var parts = [];
        for (var i = 0; i < n; i++) {
            var w = words[i];
            var color = yellow;
            if (hl && w.toLowerCase() === hl) {
                color = yellow;
            } else if (i === 0) {
                color = white;
            } else if (i === n - 1 && n > 2) {
                color = cyan;
            } else if (i < Math.ceil(n * 0.4)) {
                color = pink;
            } else {
                color = yellow;
            }
            parts.push('{\\c' + color + '}' + w.toUpperCase());
            // Soft wrap ~ every 3 words for vertical Shorts
            if ((i + 1) % 3 === 0 && i < n - 1) parts.push('\\N');
            else if (i < n - 1) parts.push(' ');
        }
        return parts.join('');
    }

    /**
     * Generate ASS subtitle file with ranking-style overlays.
     */
    generateASS(outputPath, clips, durations, title, options, hookDuration, commentaryDurations, timeline) {
        hookDuration = hookDuration || 0;
        commentaryDurations = commentaryDurations || {};
        timeline = timeline || {};
        var totalClips = clips.length;
        var lo = (options && options.layout) || {};
        var listXPct = lo.listXPercent || 5;
        var titleYPct = lo.titleYPercent || 6;
        var titleFontSize = lo.titleFontSize || 48;
        var numSize = lo.numSize || 50;
        var numActiveSize = numSize + 6;
        var palette = (options && options.colorPalette) || 'yellow';
        var checkered = !!(options && options.checkeredMode);
        var overlayStyle = (options && options.overlayStyle) || 'classic';
        var viral = overlayStyle === 'viral';
        var clipOffsetsTL = timeline.clipOffsets;
        var voiceOffsetsTL = timeline.voiceOffsets || {};
        var whiteMeta = timeline.whiteMeta || {};

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

        var subtitleColorName = (options && options.subtitleColor) || (viral ? 'yellow' : 'yellow');
        var subColorMap = {
            yellow:  '&H0015CCFA',
            cyan:    '&H00EED322',
            green:   '&H0099D334',
            red:     '&H007171F8',
            pink:    '&H00B672F4',
            orange:  '&H003C92FB',
            white:   '&H00FFFFFF'
        };
        var subtitleASS = subColorMap[subtitleColorName] || subColorMap.yellow;

        var listX = Math.round((listXPct / 100) * 1080);
        var titleY = viral ? 70 : Math.round((titleYPct / 100) * 1920);
        if (viral) titleFontSize = Math.max(titleFontSize, 52);

        var offsets;
        if (clipOffsetsTL && clipOffsetsTL.length === durations.length) {
            offsets = clipOffsetsTL.slice();
        } else {
            offsets = [hookDuration];
            for (var i = 0; i < durations.length - 1; i++) {
                offsets.push(offsets[i] + durations[i]);
            }
        }
        var totalDuration = offsets[offsets.length - 1] + durations[durations.length - 1];
        Object.keys(whiteMeta).forEach(function(k) {
            var w = whiteMeta[k];
            if (w && (w.offset + w.duration) > totalDuration) {
                totalDuration = w.offset + w.duration;
            }
        });

        var allNumbers = clips.map(function(c) { return c.number; });
        var sortedNumbers = allNumbers.slice().sort(function(a, b) { return a - b; });

        var rowHeight = lo.lineSpacing || 65;
        var listHeight = sortedNumbers.length * rowHeight;
        var listStartY = Math.max(400, Math.floor(960 - listHeight / 2));

        var numberYMap = {};
        for (var n = 0; n < sortedNumbers.length; n++) {
            numberYMap[sortedNumbers[n]] = listStartY + n * rowHeight;
        }

        var labelX = listX + 80;
        var barHeight = viral ? 210 : 0;
        var rankY = viral ? (barHeight + 36) : 0;

        var ass = '';
        ass += '[Script Info]\n';
        ass += 'ScriptType: v4.00+\n';
        ass += 'PlayResX: 1080\n';
        ass += 'PlayResY: 1920\n';
        ass += 'WrapStyle: 0\n';
        ass += 'ScaledBorderAndShadow: yes\n\n';

        ass += '[V4+ Styles]\n';
        ass += 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n';

        ass += 'Style: TitleBar,Arial,20,&H00000000,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n';
        ass += 'Style: Title,Arial Black,' + titleFontSize + ',&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,' + (viral ? '5' : '4') + ',2,' + (viral ? '8' : '8') + ',20,20,' + titleY + ',1\n';
        ass += 'Style: RankLine,Arial Black,56,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,0,8,40,40,' + rankY + ',1\n';
        ass += 'Style: RankLineYellow,Arial Black,56,&H0015CCFA,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,6,0,8,40,40,' + rankY + ',1\n';

        ass += 'Style: NumDim,Arial,' + numSize + ',&H00888888,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,7,0,0,0,1\n';
        ass += 'Style: NumActive,Arial,' + numActiveSize + ',' + colors.active + ',&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,7,0,0,0,1\n';
        ass += 'Style: NumDone,Arial,' + numSize + ',' + colors.done + ',&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,7,0,0,0,1\n';
        ass += 'Style: NumDoneAlt,Arial,' + numSize + ',' + whiteASS + ',&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,7,0,0,0,1\n';
        ass += 'Style: Label,Arial,32,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,7,0,0,0,1\n';

        var subFont = (options && options.subtitleFont) || (viral ? 'Arial Black' : 'Arial');
        var subYPct = (options && options.subtitleY != null) ? options.subtitleY : (viral ? 50 : 55);
        var subY = Math.round((subYPct / 100) * 1920);
        var subSize = viral ? 68 : 52;
        var subOutline = viral ? 6 : 3;
        // Centered karaoke — Alignment 5 (center). White-card style is larger + heavier stroke.
        ass += 'Style: ComSub,' + subFont + ',' + subSize + ',' + subtitleASS + ',&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,' + subOutline + ',2,5,40,40,0,1\n';
        ass += 'Style: ComSubWhite,' + subFont + ',92,' + subtitleASS + ',&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,8,3,5,40,40,0,1\n';
        // Cyan variant for variety on white cards (every other word can switch via inline override)
        ass += 'Style: ComSubWhiteAlt,' + subFont + ',92,&H00EED322,&H000000FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,8,3,5,40,40,0,1\n';

        ass += '\n[Events]\n';
        ass += 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

        var t0 = this.assTime(0);
        var tEnd = this.assTime(totalDuration);

        // Viral: solid black title bar
        if (viral && barHeight > 0) {
            ass += 'Dialogue: 0,' + t0 + ',' + tEnd + ',TitleBar,,0,0,0,,{\\p1\\bord0\\shad0\\1c&H000000&\\1a&H00&}m 0 0 l 1080 0 1080 ' + barHeight + ' 0 ' + barHeight + '{\\p0}\n';
        }

        // Title
        if (title && title.text) {
            var titleText;
            if (viral) {
                titleText = this.formatViralTitleASS(title.text, title.highlightWord);
                ass += 'Dialogue: 2,' + t0 + ',' + tEnd + ',Title,,0,0,0,,{\\an8\\pos(540,' + titleY + ')\\b1}' + titleText + '\n';
            } else {
                titleText = title.text;
                if (title.highlightWord && titleText.toLowerCase().includes(title.highlightWord.toLowerCase())) {
                    var idx = titleText.toLowerCase().indexOf(title.highlightWord.toLowerCase());
                    var before = titleText.substring(0, idx);
                    var hl = titleText.substring(idx, idx + title.highlightWord.length);
                    var after = titleText.substring(idx + title.highlightWord.length);
                    titleText = before + '{\\c' + colors.hl + '}' + hl + '{\\c&HFFFFFF&}' + after;
                }
                ass += 'Dialogue: 2,' + t0 + ',' + tEnd + ',Title,,0,0,0,,' + titleText + '\n';
            }
        }

        var numberInfo = {};
        for (var c = 0; c < clips.length; c++) {
            numberInfo[clips[c].number] = {
                clipIndex: c, offset: offsets[c], duration: durations[c], label: clips[c].label || ''
            };
        }

        if (viral) {
            // Centered "N. LABEL" only while that clip plays
            for (var vc = 0; vc < clips.length; vc++) {
                var vClip = clips[vc];
                var vStart = offsets[vc];
                var vEnd = offsets[vc] + durations[vc];
                var vLabel = String(vClip.label || '').trim().toUpperCase();
                var rankText = vClip.number + '.' + (vLabel ? (' ' + vLabel) : '');
                var rankStyle = (vc === clips.length - 1) ? 'RankLineYellow' : 'RankLine';
                ass += 'Dialogue: 3,' + this.assTime(vStart) + ',' + this.assTime(vEnd) + ',' + rankStyle + ',,0,0,0,,{\\an8\\pos(540,' + rankY + ')\\fad(120,80)}' + rankText + '\n';
            }
        } else {
            // Classic left stack
            for (var s = 0; s < sortedNumbers.length; s++) {
                var num = sortedNumbers[s];
                var y = numberYMap[num];
                var info = numberInfo[num];
                var clipStart = info.offset;
                var clipEnd = info.offset + info.duration;

                if (clipStart > 0.1) {
                    ass += 'Dialogue: 1,' + t0 + ',' + this.assTime(clipStart) + ',NumDim,,0,0,0,,{\\pos(' + listX + ',' + y + ')}' + num + '.\n';
                }

                ass += 'Dialogue: 3,' + this.assTime(clipStart) + ',' + this.assTime(clipEnd) + ',NumActive,,0,0,0,,{\\pos(' + listX + ',' + y + ')}' + num + '.\n';
                if (info.label) {
                    ass += 'Dialogue: 3,' + this.assTime(clipStart) + ',' + this.assTime(clipEnd) + ',Label,,0,0,0,,{\\pos(' + labelX + ',' + y + ')\\fad(300,0)}' + info.label + '\n';
                }

                if (clipEnd < totalDuration - 0.1) {
                    var rowIdx = sortedNumbers.indexOf(num);
                    var doneStyle = (checkered && rowIdx % 2 === 1) ? 'NumDoneAlt' : 'NumDone';
                    ass += 'Dialogue: 1,' + this.assTime(clipEnd) + ',' + tEnd + ',' + doneStyle + ',,0,0,0,,{\\pos(' + listX + ',' + y + ')}' + num + '.\n';
                    if (info.label) {
                        ass += 'Dialogue: 1,' + this.assTime(clipEnd) + ',' + tEnd + ',Label,,0,0,0,,{\\pos(' + labelX + ',' + y + ')}' + info.label + '\n';
                    }
                }
            }
        }

        // Optional montage hook karaoke (legacy)
        if (hookDuration > 0) {
            var introLine = null;
            var introTimings = null;
            var introTtsDur = commentaryDurations[0] || null;
            var commentaryLines2 = (options && options.commentaryLines) || [];
            for (var il = 0; il < commentaryLines2.length; il++) {
                if (commentaryLines2[il].clipIndex === 0 && commentaryLines2[il].line) {
                    introLine = commentaryLines2[il].line;
                    introTimings = commentaryLines2[il].wordTimings || null;
                    break;
                }
            }
            if (introLine) {
                var hookSpan = (introTtsDur && introTtsDur > 0)
                    ? Math.min(hookDuration, introTtsDur)
                    : hookDuration;
                ass += this.buildKaraokeASS(introLine, introTimings, 0, hookSpan);
            }
        }

        var commentaryLines = (options && options.commentaryLines) || [];
        for (var cl = 0; cl < commentaryLines.length; cl++) {
            var cLine = commentaryLines[cl];
            if (!cLine.line) continue;
            if (hookDuration > 0 && cLine.clipIndex === 0) continue;
            var cInfo = numberInfo[clips[cLine.clipIndex] && clips[cLine.clipIndex].number];
            if (!cInfo) continue;
            var onWhite = !!(whiteMeta[cLine.clipIndex]);
            var cStart = (voiceOffsetsTL[cLine.clipIndex] != null)
                ? voiceOffsetsTL[cLine.clipIndex]
                : cInfo.offset;
            var cLineDur = onWhite
                ? (whiteMeta[cLine.clipIndex].duration || commentaryDurations[cLine.clipIndex] || 2.2)
                : (commentaryDurations[cLine.clipIndex] || Math.min(cInfo.duration, 2.8));
            ass += this.buildKaraokeASS(cLine.line, cLine.wordTimings, cStart, cLineDur, {
                onWhite: onWhite,
                viral: viral
            });
        }

        fs.writeFileSync(outputPath, ass);
        console.log('  ASS overlay generated (' + overlayStyle + ', ' + totalClips + ' clips, ' + totalDuration.toFixed(1) + 's)');
    }

    /**
     * Build ASS karaoke dialogues for a line.
     * Prefer wordTimings [{word,start,end}] relative to 0; else character-weighted over spanDuration.
     */
    buildKaraokeASS(line, wordTimings, baseOffset, spanDuration, opts) {
        var out = '';
        var base = baseOffset || 0;
        var span = Math.max(0.2, spanDuration || 2);
        opts = opts || {};
        var onWhite = !!opts.onWhite;
        var styleMain = onWhite ? 'ComSubWhite' : 'ComSub';
        var styleAlt = onWhite ? 'ComSubWhiteAlt' : 'ComSub';
        // Instant appear — fade-in made captions feel late vs VO
        var pop = onWhite
            ? '{\\an5\\pos(540,1040)\\t(0,70,\\fscx114\\fscy114)\\t(70,120,\\fscx100\\fscy100)}'
            : '{\\an5\\pos(540,1040)}';

        if (wordTimings && wordTimings.length) {
            for (var i = 0; i < wordTimings.length; i++) {
                var wt = wordTimings[i];
                var w = String(wt.word || '').trim();
                if (!w) continue;
                var wStart = base + Math.max(0, wt.start || 0);
                var wEnd = base + Math.max(wStart - base + 0.04, wt.end != null ? wt.end : (wt.start || 0) + 0.12);
                if (wStart > base + span) break;
                // Never overlap the next word (fixes stacked captions)
                for (var ni = i + 1; ni < wordTimings.length; ni++) {
                    var nw = String(wordTimings[ni].word || '').trim();
                    if (!nw) continue;
                    var nextStart = base + Math.max(0, wordTimings[ni].start || 0);
                    wEnd = Math.min(wEnd, nextStart - 0.01);
                    break;
                }
                wEnd = Math.min(wEnd, base + span);
                if (wEnd <= wStart) wEnd = wStart + 0.04;
                var style = (onWhite && i % 3 === 1) ? styleAlt : styleMain;
                out += 'Dialogue: 4,' + this.assTime(wStart) + ',' + this.assTime(wEnd) + ',' + style + ',,0,0,0,,' + pop + w.toUpperCase() + '\n';
            }
            return out;
        }

        var words = String(line || '').replace(/\n/g, ' ').trim().split(/\s+/).filter(Boolean);
        if (!words.length) return out;
        var weights = words.map(function(word) {
            return Math.max(1, word.replace(/[^a-zA-Z0-9']/g, '').length || 1);
        });
        var total = weights.reduce(function(a, b) { return a + b; }, 0);
        var t = 0;
        for (var wi = 0; wi < words.length; wi++) {
            var slice = (weights[wi] / total) * span;
            var ws = base + t;
            var we = ws + slice;
            var st = (onWhite && wi % 3 === 1) ? styleAlt : styleMain;
            out += 'Dialogue: 4,' + this.assTime(ws) + ',' + this.assTime(we) + ',' + st + ',,0,0,0,,' + pop + words[wi].toUpperCase() + '\n';
            t += slice;
        }
        return out;
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
            'pad=1080:1920:0:(oh-ih)/2:black',
            'fps=30'
        ].join(',');
        await this.ffmpeg([
            '-i', inputPath, '-vf', filterStr,
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-threads', '1',
            '-r', '30',
            '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
            '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
            '-f', 'mpegts', '-y', outputPath
        ]);
    }

    async ffmpeg(args) {
        try {
            return await execFileAsync(ffmpegPath, args, { timeout: 600000, maxBuffer: 5 * 1024 * 1024 });
        } catch (error) {
            if (error.code) {
                var fullStderr = error.stderr || '';
                // Extract actual error lines (skip banner/config noise)
                var lines = fullStderr.split('\n');
                var errorLines = lines.filter(function(l) {
                    return l && !l.startsWith('  ') && !l.startsWith('ffmpeg version') && 
                           !l.startsWith('  configuration') && !l.startsWith('  lib') &&
                           !l.startsWith('  built') && !l.includes('Copyright') &&
                           l.trim().length > 0;
                });
                var msg = errorLines.length > 0 ? errorLines.join(' | ').substring(0, 800) : fullStderr.slice(-500);
                console.error('FFmpeg error (code ' + error.code + '):', msg);
                throw new Error('FFmpeg failed (code ' + error.code + '): ' + msg.substring(0, 500));
            }
            return { stdout: error.stdout, stderr: error.stderr };
        }
    }
}

module.exports = RankingAssembler;
