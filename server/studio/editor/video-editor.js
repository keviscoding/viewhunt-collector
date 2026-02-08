/**
 * Video Editor — Assembles final video from scene clips using FFmpeg
 * Optimized for low-memory (256MB containers).
 * 
 * Key strategy: Do ONE single FFmpeg command that reads all inputs,
 * trims/scales/concatenates them, and adds voiceover in a single pass.
 * This avoids creating dozens of intermediate files and re-encoding multiple times.
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

        for (const dir of [this.tempDir, this.outputDir]) {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * Main assembly
     */
    async assemble(edl, scenes, voiceoverPath) {
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

            // Step 3: Build the ordered clip list with timings
            console.log('📋 Step 2: Building edit list...');
            const editList = this.buildEditList(edl, clipPaths, voiceDuration);
            console.log(`  ${editList.length} clips in sequence`);

            // Step 4: Single-pass FFmpeg assembly
            console.log('🎬 Step 3: Assembling video (single-pass)...');
            const finalPath = path.join(this.outputDir, `${jobId}.mp4`);
            await this.singlePassAssemble(editList, voiceoverPath, finalPath, jobDir);

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
     * Build ordered list of clips with source path, start time, and duration
     */
    buildEditList(edl, clipPaths, voiceDuration) {
        const clips = [];

        // Hook clips first
        for (const hc of edl.hook.clips) {
            const src = clipPaths[hc.scene];
            if (!src) continue;
            clips.push({
                src,
                ss: hc.startSec || 0,
                duration: hc.duration || 0.5,
                type: 'hook'
            });
        }

        // Body clips — distribute remaining time evenly
        const hookDur = clips.reduce((s, c) => s + c.duration, 0);
        const bodyTime = Math.max(voiceDuration - hookDur, 10);
        const perSeg = bodyTime / edl.body.length;

        for (const seg of edl.body) {
            const src = clipPaths[seg.scene];
            if (!src) continue;
            clips.push({
                src,
                ss: seg.startSec || 0,
                duration: Math.min(perSeg, 5),
                type: 'body'
            });
        }

        return clips;
    }

    /**
     * Single-pass assembly using FFmpeg filter_complex.
     * Reads all source clips + voiceover, trims/scales/concatenates, outputs one file.
     * This is the most memory-efficient approach — one FFmpeg process, streaming.
     */
    async singlePassAssemble(editList, voiceoverPath, outputPath, jobDir) {
        // Collect unique source files to avoid duplicate inputs
        const uniqueSources = [...new Set(editList.map(c => c.src))];
        const sourceIndex = {};
        uniqueSources.forEach((src, i) => { sourceIndex[src] = i; });

        // Build FFmpeg args
        const args = [];

        // Input files
        for (const src of uniqueSources) {
            args.push('-i', src);
        }
        // Voiceover as last input
        const voiceIdx = uniqueSources.length;
        args.push('-i', voiceoverPath);

        // Build filter_complex
        const filterParts = [];
        const concatInputs = [];

        for (let i = 0; i < editList.length; i++) {
            const clip = editList[i];
            const srcIdx = sourceIndex[clip.src];
            // Trim + scale each clip to consistent 1080x1920 (9:16)
            filterParts.push(
                `[${srcIdx}:v]trim=start=${clip.ss}:duration=${clip.duration},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`
            );
            concatInputs.push(`[v${i}]`);
        }

        // Concat all video segments
        filterParts.push(
            `${concatInputs.join('')}concat=n=${editList.length}:v=1:a=0[outv]`
        );

        args.push('-filter_complex', filterParts.join(';'));
        args.push('-map', '[outv]');
        args.push('-map', `${voiceIdx}:a`);
        args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28');
        args.push('-c:a', 'aac', '-b:a', '128k');
        args.push('-shortest');
        args.push('-movflags', '+faststart');
        args.push('-y', outputPath);

        console.log(`  FFmpeg: ${uniqueSources.length} source clips, ${editList.length} segments`);
        await this.ffmpeg(args);
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
                timeout: 600000, // 10 min timeout for full assembly
                maxBuffer: 10 * 1024 * 1024
            });
            return { stdout, stderr };
        } catch (error) {
            if (error.code) {
                console.error('FFmpeg error:', error.stderr?.substring(0, 800));
                throw new Error('FFmpeg failed: ' + (error.stderr?.substring(0, 300) || error.message));
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
