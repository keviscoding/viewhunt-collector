/**
 * Video Editor — Assembles final video from scene clips using FFmpeg.
 * Optimized for 256MB containers (basic-xxs DigitalOcean).
 * 
 * Strategy: Process ONE clip at a time to avoid OOM.
 *   1. Download all clips
 *   2. Re-encode each clip individually to normalized .ts files
 *      - Keeps clip audio at 20% volume (environmental sounds from Kling 2.6)
 *   3. Concat all .ts files with -c copy (near-zero memory)
 *   4. Mix voiceover + SFX onto the concat result
 * 
 * SFX files (place in assets/sfx/):
 *   - transition.mp3 — plays randomly on body scene changes
 *   - hook.mp3 — plays on each hook cut
 *   - riser.mp3 — plays right before first body clip
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

var SFX_DIR = path.join(__dirname, 'assets', 'sfx');

class VideoEditor {
    constructor() {
        this.tempDir = path.join(__dirname, '../../public/studio/generated/temp');
        this.outputDir = path.join(__dirname, '../../public/studio/generated/final');

        for (var dir of [this.tempDir, this.outputDir]) {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        }

        // Load available SFX
        this.sfx = {
            hook: this.findSfx('hook'),
            transition: this.findSfx('transition'),
            riser: this.findSfx('riser')
        };
        var loaded = Object.keys(this.sfx).filter(function(k) { return this.sfx[k]; }.bind(this));
        if (loaded.length > 0) {
            console.log('🔊 SFX loaded: ' + loaded.join(', '));
        } else {
            console.log('🔇 No SFX found in ' + SFX_DIR + ' (optional)');
        }
    }

    /**
     * Find an SFX file by name (checks .mp3 and .wav)
     */
    findSfx(name) {
        var exts = ['.mp3', '.wav', '.aac', '.ogg'];
        for (var i = 0; i < exts.length; i++) {
            var p = path.join(SFX_DIR, name + exts[i]);
            if (fs.existsSync(p)) return p;
        }
        return null;
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
            // Step 1: Download clips
            console.log('📥 Step 1: Downloading scene clips...');
            var clipPaths = await this.downloadClips(scenes, jobDir);

            // Step 2: Get voiceover duration
            var voiceDuration = await this.getMediaDuration(voiceoverPath);
            console.log('🎙️ Voiceover duration: ' + voiceDuration.toFixed(1) + 's');

            // Step 3: Build edit list with timestamps
            console.log('📋 Step 2: Building edit list...');
            var editList = this.buildEditList(edl, clipPaths, voiceDuration);
            console.log('  ' + editList.length + ' clips in sequence');

            // Step 4: Sequential normalize + concat
            console.log('🎬 Step 3: Normalizing clips one-by-one...');
            var concatPath = await this.sequentialAssemble(editList, jobDir);

            // Step 5: Mix voiceover + SFX
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
     * Build ordered list of clips with cumulative timestamps for SFX placement
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
                    src: src,
                    ss: hc.startSec || 0,
                    duration: dur,
                    type: 'hook',
                    startAt: currentTime
                });
                currentTime += dur;
            }
        }

        // Body clips — distribute remaining time
        var hookDur = currentTime;
        var bodyTime = Math.max(voiceDuration - hookDur, 10);
        var perSeg = bodyTime / Math.max(edl.body.length, 1);

        for (var k = 0; k < edl.body.length; k++) {
            var seg = edl.body[k];
            var bodySrc = clipPaths[seg.scene];
            if (!bodySrc) continue;
            var segDur = Math.min(perSeg, 5);
            clips.push({
                src: bodySrc,
                ss: seg.startSec || 0,
                duration: segDur,
                type: 'body',
                startAt: currentTime
            });
            currentTime += segDur;
        }

        return clips;
    }

    /**
     * Sequential assembly: normalize each clip one at a time, then concat.
     * Keeps clip audio at 20% volume for environmental sounds.
     * Falls back to silent audio if clip has no audio stream.
     */
    async sequentialAssemble(editList, jobDir) {
        var tsFiles = [];

        for (var i = 0; i < editList.length; i++) {
            var clip = editList[i];
            var tsPath = path.join(jobDir, 'seg-' + i + '.ts');

            // Check if clip has an audio stream
            var hasAudio = await this.hasAudioStream(clip.src);

            var args;
            if (hasAudio) {
                // Keep clip audio at 20% volume
                args = [
                    '-ss', String(clip.ss),
                    '-t', String(clip.duration),
                    '-i', clip.src,
                    '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1',
                    '-af', 'volume=0.2',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
                    '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac', '-b:a', '64k', '-ar', '44100', '-ac', '2',
                    '-f', 'mpegts',
                    '-y', tsPath
                ];
            } else {
                // No audio — generate silent track so concat works
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
                console.warn('  ⚠️ Segment ' + i + ' too small (' + segSize + 'b), skipping');
                continue;
            }

            tsFiles.push(tsPath);
            var audioTag = hasAudio ? '🔊' : '🔇';
            console.log('  ✓ Segment ' + i + '/' + (editList.length - 1) + ' (' + clip.type + ', ' + clip.duration.toFixed(1) + 's) ' + audioTag);
        }

        if (tsFiles.length === 0) {
            throw new Error('No valid segments produced');
        }

        // Concat all .ts files using concat protocol (zero re-encode, near-zero memory)
        var concatPath = path.join(jobDir, 'concat.mp4');
        var concatInput = 'concat:' + tsFiles.join('|');

        await this.ffmpeg([
            '-i', concatInput,
            '-c', 'copy',
            '-movflags', '+faststart',
            '-y', concatPath
        ]);

        console.log('  ✅ Concat complete: ' + tsFiles.length + ' segments');
        return concatPath;
    }

    /**
     * Check if a media file has an audio stream
     */
    async hasAudioStream(filePath) {
        try {
            var result = await execFileAsync(ffprobePath, [
                '-v', 'quiet',
                '-select_streams', 'a',
                '-show_entries', 'stream=codec_type',
                '-of', 'csv=p=0',
                filePath
            ]);
            return result.stdout.trim().length > 0;
        } catch (err) {
            return false;
        }
    }

    /**
     * Mix final audio: voiceover + clip audio (already at 20%) + SFX overlays.
     * 
     * SFX placement:
     *   - hook.mp3: plays at the start of each hook clip
     *   - riser.mp3: plays right before the first body clip
     *   - transition.mp3: plays randomly (~50% chance) on body scene changes
     */
    async mixFinalAudio(concatVideoPath, voiceoverPath, editList, outputPath, jobDir) {
        // Build SFX timeline
        var sfxEvents = this.buildSfxTimeline(editList);

        if (sfxEvents.length === 0) {
            // No SFX — just mix voiceover over clip audio
            console.log('  No SFX files found, mixing voiceover only');
            await this.ffmpeg([
                '-i', concatVideoPath,
                '-i', voiceoverPath,
                '-filter_complex',
                '[0:a]volume=1.0[clip];[1:a]volume=1.0[vo];[clip][vo]amix=inputs=2:duration=shortest:dropout_transition=2[aout]',
                '-map', '0:v', '-map', '[aout]',
                '-c:v', 'copy',
                '-c:a', 'aac', '-b:a', '128k',
                '-movflags', '+faststart',
                '-y', outputPath
            ]);
            return;
        }

        // Build SFX mix file: concat all SFX at their timestamps into one audio track
        var sfxMixPath = path.join(jobDir, 'sfx-mix.wav');
        await this.buildSfxTrack(sfxEvents, editList, sfxMixPath, jobDir);

        // Mix: clip audio (20%) + voiceover (100%) + SFX track (80%)
        var sfxMixExists = fs.existsSync(sfxMixPath) && fs.statSync(sfxMixPath).size > 100;

        if (sfxMixExists) {
            console.log('  Mixing: clip audio + voiceover + ' + sfxEvents.length + ' SFX events');
            await this.ffmpeg([
                '-i', concatVideoPath,
                '-i', voiceoverPath,
                '-i', sfxMixPath,
                '-filter_complex',
                '[0:a]volume=1.0[clip];[1:a]volume=1.0[vo];[2:a]volume=0.8[sfx];[clip][vo][sfx]amix=inputs=3:duration=shortest:dropout_transition=2[aout]',
                '-map', '0:v', '-map', '[aout]',
                '-c:v', 'copy',
                '-c:a', 'aac', '-b:a', '128k',
                '-movflags', '+faststart',
                '-y', outputPath
            ]);
        } else {
            // SFX track failed to build, fall back to voiceover only
            console.log('  SFX track failed, mixing voiceover only');
            await this.ffmpeg([
                '-i', concatVideoPath,
                '-i', voiceoverPath,
                '-filter_complex',
                '[0:a]volume=1.0[clip];[1:a]volume=1.0[vo];[clip][vo]amix=inputs=2:duration=shortest:dropout_transition=2[aout]',
                '-map', '0:v', '-map', '[aout]',
                '-c:v', 'copy',
                '-c:a', 'aac', '-b:a', '128k',
                '-movflags', '+faststart',
                '-y', outputPath
            ]);
        }
    }

    /**
     * Build SFX timeline from edit list
     */
    buildSfxTimeline(editList) {
        var events = [];
        var lastType = null;

        for (var i = 0; i < editList.length; i++) {
            var clip = editList[i];

            if (clip.type === 'hook' && this.sfx.hook) {
                // Hook sound on every hook clip
                events.push({ time: clip.startAt, sfx: this.sfx.hook, label: 'hook' });
            }

            if (clip.type === 'body' && lastType === 'hook' && this.sfx.riser) {
                // Riser right before first body clip (play it 0.5s before body starts)
                var riserTime = Math.max(clip.startAt - 0.5, 0);
                events.push({ time: riserTime, sfx: this.sfx.riser, label: 'riser' });
            }

            if (clip.type === 'body' && lastType === 'body' && this.sfx.transition) {
                // Random ~50% chance of transition click on body scene changes
                if (Math.random() < 0.5) {
                    events.push({ time: clip.startAt, sfx: this.sfx.transition, label: 'transition' });
                }
            }

            lastType = clip.type;
        }

        if (events.length > 0) {
            console.log('  🔊 SFX timeline: ' + events.map(function(e) { return e.label + '@' + e.time.toFixed(1) + 's'; }).join(', '));
        }

        return events;
    }

    /**
     * Build a single SFX audio track with all events placed at their timestamps.
     * Uses adelay filter to position each SFX in time, then amix them together.
     */
    async buildSfxTrack(sfxEvents, editList, outputPath, jobDir) {
        if (sfxEvents.length === 0) return;

        // Total duration of the video
        var lastClip = editList[editList.length - 1];
        var totalDuration = lastClip.startAt + lastClip.duration;

        // Build filter: each SFX gets delayed to its timestamp, then mixed
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
            // Single SFX — no need to amix
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

    /**
     * Download scene clips to temp dir
     */
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
                        var localPath = path.join(__dirname, '../../public', url);
                        fs.copyFileSync(localPath, clipPath);
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

    /**
     * Get media duration using ffprobe
     */
    async getMediaDuration(filePath) {
        try {
            var result = await execFileAsync(ffprobePath, [
                '-v', 'quiet',
                '-show_entries', 'format=duration',
                '-of', 'csv=p=0',
                filePath
            ]);
            return parseFloat(result.stdout.trim()) || 0;
        } catch (err) {
            console.warn('Could not get duration for ' + filePath + ': ' + err.message);
            return 0;
        }
    }

    /**
     * Run FFmpeg command
     */
    async ffmpeg(args) {
        try {
            var result = await execFileAsync(ffmpegPath, args, {
                timeout: 300000,
                maxBuffer: 10 * 1024 * 1024
            });
            return result;
        } catch (error) {
            if (error.code) {
                var errMsg = (error.stderr || '').substring(0, 500);
                console.error('FFmpeg error:', errMsg);
                throw new Error('FFmpeg failed (code ' + error.code + '): ' + errMsg.substring(0, 200));
            }
            return { stdout: error.stdout, stderr: error.stderr };
        }
    }

    /**
     * Clean up temp directory
     */
    cleanup(jobDir) {
        try {
            if (fs.existsSync(jobDir)) {
                fs.rmSync(jobDir, { recursive: true, force: true });
            }
        } catch (err) {
            console.warn('Cleanup warning:', err.message);
        }
    }
}

module.exports = VideoEditor;
