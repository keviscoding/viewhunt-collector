/**
 * Video Editor — Assembles final video from scene clips using FFmpeg.
 * Optimized for 256MB containers (basic-xxs DigitalOcean).
 * 
 * Strategy: Process ONE clip at a time to avoid OOM.
 *   1. Download all clips
 *   2. Re-encode each clip individually to normalized .ts files
 *   3. Concat all .ts files with -c copy (near-zero memory)
 *   4. Mix voiceover + SFX onto the concat result
 * 
 * Timing: Hybrid approach —
 *   Primary: Gemini analyzes the voiceover audio to find real timestamps
 *   for each scriptLine → scene switches land exactly on the narration.
 *   Fallback: Proportional timing based on scriptLine character length.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const { loadAllSfx } = require('./sfx-store');

// Regex to detect time markers in sentences
var TIME_MARKER_RE = /\b(second|minute|hour|day|week|month|year)\s+\w+|\b\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)/i;

class VideoEditor {
    constructor() {
        this.tempDir = path.join(__dirname, '../../public/studio/generated/temp');
        this.outputDir = path.join(__dirname, '../../public/studio/generated/final');

        for (var dir of [this.tempDir, this.outputDir]) {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        }

        this.sfx = { hook: null, transition: null, riser: null, bgmusic: null };
    }

    async loadSfx() {
        this.sfx = await loadAllSfx();
    }

    /**
     * Main assembly entry point
     */
    async assemble(edl, scenes, voiceoverPath) {
        var jobId = 'edit-' + Date.now();
        var jobDir = path.join(this.tempDir, jobId);
        fs.mkdirSync(jobDir, { recursive: true });

        console.log('\n🎬 Video Editor: Starting assembly (job: ' + jobId + ')');

        try {
            await this.loadSfx();

            console.log('📥 Step 1: Downloading scene clips...');
            var clipPaths = await this.downloadClips(scenes, jobDir);

            var voiceDuration = await this.getMediaDuration(voiceoverPath);
            console.log('🎙️ Voiceover duration: ' + voiceDuration.toFixed(1) + 's');

            console.log('📋 Step 2: Building edit list...');
            var editList = this.buildEditList(edl, clipPaths, voiceDuration);
            console.log('  ' + editList.length + ' clips in sequence');

            console.log('🎬 Step 3: Normalizing clips one-by-one...');
            var concatPath = await this.sequentialAssemble(editList, jobDir);

            console.log('🔊 Step 4: Mixing audio + overlays...');
            var finalPath = path.join(this.outputDir, jobId + '.mp4');
            await this.mixFinalAudio(concatPath, voiceoverPath, editList, finalPath, jobDir, edl);

            var finalSize = 0;
            try { finalSize = fs.statSync(finalPath).size; } catch(e) {}
            if (finalSize < 1000) {
                throw new Error('Output file too small (' + finalSize + ' bytes) — likely corrupt');
            }

            var finalDuration = await this.getMediaDuration(finalPath);
            this.cleanup(jobDir);

            var videoUrl = '/studio/generated/final/' + jobId + '.mp4';
            console.log('\n✅ Final video: ' + videoUrl + ' (' + finalDuration.toFixed(1) + 's, ' + (finalSize / 1024).toFixed(0) + 'KB)\n');

            return { videoPath: finalPath, videoUrl: videoUrl, duration: finalDuration };

        } catch (error) {
            console.error('Video assembly error:', error.message);
            this.cleanup(jobDir);
            throw error;
        }
    }

    /**
     * Build edit list — hybrid approach:
     *   1. Hook clips from Gemini (rapid-fire teaser)
     *   2. Body segments from Claude's scriptLine mapping
     *   3. Timing from Gemini voiceover analysis (real timestamps)
     *      OR proportional fallback if analysis unavailable
     * 
     * Scene 1 (hook line) is already excluded from edl.body by the analyzer.
     */
    buildEditList(edl, clipPaths, voiceDuration) {
        var clips = [];
        var currentTime = 0;

        // Hook clips first
        if (edl.hook && edl.hook.clips) {
            for (var i = 0; i < edl.hook.clips.length; i++) {
                var hc = edl.hook.clips[i];
                var src = clipPaths[hc.scene];
                if (!src) continue;
                var dur = hc.duration || 0.5;
                clips.push({
                    src: src, ss: hc.startSec || 0, duration: dur,
                    type: 'hook', startAt: currentTime
                });
                currentTime += dur;
            }
        }

        var hookDur = currentTime;

        // Choose timing strategy
        if (edl.timestamps && edl.timestamps.length > 0) {
            console.log('  ⏱️ Using voiceover-analyzed timestamps');
            clips = clips.concat(this.buildBodyFromTimestamps(edl, clipPaths, hookDur, voiceDuration));
        } else {
            console.log('  📏 Using proportional timing (fallback)');
            clips = clips.concat(this.buildBodyProportional(edl, clipPaths, hookDur, voiceDuration));
        }

        // SAFETY: Ensure total clip duration covers the voiceover.
        // If the edit list is shorter than the voiceover, extend the last body
        // segment so the looping system fills the gap. This prevents the video
        // from running out of clips before the narration ends.
        if (clips.length > 0) {
            var lastClip = clips[clips.length - 1];
            var totalEditDur = lastClip.startAt + lastClip.duration;
            var shortfall = voiceDuration - totalEditDur;

            if (shortfall > 0.5) {
                console.log('  ⚠️ Edit list (' + totalEditDur.toFixed(1) + 's) shorter than voiceover (' +
                    voiceDuration.toFixed(1) + 's) — extending last segment by ' + shortfall.toFixed(1) + 's');
                lastClip.duration += shortfall + 0.5; // +0.5s buffer
            }
        }

        return clips;
    }

    /**
     * Body segments with real timestamps from Gemini voiceover analysis.
     * Each timestamp tells us when that scriptLine starts in the audio.
     * Duration = next timestamp - this timestamp (last segment fills to end).
     * 
     * Always starts clips from ss=0 so the full 5s clip is available.
     * The looping system in sequentialAssemble handles segments > 5s.
     */
    buildBodyFromTimestamps(edl, clipPaths, hookDur, voiceDuration) {
        var clips = [];
        var ts = edl.timestamps;

        for (var k = 0; k < edl.body.length; k++) {
            var seg = edl.body[k];
            var bodySrc = clipPaths[seg.scene];
            if (!bodySrc) continue;

            // Find matching timestamp for this segment
            var tsEntry = null;
            var tIdx = -1;
            for (var t = 0; t < ts.length; t++) {
                if (ts[t].scene === seg.scene || ts[t].index === k + 1) {
                    tsEntry = ts[t]; tIdx = t; break;
                }
            }

            var startAt, segDur;
            if (tsEntry) {
                startAt = hookDur + tsEntry.startSec;

                // Duration = time until next timestamp (or end of voiceover)
                var nextStart = voiceDuration;
                for (var n = tIdx + 1; n < ts.length; n++) {
                    if (typeof ts[n].startSec === 'number') {
                        nextStart = hookDur + ts[n].startSec;
                        break;
                    }
                }
                segDur = nextStart - startAt;
            } else {
                var prevClip = clips.length > 0 ? clips[clips.length - 1] : null;
                startAt = prevClip ? prevClip.startAt + prevClip.duration : hookDur;
                segDur = 5;
            }

            // Min 2s, NO max cap — let looping handle long segments
            segDur = Math.max(2, segDur);

            var scriptLine = seg.scriptLine || '';
            var hasTimeMarker = TIME_MARKER_RE.test(scriptLine);

            clips.push({
                src: bodySrc, ss: 0, duration: segDur,
                type: 'body', startAt: startAt,
                hasTimeMarker: hasTimeMarker,
                sentence: scriptLine.substring(0, 60)
            });
        }

        return clips;
    }

    /**
     * Fallback: proportional timing based on scriptLine character length.
     * Always starts clips from ss=0, looping handles overflow.
     */
    buildBodyProportional(edl, clipPaths, hookDur, voiceDuration) {
        var clips = [];
        var currentTime = hookDur;
        var bodyTime = Math.max(voiceDuration - hookDur, 10);

        var totalChars = 0;
        for (var b = 0; b < edl.body.length; b++) {
            totalChars += Math.max((edl.body[b].scriptLine || '').length, 5);
        }

        for (var k = 0; k < edl.body.length; k++) {
            var seg = edl.body[k];
            var bodySrc = clipPaths[seg.scene];
            if (!bodySrc) continue;

            var scriptLine = seg.scriptLine || '';
            var charLen = Math.max(scriptLine.length, 5);
            var segDur = (charLen / totalChars) * bodyTime;
            segDur = Math.max(2, segDur); // no max cap, looping handles it

            var hasTimeMarker = TIME_MARKER_RE.test(scriptLine);

            clips.push({
                src: bodySrc, ss: 0, duration: segDur,
                type: 'body', startAt: currentTime,
                hasTimeMarker: hasTimeMarker,
                sentence: scriptLine.substring(0, 60)
            });
            currentTime += segDur;
        }

        return clips;
    }

    /**
     * Sequential assembly: normalize each clip one at a time, then concat.
     * 
     * CLIP LOOPING: When a segment needs more time than the clip provides,
     * we loop it — play through to the end, then jump back to the midpoint
     * and replay from there, filling the needed duration seamlessly.
     * 
     * After encoding, we verify the actual output duration. If FFmpeg produced
     * less than requested (clip was shorter than reported), we loop to fill.
     */
    async sequentialAssemble(editList, jobDir) {
        var tsFiles = [];
        var clipDurationCache = {};

        for (var i = 0; i < editList.length; i++) {
            var clip = editList[i];
            var hasAudio = await this.hasAudioStream(clip.src);

            // Get actual clip duration (cache since same clip may be reused)
            if (!clipDurationCache[clip.src]) {
                clipDurationCache[clip.src] = await this.getMediaDuration(clip.src);
            }
            var clipLen = clipDurationCache[clip.src] || 5;

            // How much clip is available from the start offset
            var availableFromSs = Math.max(clipLen - clip.ss, 0.5);

            // Always try single pass first, then verify duration
            var tsPath = path.join(jobDir, 'seg-' + i + '.ts');
            var needsLoop = false;

            if (clip.duration <= availableFromSs - 0.1) {
                // Clip should be long enough — single pass
                await this.encodeSegment(clip.src, clip.ss, clip.duration, hasAudio, tsPath);
                var segSize = 0;
                try { segSize = fs.statSync(tsPath).size; } catch(e) {}
                if (segSize < 100) {
                    console.warn('  ⚠️ Segment ' + i + ' too small, skipping');
                    continue;
                }

                // Verify actual duration — if FFmpeg gave us less, we need to loop
                var actualDur = await this.getMediaDuration(tsPath);
                if (actualDur > 0 && actualDur < clip.duration - 0.5) {
                    console.log('  ⚠️ Seg ' + i + ': requested ' + clip.duration.toFixed(1) + 's but got ' + actualDur.toFixed(1) + 's — switching to loop');
                    needsLoop = true;
                    try { fs.unlinkSync(tsPath); } catch(e) {}
                }

                if (!needsLoop) {
                    tsFiles.push(tsPath);
                }
            } else {
                needsLoop = true;
            }

            if (needsLoop) {
                // Clip too short for this segment — loop it
                var remaining = clip.duration;
                var loopIdx = 0;
                var midpoint = clipLen * 0.5; // loop-back point
                var partFiles = [];

                // First pass: play from ss to end of clip
                var firstDur = Math.min(remaining, availableFromSs);
                var partPath = path.join(jobDir, 'seg-' + i + '-p' + loopIdx + '.ts');
                await this.encodeSegment(clip.src, clip.ss, firstDur, hasAudio, partPath);
                var pSize = 0;
                try { pSize = fs.statSync(partPath).size; } catch(e) {}
                if (pSize >= 100) {
                    // Check actual duration of this part
                    var partActual = await this.getMediaDuration(partPath);
                    if (partActual > 0) {
                        partFiles.push(partPath);
                        remaining -= partActual; // use ACTUAL duration, not requested
                    }
                }
                loopIdx++;

                // Loop: jump back to midpoint, play to end, repeat
                while (remaining > 0.3) {
                    var loopAvail = clipLen - midpoint;
                    var loopDur = Math.min(remaining, loopAvail);
                    partPath = path.join(jobDir, 'seg-' + i + '-p' + loopIdx + '.ts');
                    await this.encodeSegment(clip.src, midpoint, loopDur, hasAudio, partPath);
                    pSize = 0;
                    try { pSize = fs.statSync(partPath).size; } catch(e) {}
                    if (pSize >= 100) {
                        var loopActual = await this.getMediaDuration(partPath);
                        if (loopActual > 0) {
                            partFiles.push(partPath);
                            remaining -= loopActual;
                        } else break;
                    }
                    else break;
                    loopIdx++;
                    if (loopIdx > 10) break; // safety
                }

                if (partFiles.length > 0) {
                    var loopedPath = path.join(jobDir, 'seg-' + i + '.ts');
                    if (partFiles.length === 1) {
                        fs.renameSync(partFiles[0], loopedPath);
                    } else {
                        await this.ffmpeg([
                            '-i', 'concat:' + partFiles.join('|'),
                            '-c', 'copy', '-f', 'mpegts',
                            '-y', loopedPath
                        ]);
                        for (var p = 0; p < partFiles.length; p++) {
                            try { fs.unlinkSync(partFiles[p]); } catch(e) {}
                        }
                    }
                    tsFiles.push(loopedPath);
                } else {
                    console.warn('  ⚠️ Segment ' + i + ' loop failed, skipping');
                    continue;
                }
            }

            var tag = hasAudio ? '🔊' : '🔇';
            var loopTag = needsLoop ? ' 🔄loop(' + availableFromSs.toFixed(1) + 's avail, ' + clip.duration.toFixed(1) + 's needed)' : '';
            var info = clip.sentence ? ' "' + clip.sentence + '"' : '';
            console.log('  ✓ Seg ' + i + '/' + (editList.length - 1) + ' (' + clip.type + ', ' + clip.duration.toFixed(1) + 's) ' + tag + loopTag + info);
        }

        if (tsFiles.length === 0) throw new Error('No valid segments produced');

        var concatPath = path.join(jobDir, 'concat.mp4');
        await this.ffmpeg([
            '-i', 'concat:' + tsFiles.join('|'),
            '-c', 'copy', '-movflags', '+faststart',
            '-y', concatPath
        ]);

        console.log('  ✅ Concat complete: ' + tsFiles.length + ' segments');
        return concatPath;
    }

    /**
     * Encode a single segment of a clip to .ts format.
     * Shared by both single-pass and looping paths.
     */
    async encodeSegment(src, ss, duration, hasAudio, outputPath) {
        var args;
        if (hasAudio) {
            args = [
                '-ss', String(ss),
                '-t', String(duration),
                '-i', src,
                '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1',
                '-af', 'volume=0.45',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
                '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-b:a', '64k', '-ar', '44100', '-ac', '2',
                '-f', 'mpegts',
                '-y', outputPath
            ];
        } else {
            args = [
                '-ss', String(ss),
                '-t', String(duration),
                '-i', src,
                '-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=44100:cl=stereo',
                '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
                '-pix_fmt', 'yuv420p',
                '-map', '0:v', '-map', '1:a',
                '-c:a', 'aac', '-b:a', '64k', '-shortest',
                '-f', 'mpegts',
                '-y', outputPath
            ];
        }
        await this.ffmpeg(args);
    }

    async hasAudioStream(filePath) {
        try {
            var r = await execFileAsync(ffprobePath, [
                '-v', 'quiet', '-select_streams', 'a',
                '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', filePath
            ]);
            return r.stdout.trim().length > 0;
        } catch (err) { return false; }
    }

    /**
     * Mix final audio: voiceover + clip audio + SFX + background music.
     * Also burns in text overlays:
     *   - Word-by-word captions at the bottom (from Gemini word timestamps)
     *   - Time marker titles at the top (Day 1, Hour 1, etc.) with 3s fade-out
     * 
     * Two-pass approach for memory efficiency on 256MB:
     *   Pass 1: Mix all audio tracks (voiceover + clip + SFX + bgmusic) with -c:v copy
     *   Pass 2: Burn in text overlays via ASS subtitles (re-encode video)
     * If no overlays, only pass 1 runs.
     * 
     * Volume strategy: use amix with normalize=0 to prevent auto-normalization,
     * then set each input's volume explicitly.
     */
    async mixFinalAudio(concatVideoPath, voiceoverPath, editList, outputPath, jobDir, edl) {
        var sfxEvents = this.buildSfxTimeline(editList);
        var hasBgMusic = this.sfx.bgmusic && fs.existsSync(this.sfx.bgmusic);

        // Build SFX track if needed
        var sfxMixPath = null;
        if (sfxEvents.length > 0) {
            sfxMixPath = path.join(jobDir, 'sfx-mix.wav');
            await this.buildSfxTrack(sfxEvents, editList, sfxMixPath, jobDir);
            if (!fs.existsSync(sfxMixPath) || fs.statSync(sfxMixPath).size < 100) {
                sfxMixPath = null;
            }
        }

        // Build the filter_complex dynamically based on available inputs
        var inputs = ['-i', concatVideoPath, '-i', voiceoverPath];
        var filterParts = [];
        var mixLabels = [];
        var inputIdx = 0;

        // [0] = concat video (clip audio)
        filterParts.push('[0:a]volume=0.45[clip]');
        mixLabels.push('[clip]');
        inputIdx = 2;

        // [1] = voiceover
        filterParts.push('[1:a]volume=1.0[vo]');
        mixLabels.push('[vo]');

        // SFX track
        if (sfxMixPath) {
            inputs.push('-i', sfxMixPath);
            filterParts.push('[' + inputIdx + ':a]volume=3.0[sfx]');
            mixLabels.push('[sfx]');
            inputIdx++;
        }

        // Background music — loop it for the full video duration
        if (hasBgMusic) {
            var concatDur = await this.getMediaDuration(concatVideoPath);
            inputs.push('-stream_loop', '-1', '-i', this.sfx.bgmusic);
            filterParts.push('[' + inputIdx + ':a]volume=0.12,afade=t=in:st=0:d=2,afade=t=out:st=' +
                Math.max(concatDur - 3, 0).toFixed(1) + ':d=3[bgm]');
            mixLabels.push('[bgm]');
            inputIdx++;
            console.log('  🎵 Background music: looped, volume=0.12, fade in/out');
        }

        var numInputs = mixLabels.length;
        var amixFilter = mixLabels.join('') + 'amix=inputs=' + numInputs +
            ':duration=shortest:dropout_transition=2:normalize=0[aout]';
        filterParts.push(amixFilter);

        var logParts = ['clip audio'];
        if (sfxMixPath) logParts.push(sfxEvents.length + ' SFX');
        if (hasBgMusic) logParts.push('bg music');
        console.log('  Pass 1 — audio mix: voiceover + ' + logParts.join(' + '));

        // Check if we have text overlays
        var assPath = this.buildAssSubtitles(editList, edl, jobDir);
        var hasOverlays = assPath !== null;

        if (hasOverlays) {
            // Two-pass: first mix audio, then burn subtitles
            var audioMixPath = path.join(jobDir, 'audio-mixed.mp4');

            // Pass 1: audio mix only (fast, -c:v copy)
            var pass1Args = inputs.concat([
                '-filter_complex', filterParts.join(';'),
                '-map', '0:v', '-map', '[aout]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
                '-movflags', '+faststart', '-y', audioMixPath
            ]);
            await this.ffmpeg(pass1Args);

            // Pass 2: burn in ASS subtitles (re-encode video)
            // Escape the path for FFmpeg's subtitle filter (colons and backslashes)
            var escapedAssPath = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");
            console.log('  Pass 2 — burning text overlays via ASS subtitles');

            var pass2Args = [
                '-i', audioMixPath,
                '-vf', 'ass=' + escapedAssPath,
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
                '-c:a', 'copy',
                '-movflags', '+faststart', '-y', outputPath
            ];
            await this.ffmpeg(pass2Args);

        } else {
            // Single pass: audio mix only, no overlays
            var args = inputs.concat([
                '-filter_complex', filterParts.join(';'),
                '-map', '0:v', '-map', '[aout]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
                '-movflags', '+faststart', '-y', outputPath
            ]);
            await this.ffmpeg(args);
        }
    }

    /**
     * Build an ASS (Advanced SubStation Alpha) subtitle file for text overlays.
     * Much more efficient than chaining 100+ drawtext filters.
     * 
     * Contains two styles:
     *   - "Caption" — word-by-word at the bottom, white bold, black outline
     *   - "TimeTitle" — time markers at the top, white bold, fades out
     * 
     * Returns the file path, or null if no overlays.
     */
    buildAssSubtitles(editList, edl, jobDir) {
        var captionEvents = [];
        var titleEvents = [];

        // 1. Word-by-word captions
        if (edl && edl.wordTimestamps && edl.wordTimestamps.length > 0) {
            var words = edl.wordTimestamps;
            console.log('  📝 Captions: ' + words.length + ' words');

            for (var w = 0; w < words.length; w++) {
                var word = words[w];
                if (!word.word || typeof word.startSec !== 'number') continue;

                var cleanWord = word.word.replace(/[^a-zA-Z0-9 ]/g, '').trim().toUpperCase();
                if (!cleanWord) continue;

                // Subtract 0.3s to compensate for slight caption delay
                var wStart = Math.max(word.startSec - 0.3, 0);
                var wEnd = (typeof word.endSec === 'number') ? Math.max(word.endSec - 0.3, wStart + 0.1) : wStart + 0.3;

                captionEvents.push({
                    start: this.secsToAssTime(wStart),
                    end: this.secsToAssTime(wEnd),
                    text: cleanWord
                });
            }
        }

        // 2. Time marker titles at the top
        for (var i = 0; i < editList.length; i++) {
            var clip = editList[i];
            if (clip.type === 'body' && clip.hasTimeMarker && clip.sentence) {
                var markerText = this.extractTimeMarkerText(clip.sentence);
                if (markerText) {
                    var tStart = clip.startAt;
                    titleEvents.push({
                        start: this.secsToAssTime(tStart),
                        end: this.secsToAssTime(tStart + 3),
                        text: markerText.toUpperCase(),
                        // Fade: 0ms fade-in, 2000ms fade-out (last 2s of the 3s display)
                        fade: '\\fad(0,2000)'
                    });
                }
            }
        }

        if (captionEvents.length === 0 && titleEvents.length === 0) return null;

        if (titleEvents.length > 0) {
            console.log('  🏷️ Time titles: ' + titleEvents.map(function(t) {
                return '"' + t.text + '"@' + t.start;
            }).join(', '));
        }

        // Build ASS file content
        // PlayResX/PlayResY match our 1080x1920 vertical video
        // ASS colors are in &HAABBGGRR format (hex, reversed BGR)
        // White = &H00FFFFFF, Yellow = &H0000FFFF (BGR: 00,FF,FF = yellow)
        var ass = '[Script Info]\n' +
            'ScriptType: v4.00+\n' +
            'PlayResX: 1080\n' +
            'PlayResY: 1920\n' +
            'WrapStyle: 0\n' +
            '\n' +
            '[V4+ Styles]\n' +
            'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
            'Style: Caption,Arial,72,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,0,2,40,40,280,1\n' +
            'Style: TimeTitle,Arial,64,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,0,8,40,40,180,1\n' +
            '\n' +
            '[Events]\n' +
            'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

        // Caption events (bottom, Alignment 2 = bottom-center)
        for (var c = 0; c < captionEvents.length; c++) {
            var ce = captionEvents[c];
            ass += 'Dialogue: 0,' + ce.start + ',' + ce.end + ',Caption,,0,0,0,,' + ce.text + '\n';
        }

        // Time title events (top, Alignment 8 = top-center, with fade)
        for (var t = 0; t < titleEvents.length; t++) {
            var te = titleEvents[t];
            ass += 'Dialogue: 1,' + te.start + ',' + te.end + ',TimeTitle,,0,0,0,,{' + te.fade + '}' + te.text + '\n';
        }

        var assFilePath = path.join(jobDir, 'overlays.ass');
        fs.writeFileSync(assFilePath, ass);
        console.log('  📄 ASS subtitle file: ' + captionEvents.length + ' captions + ' + titleEvents.length + ' titles');

        return assFilePath;
    }

    /**
     * Convert seconds to ASS timestamp format: H:MM:SS.CC
     */
    secsToAssTime(secs) {
        var h = Math.floor(secs / 3600);
        var m = Math.floor((secs % 3600) / 60);
        var s = Math.floor(secs % 60);
        var cs = Math.round((secs % 1) * 100);
        if (cs >= 100) { cs = 0; s++; }
        return h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + '.' + (cs < 10 ? '0' : '') + cs;
    }

    /**
     * Extract time marker text from a sentence.
     * E.g. "Day one. The planet is tearing..." → "DAY ONE"
     *       "Minute 1. Your eyes start..." → "MINUTE 1"
     *       "Hour 12. Everything changes..." → "HOUR 12"
     */
    extractTimeMarkerText(sentence) {
        // Match patterns like "Day 1", "Week one", "Hour 12", "Month 6", "Year 2", "Second 30", "Minute 1"
        var patterns = [
            /\b((?:second|minute|hour|day|week|month|year)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+))/i,
            /\b(\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?))/i
        ];

        for (var p = 0; p < patterns.length; p++) {
            var match = sentence.match(patterns[p]);
            if (match) return match[1].toUpperCase();
        }
        return null;
    }

    /**
     * Build SFX timeline.
     * - hook.mp3 on every hook clip
     * - riser.mp3 before first body clip
     * - transition.mp3 ONLY on time-marker sentences (Day 1, Hour 1, etc.)
     *   → fires at exact clip.startAt (same timestamp as the scene change)
     */
    buildSfxTimeline(editList) {
        var events = [];
        var lastType = null;

        for (var i = 0; i < editList.length; i++) {
            var clip = editList[i];

            if (clip.type === 'hook' && this.sfx.hook) {
                events.push({ time: clip.startAt, sfx: this.sfx.hook, label: 'hook' });
            }

            if (clip.type === 'body' && lastType === 'hook' && this.sfx.riser) {
                events.push({ time: Math.max(clip.startAt - 0.5, 0), sfx: this.sfx.riser, label: 'riser' });
            }

            if (clip.type === 'body' && clip.hasTimeMarker && this.sfx.transition) {
                // Transition SFX — subtract 2.5s to compensate for consistent delay
                events.push({ time: Math.max(clip.startAt - 2.5, 0), sfx: this.sfx.transition, label: 'transition' });
            }

            lastType = clip.type;
        }

        if (events.length > 0) {
            console.log('  🔊 SFX: ' + events.map(function(e) { return e.label + '@' + e.time.toFixed(1) + 's'; }).join(', '));
        }
        return events;
    }

    /**
     * Build SFX audio track with events placed at timestamps using adelay.
     */
    async buildSfxTrack(sfxEvents, editList, outputPath, jobDir) {
        if (sfxEvents.length === 0) return;

        var lastClip = editList[editList.length - 1];
        var totalDuration = lastClip.startAt + lastClip.duration;

        var inputs = [];
        var filterParts = [];
        var mixInputs = [];

        for (var i = 0; i < sfxEvents.length; i++) {
            var ev = sfxEvents[i];
            inputs.push('-i', ev.sfx);
            var delayMs = Math.round(ev.time * 1000);
            filterParts.push('[' + i + ':a]adelay=' + delayMs + '|' + delayMs + ',apad=whole_dur=' + totalDuration.toFixed(2) + '[s' + i + ']');
            mixInputs.push('[s' + i + ']');
        }

        if (sfxEvents.length === 1) {
            filterParts.push(mixInputs[0] + 'acopy[sfxout]');
        } else {
            filterParts.push(mixInputs.join('') + 'amix=inputs=' + sfxEvents.length + ':duration=longest[sfxout]');
        }

        var args = inputs.concat([
            '-filter_complex', filterParts.join(';'),
            '-map', '[sfxout]',
            '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2',
            '-t', String(totalDuration.toFixed(2)),
            '-y', outputPath
        ]);

        try {
            await this.ffmpeg(args);
        } catch (err) {
            console.warn('  ⚠️ SFX track build failed: ' + err.message);
        }
    }

    async downloadClips(scenes, jobDir) {
        var clipPaths = {};
        var downloads = scenes
            .filter(function(s) { return s.videoUrl || s._videoUrl; })
            .map(async function(scene) {
                var num = scene.sceneNumber;
                var url = scene.videoUrl || scene._videoUrl;
                var clipPath = path.join(jobDir, 'scene-' + num + '.mp4');
                try {
                    if (url.startsWith('/') || url.startsWith('./')) {
                        fs.copyFileSync(path.join(__dirname, '../../public', url), clipPath);
                    } else {
                        var resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
                        fs.writeFileSync(clipPath, resp.data);
                    }
                    clipPaths[num] = clipPath;
                    console.log('  ✓ Scene ' + num);
                } catch (err) {
                    console.warn('  ✗ Scene ' + num + ': ' + err.message);
                }
            }.bind(this));
        await Promise.all(downloads);
        console.log('  ' + Object.keys(clipPaths).length + '/' + scenes.length + ' clips ready');
        return clipPaths;
    }

    async getMediaDuration(filePath) {
        try {
            var r = await execFileAsync(ffprobePath, [
                '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath
            ]);
            return parseFloat(r.stdout.trim()) || 0;
        } catch (err) {
            console.warn('Could not get duration: ' + err.message);
            return 0;
        }
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

    cleanup(jobDir) {
        try {
            if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
        } catch (err) { console.warn('Cleanup:', err.message); }
    }
}

module.exports = VideoEditor;
