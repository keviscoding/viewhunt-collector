/**
 * Video Editor — Assembles final video from scene clips using FFmpeg.
 * Optimized for 256MB containers (basic-xxs DigitalOcean).
 * 
 * Strategy: Process ONE clip at a time to avoid OOM.
 *   1. Download all clips
 *   2. Re-encode each clip individually to a normalized .ts (MPEG-TS) file
 *      (same resolution, codec, pixel format)
 *   3. Concat all .ts files with -c copy (zero memory overhead)
 *   4. Mux voiceover audio onto the concat result
 * 
 * This uses more disk I/O but stays well under 256MB RAM.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

class VideoEditor {
    constructor() {
        this.tempDir = path.join(__dirname, '../../public/studio/generated/temp');
        this.outputDir = path.join(__dirname, '../../public/studio/generated/final');

        for (var dir of [this.tempDir, this.outputDir]) {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        }
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

            // Step 3: Build edit list
            console.log('📋 Step 2: Building edit list...');
            var editList = this.buildEditList(edl, clipPaths, voiceDuration);
            console.log('  ' + editList.length + ' clips in sequence');

            // Step 4: Sequential normalize + concat
            console.log('🎬 Step 3: Normalizing clips one-by-one...');
            var concatPath = await this.sequentialAssemble(editList, jobDir);

            // Step 5: Mux voiceover onto concat video
            console.log('🔊 Step 4: Adding voiceover...');
            var finalPath = path.join(this.outputDir, jobId + '.mp4');
            await this.muxAudio(concatPath, voiceoverPath, finalPath);

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
     * Build ordered list of clips with source path, start time, and duration
     */
    buildEditList(edl, clipPaths, voiceDuration) {
        var clips = [];

        // Hook clips first
        if (edl.hook && edl.hook.clips) {
            for (var i = 0; i < edl.hook.clips.length; i++) {
                var hc = edl.hook.clips[i];
                var src = clipPaths[hc.scene];
                if (!src) continue;
                clips.push({
                    src: src,
                    ss: hc.startSec || 0,
                    duration: hc.duration || 0.5,
                    type: 'hook'
                });
            }
        }

        // Body clips — distribute remaining time
        var hookDur = 0;
        for (var j = 0; j < clips.length; j++) hookDur += clips[j].duration;
        var bodyTime = Math.max(voiceDuration - hookDur, 10);
        var perSeg = bodyTime / Math.max(edl.body.length, 1);

        for (var k = 0; k < edl.body.length; k++) {
            var seg = edl.body[k];
            var bodySrc = clipPaths[seg.scene];
            if (!bodySrc) continue;
            clips.push({
                src: bodySrc,
                ss: seg.startSec || 0,
                duration: Math.min(perSeg, 5),
                type: 'body'
            });
        }

        return clips;
    }

    /**
     * Sequential assembly: normalize each clip one at a time, then concat.
     * This keeps peak memory to ~one clip's worth of decode+encode.
     * Preserves audio from clips at low volume for environmental sounds.
     */
    async sequentialAssemble(editList, jobDir) {
        var tsFiles = [];

        for (var i = 0; i < editList.length; i++) {
            var clip = editList[i];
            var tsPath = path.join(jobDir, 'seg-' + i + '.ts');

            // Re-encode this single clip to normalized MPEG-TS
            // Generate silent audio track (clips from Kling 2.6 are typically mute)
            // Voiceover gets mixed in at the final mux step
            var args = [
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

            await this.ffmpeg(args);

            var segSize = 0;
            try { segSize = fs.statSync(tsPath).size; } catch(e) {}
            if (segSize < 100) {
                console.warn('  ⚠️ Segment ' + i + ' too small (' + segSize + 'b), skipping');
                continue;
            }

            tsFiles.push(tsPath);
            console.log('  ✓ Segment ' + i + '/' + (editList.length - 1) + ' (' + clip.type + ', ' + clip.duration.toFixed(1) + 's)');
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
     * Mux voiceover audio onto the video, replacing the silent placeholder audio.
     */
    async muxAudio(videoPath, audioPath, outputPath) {
        await this.ffmpeg([
            '-i', videoPath,
            '-i', audioPath,
            '-map', '0:v',
            '-map', '1:a',
            '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '128k',
            '-shortest',
            '-movflags', '+faststart',
            '-y', outputPath
        ]);
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
                timeout: 300000, // 5 min per operation
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
