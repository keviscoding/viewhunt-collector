/**
 * Video Editor — Assembles final video from scene clips using FFmpeg.
 * Optimized for 256MB containers (basic-xxs DigitalOcean).
 * 
 * Strategy: Process ONE clip at a time to avoid OOM.
 *   1. Download all clips
 *   2. Re-encode each clip individually to normalized .ts files
 *      - Keeps clip audio at 35% volume (environmental sounds from Kling 2.6)
 *   3. Concat all .ts files with -c copy (near-zero memory)
 *   4. Mix voiceover + SFX onto the concat result
 * 
 * Timing: Uses sentence lengths from the EDL to calculate per-segment durations
 * so scene switches align with sentence boundaries in the voiceover.
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
     * Build edit list using Claude's scriptLine mapping for body timing.
     * 
     * Each scene has a scriptLine (the chunk of script Claude assigned to it).
     * Duration is proportional to scriptLine length — longer lines get more time.
     * This naturally aligns scene switches with the voiceover.
     */
    buildEditList(edl, clipPaths, voiceDuration) {
        var clips = [];
        var currentTime = 0;
        var sceneUsage = {};

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

        // Body: use scriptLine lengths for proportional timing
        var hookDur = currentTime;
        var bodyTime = Math.max(voiceDuration - hookDur, 10);

        // Calculate total character count across all body scriptLines
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

            // Duration proportional to this scriptLine's share of total text
            var segDur = (charLen / totalChars) * bodyTime;
            // Clamp: min 2s, max 10s (let clips play their full duration)
            segDur = Math.max(2, Math.min(segDur, 10));

            // Track scene usage to avoid replaying same portion
            var sceneKey = String(seg.scene);
            if (!sceneUsage[sceneKey]) sceneUsage[sceneKey] = 0;
            var ss = sceneUsage[sceneKey];
            if (ss + segDur > 5) ss = 0;
            sceneUsage[sceneKey] = ss + segDur;

            // Detect time markers for SFX
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
     * Keeps clip audio at 35% volume for environmental sounds.
     */
    async sequentialAssemble(editList, jobDir) {
        var tsFiles = [];

        for (var i = 0; i < editList.length; i++) {
            var clip = editList[i];
            var tsPath = path.join(jobDir, 'seg-' + i + '.ts');
            var hasAudio = await this.hasAudioStream(clip.src);

            var args;
            if (hasAudio) {
                args = [
                    '-ss', String(clip.ss),
                    '-t', String(clip.duration),
                    '-i', clip.src,
                    '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1',
                    '-af', 'volume=0.45',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
                    '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac', '-b:a', '64k', '-ar', '44100', '-ac', '2',
                    '-f', 'mpegts',
                    '-y', tsPath
                ];
            } else {
                args = [
                    '-ss', String(clip.ss),
                    '-t', String(clip.duration),
                    '-i', clip.src,
                    '-f', 'lavfi', '-t', String(clip.duration), '-i', 'anullsrc=r=44100:cl=stereo',
                    '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
                    '-pix_fmt', 'yuv420p',
                    '-map', '0:v', '-map', '1:a',
                    '-c:a', 'aac', '-b:a', '64k', '-shortest',
                    '-f', 'mpegts',
                    '-y', tsPath
                ];
            }

            await this.ffmpeg(args);

            var segSize = 0;
            try { segSize = fs.statSync(tsPath).size; } catch(e) {}
            if (segSize < 100) {
                console.warn('  ⚠️ Segment ' + i + ' too small, skipping');
                continue;
            }

            tsFiles.push(tsPath);
            var tag = hasAudio ? '🔊' : '🔇';
            var info = clip.sentence ? ' "' + clip.sentence + '"' : '';
            console.log('  ✓ Seg ' + i + '/' + (editList.length - 1) + ' (' + clip.type + ', ' + clip.duration.toFixed(1) + 's) ' + tag + info);
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
