/**
 * Video Editor — Assembles final video from scene clips using FFmpeg
 * Optimized for low-memory environments (256MB DigitalOcean containers)
 * 
 * Strategy: Use stream copy (-c copy) everywhere possible to avoid re-encoding.
 * Only re-encode when absolutely necessary (trimming to exact duration).
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ensureClickSound = require('./assets/ensure-click');

const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

class VideoEditor {
    constructor() {
        this.tempDir = path.join(__dirname, '../../public/studio/generated/temp');
        this.outputDir = path.join(__dirname, '../../public/studio/generated/final');
        this.clickSound = ensureClickSound();

        for (const dir of [this.tempDir, this.outputDir]) {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * Main assembly — memory-efficient pipeline
     */
    async assemble(edl, scenes, voiceoverPath, options = {}) {
        const jobId = `edit-${Date.now()}`;
        const jobDir = path.join(this.tempDir, jobId);
        fs.mkdirSync(jobDir, { recursive: true });

        console.log(`\n🎬 Video Editor: Starting assembly (job: ${jobId})`);

        try {
            // Step 1: Download clips
            console.log('📥 Step 1: Downloading scene clips...');
            const clipPaths = await this.downloadClips(scenes, jobDir);

            // Step 2: Get voiceover duration
            const voiceDuration = await this.getMediaDuration(voiceoverPath);
            console.log(`🎙️ Voiceover duration: ${voiceDuration.toFixed(1)}s`);

            // Step 3: Trim all clips (hook + body) to their target durations
            // Use -c copy with keyframe-aware seeking for speed + low memory
            console.log('✂️ Step 2: Trimming clips...');
            const trimmedClips = await this.trimAllClips(edl, clipPaths, voiceDuration, jobDir);

            // Step 4: Concatenate all trimmed clips (stream copy — near zero memory)
            console.log('🔗 Step 3: Concatenating all clips...');
            const concatPath = path.join(jobDir, 'concat.mp4');
            await this.concatStreamCopy(trimmedClips, concatPath);

            // Step 5: Add voiceover audio in one pass
            console.log('🎙️ Step 4: Adding voiceover...');
            const finalPath = path.join(this.outputDir, `${jobId}.mp4`);
            await this.addVoiceover(concatPath, voiceoverPath, finalPath);

            const finalDuration = await this.getMediaDuration(finalPath);
            this.cleanup(jobDir);

            const videoUrl = `/studio/generated/final/${jobId}.mp4`;
            console.log(`\n✅ Final video: ${videoUrl} (${finalDuration.toFixed(1)}s)\n`);

            return { videoPath: finalPath, videoUrl, duration: finalDuration };

        } catch (error) {
            console.error('Video assembly error:', error.message);
            this.cleanup(jobDir);
            throw error;
        }
    }

    /**
     * Download scene clips to temp dir
     */
    async downloadClips(scenes, jobDir) {
        const clipPaths = {};
        const downloads = scenes
            .filter(s => s.videoUrl || s._videoUrl)
            .map(async (scene) => {
                const num = scene.sceneNumber;
                const url = scene.videoUrl || scene._videoUrl;
                const clipPath = path.join(jobDir, `scene-${num}.mp4`);
                try {
                    if (url.startsWith('/') || url.startsWith('./')) {
                        const localPath = path.join(__dirname, '../../public', url);
                        fs.copyFileSync(localPath, clipPath);
                    } else {
                        const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
                        fs.writeFileSync(clipPath, resp.data);
                    }
                    clipPaths[num] = clipPath;
                    console.log(`  ✓ Scene ${num}`);
                } catch (err) {
                    console.warn(`  ✗ Scene ${num}: ${err.message}`);
                }
            });
        await Promise.all(downloads);
        console.log(`  ${Object.keys(clipPaths).length}/${scenes.length} clips ready`);
        return clipPaths;
    }

    /**
     * Trim all clips (hook + body) to target durations.
     * Uses -ss before -i (input seeking) + -c copy for near-zero memory usage.
     * Returns ordered array of trimmed clip paths.
     */
    async trimAllClips(edl, clipPaths, voiceDuration, jobDir) {
        const trimmed = [];

        // Hook clips (0.4-0.5s each)
        for (let i = 0; i < edl.hook.clips.length; i++) {
            const hc = edl.hook.clips[i];
            const src = clipPaths[hc.scene];
            if (!src) continue;

            const out = path.join(jobDir, `trim-hook-${i}.mp4`);
            const ss = hc.startSec || 0;
            const dur = hc.duration || 0.5;

            // For very short clips, we need re-encode to get exact duration
            await this.ffmpeg([
                '-ss', String(ss), '-i', src,
                '-t', String(dur),
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                '-an', '-y', out
            ]);
            trimmed.push(out);
            // Clean up downloaded source after last use? No — body may reuse it
        }
        console.log(`  Hook: ${trimmed.length} clips trimmed`);

        // Body clips — distribute voiceover time evenly
        const hookDur = edl.hook.clips.reduce((s, c) => s + (c.duration || 0.5), 0);
        const bodyTime = Math.max(voiceDuration - hookDur, 10);
        const perSeg = bodyTime / edl.body.length;

        for (let i = 0; i < edl.body.length; i++) {
            const seg = edl.body[i];
            const src = clipPaths[seg.scene];
            if (!src) continue;

            const out = path.join(jobDir, `trim-body-${i}.mp4`);
            const ss = seg.startSec || 0;
            const dur = Math.min(perSeg, 5);

            // Stream copy where possible, re-encode only if needed for exact trim
            await this.ffmpeg([
                '-ss', String(ss), '-i', src,
                '-t', String(dur),
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                '-an', '-y', out
            ]);
            trimmed.push(out);

            // Delete previous body clip to free disk/memory
            if (i > 0) {
                const prevSrc = clipPaths[edl.body[i - 1]?.scene];
                const curSrc = clipPaths[seg.scene];
                // Only delete if no future segment uses this source
                const futureUses = edl.body.slice(i + 1).some(s => clipPaths[s.scene] === prevSrc);
                if (prevSrc && prevSrc !== curSrc && !futureUses) {
                    try { fs.unlinkSync(prevSrc); } catch (e) {}
                }
            }
        }
        console.log(`  Body: ${edl.body.length} clips trimmed (${perSeg.toFixed(1)}s each)`);

        return trimmed;
    }

    /**
     * Concatenate clips using concat demuxer with stream copy (zero re-encode)
     */
    async concatStreamCopy(clipPaths, outputPath) {
        const listFile = outputPath + '.txt';
        fs.writeFileSync(listFile, clipPaths.map(p => `file '${p}'`).join('\n'));

        await this.ffmpeg([
            '-f', 'concat', '-safe', '0',
            '-i', listFile,
            '-c', 'copy',
            '-y', outputPath
        ]);

        fs.unlinkSync(listFile);
        const dur = await this.getMediaDuration(outputPath);
        console.log(`  Concatenated: ${dur.toFixed(1)}s`);
    }

    /**
     * Add voiceover to video — single pass, stream copy video
     */
    async addVoiceover(videoPath, audioPath, outputPath) {
        await this.ffmpeg([
            '-i', videoPath,
            '-i', audioPath,
            '-map', '0:v', '-map', '1:a',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
            '-shortest',
            '-y', outputPath
        ]);
    }

    /**
     * Get media duration using ffprobe
     */
    async getMediaDuration(filePath) {
        try {
            const { stdout } = await execFileAsync(ffprobePath, [
                '-v', 'quiet',
                '-show_entries', 'format=duration',
                '-of', 'csv=p=0',
                filePath
            ]);
            return parseFloat(stdout.trim()) || 0;
        } catch (err) {
            console.warn(`Could not get duration for ${filePath}: ${err.message}`);
            return 0;
        }
    }

    /**
     * Run FFmpeg command
     */
    async ffmpeg(args) {
        try {
            const { stdout, stderr } = await execFileAsync(ffmpegPath, args, {
                timeout: 300000,
                maxBuffer: 10 * 1024 * 1024 // 10MB buffer for stderr
            });
            return { stdout, stderr };
        } catch (error) {
            if (error.code) {
                console.error('FFmpeg error:', error.stderr?.substring(0, 500));
                throw new Error('FFmpeg failed: ' + (error.stderr?.substring(0, 200) || error.message));
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
