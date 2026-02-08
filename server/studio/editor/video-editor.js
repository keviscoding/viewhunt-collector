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
            var concatPath = await this.sequentialAssemble(editList, jobDir, voiceDuration);

            console.log('🔊 Step 4: Mixing audio + overlays...');
            var finalPath = path.join(this.outputDir, jobId + '.mp4');
            await this.mixFinalAudio(concatPath, voiceoverPath, editList, finalPath, jobDir, edl);

            // Step 5: Trim ending — video ends 1s after voiceover finishes
            var maxDuration = voiceDuration + 1.0;
            var preTrimDur = await this.getMediaDuration(finalPath);
            if (preTrimDur > maxDuration + 0.5) {
                console.log('✂️ Trimming: ' + preTrimDur.toFixed(1) + 's → ' + maxDuration.toFixed(1) + 's (voiceover + 1s)');
                var trimmedPath = path.join(jobDir, 'trimmed.mp4');
                await this.ffmpeg([
                    '-i', finalPath,
                    '-t', String(maxDuration.toFixed(2)),
                    '-c', 'copy', '-movflags', '+faststart',
                    '-y', trimmedPath
                ]);
                fs.unlinkSync(finalPath);
                fs.renameSync(trimmedPath, finalPath);
            }

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
     * 
     * Word timestamps from transcription are ABSOLUTE — they represent
     * seconds from the start of the voiceover audio, which plays from
     * the start of the video (time 0). So we do NOT add hookDur.
     * 
     * Each scene starts when the voiceover starts saying that line.
     * Each scene ends when the voiceover starts saying the NEXT line.
     * The clip loops if it runs out before the voiceover finishes that line.
     * The clip gets cut short if the voiceover finishes before the clip ends.
     * 
     * This is STRICT per-line timing — no smoothing, no spreading.
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
                // Timestamps are absolute (from start of voiceover = start of video)
                startAt = tsEntry.startSec;

                // Duration = time until next scene's first word (or end of voiceover)
                var nextStart = voiceDuration;
                for (var n = tIdx + 1; n < ts.length; n++) {
                    if (typeof ts[n].startSec === 'number') {
                        nextStart = ts[n].startSec;
                        break;
                    }
                }
                segDur = nextStart - startAt;
            } else {
                // No timestamp match — place after previous clip
                var prevClip = clips.length > 0 ? clips[clips.length - 1] : null;
                startAt = prevClip ? prevClip.startAt + prevClip.duration : hookDur;
                segDur = 5;
            }

            // Min 1s, NO max cap — looping handles long segments
            segDur = Math.max(1, segDur);

            // Guard: first body clip can't start before hook clips end
            if (clips.length === 0 && startAt < hookDur) {
                segDur = segDur - (hookDur - startAt);
                startAt = hookDur;
                segDur = Math.max(1, segDur);
            }

            var scriptLine = seg.scriptLine || '';
            var hasTimeMarker = TIME_MARKER_RE.test(scriptLine);

            clips.push({
                src: bodySrc, ss: 0, duration: segDur,
                type: 'body', startAt: startAt,
                hasTimeMarker: hasTimeMarker,
                sceneNum: seg.scene,
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
                sceneNum: seg.scene,
                sentence: scriptLine.substring(0, 60)
            });
            currentTime += segDur;
        }

        return clips;
    }

    /**
     * Sequential assembly: normalize each clip one at a time, then concat.
     * 
     * EVERY body segment uses the loop strategy to guarantee exact duration:
     *   1. Encode from ss to end of clip (or requested duration, whichever is shorter)
     *   2. If more time needed, jump back to midpoint and replay
     *   3. Repeat until the full requested duration is filled
     * 
     * This ensures we NEVER run out of clip content — each segment is
     * exactly as long as the voiceover needs it to be.
     */
    async sequentialAssemble(editList, jobDir, voiceDuration) {
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
            var availableFromSs = Math.max(clipLen - clip.ss, 0.5);

            // Hook clips are short (0.4-0.5s) — always single pass
            if (clip.type === 'hook') {
                var tsPath = path.join(jobDir, 'seg-' + i + '.ts');
                await this.encodeSegment(clip.src, clip.ss, clip.duration, hasAudio, tsPath);
                var segSize = 0;
                try { segSize = fs.statSync(tsPath).size; } catch(e) {}
                if (segSize >= 100) {
                    tsFiles.push(tsPath);
                } else {
                    console.warn('  ⚠️ Segment ' + i + ' too small, skipping');
                }
                var info = clip.sentence ? ' "' + clip.sentence + '"' : '';
                console.log('  ✓ Seg ' + i + '/' + (editList.length - 1) + ' (hook, ' + clip.duration.toFixed(1) + 's)' + info);
                continue;
            }

            // BODY segments: always use loop-fill strategy to guarantee exact duration
            var remaining = clip.duration;
            var loopIdx = 0;
            var midpoint = clipLen * 0.5;
            var partFiles = [];

            // First pass: play from ss toward end of clip
            var firstDur = Math.min(remaining, availableFromSs);
            var partPath = path.join(jobDir, 'seg-' + i + '-p' + loopIdx + '.ts');
            await this.encodeSegment(clip.src, clip.ss, firstDur, hasAudio, partPath);
            var pSize = 0;
            try { pSize = fs.statSync(partPath).size; } catch(e) {}
            if (pSize >= 100) {
                var partActual = await this.getMediaDuration(partPath);
                if (partActual > 0) {
                    partFiles.push(partPath);
                    remaining -= partActual;
                }
            }
            loopIdx++;

            // Loop: jump back to midpoint (~2.5s), play to end (~2.5s chunk), repeat
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
                } else break;
                loopIdx++;
                if (loopIdx > 20) break; // safety
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

                var loopTag = (partFiles.length > 1) ? ' 🔄loop(' + partFiles.length + ' parts)' : '';
                var tag = hasAudio ? '🔊' : '🔇';
                var info2 = clip.sentence ? ' "' + clip.sentence + '"' : '';
                console.log('  ✓ Seg ' + i + '/' + (editList.length - 1) + ' (body, ' + clip.duration.toFixed(1) + 's) ' + tag + loopTag + info2);
            } else {
                console.warn('  ⚠️ Segment ' + i + ' failed, skipping');
            }
        }

        if (tsFiles.length === 0) throw new Error('No valid segments produced');

        var concatPath = path.join(jobDir, 'concat.mp4');
        await this.ffmpeg([
            '-i', 'concat:' + tsFiles.join('|'),
            '-c', 'copy', '-movflags', '+faststart',
            '-y', concatPath
        ]);

        console.log('  ✅ Concat complete: ' + tsFiles.length + ' segments');

        // POST-CONCAT SAFETY: Check actual concat duration vs voiceover.
        // FFmpeg encoding can produce slightly shorter segments than requested,
        // and those tiny shortfalls accumulate. If the concat is shorter than
        // the voiceover, we extend by looping the last clip's final 3 seconds.
        if (voiceDuration && voiceDuration > 0) {
            var concatDur = await this.getMediaDuration(concatPath);
            var gap = voiceDuration - concatDur;

            if (gap > 0.5) {
                console.log('  ⚠️ Concat (' + concatDur.toFixed(1) + 's) shorter than voiceover (' +
                    voiceDuration.toFixed(1) + 's) — extending by ' + gap.toFixed(1) + 's');

                // Find the last body clip to use as filler
                var lastBodyClip = null;
                for (var x = editList.length - 1; x >= 0; x--) {
                    if (editList[x].type === 'body') { lastBodyClip = editList[x]; break; }
                }

                if (lastBodyClip) {
                    var fillClipLen = await this.getMediaDuration(lastBodyClip.src);
                    var fillHasAudio = await this.hasAudioStream(lastBodyClip.src);
                    // Play from last 3 seconds of the clip, looping as needed
                    var fillStart = Math.max(fillClipLen - 3, 0);
                    var fillRemaining = gap + 1.0; // +1s buffer
                    var fillIdx = 0;
                    var fillParts = [];

                    while (fillRemaining > 0.3 && fillIdx < 20) {
                        var fillDur = Math.min(fillRemaining, fillClipLen - fillStart);
                        var fillPath = path.join(jobDir, 'fill-' + fillIdx + '.ts');
                        await this.encodeSegment(lastBodyClip.src, fillStart, fillDur, fillHasAudio, fillPath);
                        var fSize = 0;
                        try { fSize = fs.statSync(fillPath).size; } catch(e) {}
                        if (fSize >= 100) {
                            var fillActual = await this.getMediaDuration(fillPath);
                            if (fillActual > 0) {
                                fillParts.push(fillPath);
                                fillRemaining -= fillActual;
                            } else break;
                        } else break;
                        fillIdx++;
                    }

                    if (fillParts.length > 0) {
                        // Re-concat: original + fill parts
                        var allTs = tsFiles.concat(fillParts);
                        var extendedPath = path.join(jobDir, 'concat-extended.mp4');
                        await this.ffmpeg([
                            '-i', 'concat:' + allTs.join('|'),
                            '-c', 'copy', '-movflags', '+faststart',
                            '-y', extendedPath
                        ]);

                        // Replace concat with extended version
                        try { fs.unlinkSync(concatPath); } catch(e) {}
                        fs.renameSync(extendedPath, concatPath);

                        var newDur = await this.getMediaDuration(concatPath);
                        console.log('  ✅ Extended concat: ' + newDur.toFixed(1) + 's (was ' + concatDur.toFixed(1) + 's)');

                        // Clean up fill parts
                        for (var fp = 0; fp < fillParts.length; fp++) {
                            try { fs.unlinkSync(fillParts[fp]); } catch(e) {}
                        }
                    }
                }
            }
        }

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
     * Build an ASS subtitle file for text overlays.
     * 
     * Two caption strategies:
     *   PRIMARY: Use real word timestamps from Gemini transcription (edl.transcription).
     *            Includes ALL words (hook + body). Shifted slightly early for sync.
     *   FALLBACK: Proportional distribution within each segment's time window.
     * 
     * Time marker titles fire at clip.startAt (absolute voiceover time).
     * 
     * Returns the file path, or null if no overlays.
     */
    buildAssSubtitles(editList, edl, jobDir) {
        var captionEvents = [];
        var titleEvents = [];

        // Caption offset: show captions slightly before the audio so they
        // feel perfectly in sync (accounts for visual processing delay)
        var CAPTION_LEAD = 0.5; // seconds earlier

        // 1. Word-by-word captions from full transcription (includes hook + body)
        var allWords = (edl && edl.transcription) ? edl.transcription :
                       (edl && edl.wordTimestamps) ? edl.wordTimestamps : null;

        if (allWords && allWords.length > 0) {
            // PRIMARY: Real word timestamps from Gemini transcription
            for (var w = 0; w < allWords.length; w++) {
                var word = allWords[w];
                if (!word.word || typeof word.startSec !== 'number') continue;

                var cleanWord = word.word.replace(/[^a-zA-Z0-9']/g, '').trim().toUpperCase();
                if (!cleanWord) continue;

                // Shift captions earlier so they feel in sync
                var wStart = Math.max(word.startSec - CAPTION_LEAD, 0);
                var wEnd = Math.max((word.endSec || word.startSec + 0.2) - CAPTION_LEAD, wStart + 0.1);

                captionEvents.push({
                    start: this.secsToAssTime(wStart),
                    end: this.secsToAssTime(wEnd),
                    text: cleanWord
                });
            }
            console.log('  📝 Captions: ' + captionEvents.length + ' words (Gemini transcription, lead -' + CAPTION_LEAD + 's)');
        } else {
            // FALLBACK: Proportional distribution from edit list
            for (var i = 0; i < editList.length; i++) {
                var clip = editList[i];
                if (clip.type !== 'body' || !clip.sentence) continue;

                var fullLine = '';
                if (edl && edl.body && clip.sceneNum) {
                    for (var b = 0; b < edl.body.length; b++) {
                        if (edl.body[b].scene === clip.sceneNum) {
                            fullLine = edl.body[b].scriptLine || '';
                            break;
                        }
                    }
                }
                if (!fullLine) fullLine = clip.sentence;

                var words = fullLine.split(/\s+/).filter(function(w) { return w.length > 0; });
                if (words.length === 0) continue;

                var segStart = clip.startAt;
                var segDur = clip.duration;
                var segEnd = segStart + segDur;
                var totalChars = 0;
                for (var w = 0; w < words.length; w++) totalChars += words[w].length;

                var cursor = segStart;
                for (var w = 0; w < words.length; w++) {
                    var wordDur = (words[w].length / totalChars) * segDur;
                    wordDur = Math.max(0.15, wordDur);
                    if (cursor >= segEnd) break;
                    if (cursor + wordDur > segEnd) wordDur = segEnd - cursor;

                    var cleanWord = words[w].replace(/[^a-zA-Z0-9']/g, '').trim().toUpperCase();
                    if (!cleanWord) { cursor += wordDur; continue; }

                    captionEvents.push({
                        start: this.secsToAssTime(cursor),
                        end: this.secsToAssTime(cursor + wordDur),
                        text: cleanWord
                    });
                    cursor += wordDur;
                }
            }
            console.log('  📝 Captions: ' + captionEvents.length + ' words (proportional fallback)');
        }

        // 2. Time marker titles — synced to transition SFX timing (startAt - 2.5s)
        for (var i = 0; i < editList.length; i++) {
            var clip = editList[i];
            if (clip.type === 'body' && clip.hasTimeMarker && clip.sentence) {
                var markerText = this.extractTimeMarkerText(clip.sentence);
                if (markerText) {
                    // startAt is absolute — when voiceover starts saying this line
                    var tStart = Math.max(clip.startAt, 0);
                    titleEvents.push({
                        start: this.secsToAssTime(tStart),
                        end: this.secsToAssTime(tStart + 3),
                        text: markerText.toUpperCase(),
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
            'Style: Caption,Arial,72,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,4,0,2,40,40,320,1\n' +
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
                // Transition SFX — startAt is now absolute (when voiceover says this line)
                // No offset needed since hookDur is no longer added to startAt
                events.push({ time: Math.max(clip.startAt, 0), sfx: this.sfx.transition, label: 'transition' });
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
