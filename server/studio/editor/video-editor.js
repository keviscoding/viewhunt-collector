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

        this.sfx = { hook: null, transition: null, riser: null };
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

            console.log('🔊 Step 4: Mixing audio...');
            var finalPath = path.join(this.outputDir, jobId + '.mp4');
            await this.mixFinalAudio(concatPath, voiceoverPath, editList, finalPath, jobDir);

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

        return clips;
    }

    /**
     * Body segments with real timestamps from Gemini voiceover analysis.
     * Each timestamp tells us when that scriptLine starts in the audio.
     * Duration = next timestamp - this timestamp (last segment fills to end).
     */
    buildBodyFromTimestamps(edl, clipPaths, hookDur, voiceDuration) {
        var clips = [];
        var ts = edl.timestamps;
        var sceneUsage = {};

        for (var k = 0; k < edl.body.length; k++) {
            var seg = edl.body[k];
            var bodySrc = clipPaths[seg.scene];
            if (!bodySrc) continue;

            // Find matching timestamp for this segment
            var tsEntry = null;
            for (var t = 0; t < ts.length; t++) {
                if (ts[t].scene === seg.scene || ts[t].index === k + 1) {
                    tsEntry = ts[t]; break;
                }
            }

            var startAt, segDur;
            if (tsEntry) {
                // Offset by hookDur since timestamps are relative to voiceover start
                // but our video starts with hook clips before the voiceover body
                startAt = hookDur + tsEntry.startSec;

                // Duration = time until next timestamp (or end of voiceover)
                var nextStart = voiceDuration;
                for (var n = t + 1; n < ts.length; n++) {
                    if (typeof ts[n].startSec === 'number') {
                        nextStart = hookDur + ts[n].startSec;
                        break;
                    }
                }
                segDur = nextStart - startAt;
            } else {
                // No timestamp found for this segment — estimate
                var prevClip = clips.length > 0 ? clips[clips.length - 1] : null;
                startAt = prevClip ? prevClip.startAt + prevClip.duration : hookDur;
                segDur = 5;
            }

            // Clamp: min 2s, max 12s
            segDur = Math.max(2, Math.min(segDur, 12));

            // Track scene usage to vary start position within clip
            var sceneKey = String(seg.scene);
            if (!sceneUsage[sceneKey]) sceneUsage[sceneKey] = 0;
            var ss = sceneUsage[sceneKey];
            if (ss + segDur > 5) ss = 0;
            sceneUsage[sceneKey] = ss + segDur;

            var scriptLine = seg.scriptLine || '';
            var hasTimeMarker = TIME_MARKER_RE.test(scriptLine);

            clips.push({
                src: bodySrc, ss: ss, duration: segDur,
                type: 'body', startAt: startAt,
                hasTimeMarker: hasTimeMarker,
                sentence: scriptLine.substring(0, 60)
            });
        }

        return clips;
    }

    /**
     * Fallback: proportional timing based on scriptLine character length.
     */
    buildBodyProportional(edl, clipPaths, hookDur, voiceDuration) {
        var clips = [];
        var currentTime = hookDur;
        var bodyTime = Math.max(voiceDuration - hookDur, 10);
        var sceneUsage = {};

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
            segDur = Math.max(2, Math.min(segDur, 10));

            var sceneKey = String(seg.scene);
            if (!sceneUsage[sceneKey]) sceneUsage[sceneKey] = 0;
            var ss = sceneUsage[sceneKey];
            if (ss + segDur > 5) ss = 0;
            sceneUsage[sceneKey] = ss + segDur;

            var hasTimeMarker = TIME_MARKER_RE.test(scriptLine);

            clips.push({
                src: bodySrc, ss: ss, duration: segDur,
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

            if (clip.duration <= availableFromSs + 0.3) {
                // Clip is long enough — single pass
                var tsPath = path.join(jobDir, 'seg-' + i + '.ts');
                await this.encodeSegment(clip.src, clip.ss, clip.duration, hasAudio, tsPath);
                var segSize = 0;
                try { segSize = fs.statSync(tsPath).size; } catch(e) {}
                if (segSize >= 100) {
                    tsFiles.push(tsPath);
                } else {
                    console.warn('  ⚠️ Segment ' + i + ' too small, skipping');
                    continue;
                }
            } else {
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
                if (pSize >= 100) { partFiles.push(partPath); remaining -= firstDur; }
                loopIdx++;

                // Loop: jump back to midpoint, play to end, repeat
                while (remaining > 0.3) {
                    var loopAvail = clipLen - midpoint;
                    var loopDur = Math.min(remaining, loopAvail);
                    partPath = path.join(jobDir, 'seg-' + i + '-p' + loopIdx + '.ts');
                    await this.encodeSegment(clip.src, midpoint, loopDur, hasAudio, partPath);
                    pSize = 0;
                    try { pSize = fs.statSync(partPath).size; } catch(e) {}
                    if (pSize >= 100) { partFiles.push(partPath); remaining -= loopDur; }
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
            var loopTag = (clip.duration > availableFromSs + 0.3) ? ' 🔄' : '';
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
     * Mix final audio: voiceover + clip audio + SFX.
     * Volume strategy (compensating for amix normalization):
     *   3 inputs: amix divides by 3 → boost each by 3x
     *   2 inputs: amix divides by 2 → boost each by 2x
     */
    async mixFinalAudio(concatVideoPath, voiceoverPath, editList, outputPath, jobDir) {
        var sfxEvents = this.buildSfxTimeline(editList);

        if (sfxEvents.length === 0) {
            console.log('  No SFX, mixing voiceover + clip audio');
            await this.ffmpeg([
                '-i', concatVideoPath, '-i', voiceoverPath,
                '-filter_complex',
                '[0:a]volume=0.9[clip];[1:a]volume=2.0[vo];[clip][vo]amix=inputs=2:duration=shortest:dropout_transition=2[aout]',
                '-map', '0:v', '-map', '[aout]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
                '-movflags', '+faststart', '-y', outputPath
            ]);
            return;
        }

        var sfxMixPath = path.join(jobDir, 'sfx-mix.wav');
        await this.buildSfxTrack(sfxEvents, editList, sfxMixPath, jobDir);
        var sfxOk = fs.existsSync(sfxMixPath) && fs.statSync(sfxMixPath).size > 100;

        if (sfxOk) {
            console.log('  Mixing: clip audio + voiceover + ' + sfxEvents.length + ' SFX');
            await this.ffmpeg([
                '-i', concatVideoPath, '-i', voiceoverPath, '-i', sfxMixPath,
                '-filter_complex',
                '[0:a]volume=1.5[clip];[1:a]volume=3.0[vo];[2:a]volume=8.0[sfx];[clip][vo][sfx]amix=inputs=3:duration=shortest:dropout_transition=2[aout]',
                '-map', '0:v', '-map', '[aout]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
                '-movflags', '+faststart', '-y', outputPath
            ]);
        } else {
            console.log('  SFX track failed, voiceover only');
            await this.ffmpeg([
                '-i', concatVideoPath, '-i', voiceoverPath,
                '-filter_complex',
                '[0:a]volume=0.9[clip];[1:a]volume=2.0[vo];[clip][vo]amix=inputs=2:duration=shortest:dropout_transition=2[aout]',
                '-map', '0:v', '-map', '[aout]',
                '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
                '-movflags', '+faststart', '-y', outputPath
            ]);
        }
    }

    /**
     * Build SFX timeline.
     * - hook.mp3 on every hook clip
     * - riser.mp3 before first body clip
     * - transition.mp3 ONLY on time-marker sentences (Day 1, Hour 1, etc.)
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
                events.push({ time: clip.startAt, sfx: this.sfx.transition, label: 'transition' });
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
            return await execFileAsync(ffmpegPath, args, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 });
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
