/**
 * Video Editor — Assembles final video from scene clips using FFmpeg
 * 
 * Pipeline:
 * 1. Download all scene video clips to temp dir
 * 2. Build hook sequence (rapid 0.4-0.5s clips with click sounds)
 * 3. Build body sequence (scene clips matched to sentences)
 * 4. Overlay voiceover audio
 * 5. Add one-word captions
 * 6. Export final 9:16 vertical video
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ensureClickSound = require('./assets/ensure-click');

class VideoEditor {
    constructor() {
        this.tempDir = path.join(__dirname, '../../public/studio/generated/temp');
        this.outputDir = path.join(__dirname, '../../public/studio/generated/final');
        this.clickSound = ensureClickSound(); // generates on first run

        for (const dir of [this.tempDir, this.outputDir]) {
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * Main assembly function
     * @param {Object} edl - Edit decision list from GeminiAnalyzer
     * @param {Array} scenes - Scene objects with videoUrl
     * @param {string} voiceoverPath - Path to voiceover WAV
     * @param {Object} options - { addCaptions: true }
     * @returns {Object} { videoPath, videoUrl, duration }
     */
    async assemble(edl, scenes, voiceoverPath, options = {}) {
        const jobId = `edit-${Date.now()}`;
        const jobDir = path.join(this.tempDir, jobId);
        fs.mkdirSync(jobDir, { recursive: true });

        console.log(`\n🎬 Video Editor: Starting assembly (job: ${jobId})`);

        try {
            // Step 1: Download all scene clips
            console.log('📥 Step 1: Downloading scene clips...');
            const clipPaths = await this.downloadClips(scenes, jobDir);

            // Step 2: Get voiceover duration (this determines total video length)
            const voiceDuration = await this.getMediaDuration(voiceoverPath);
            console.log(`🎙️ Voiceover duration: ${voiceDuration.toFixed(1)}s`);

            // Step 3: Build the hook segment
            console.log('⚡ Step 2: Building hook sequence...');
            const hookPath = await this.buildHook(edl.hook, clipPaths, jobDir);

            // Step 4: Build body segments
            console.log('🎞️ Step 3: Building body sequence...');
            const bodyPath = await this.buildBody(edl, clipPaths, voiceDuration, jobDir);

            // Step 5: Concatenate hook + body
            console.log('🔗 Step 4: Concatenating hook + body...');
            const rawVideoPath = path.join(jobDir, 'raw-combined.mp4');
            await this.concatenateVideos([hookPath, bodyPath], rawVideoPath);

            // Step 6: Overlay voiceover
            console.log('🎙️ Step 5: Adding voiceover...');
            const withAudioPath = path.join(jobDir, 'with-audio.mp4');
            await this.overlayAudio(rawVideoPath, voiceoverPath, withAudioPath);

            // Step 7: Add captions if requested
            let finalPath;
            if (options.addCaptions !== false && edl.sentences) {
                console.log('📝 Step 6: Adding captions...');
                finalPath = path.join(this.outputDir, `${jobId}.mp4`);
                await this.addCaptions(withAudioPath, edl, voiceoverPath, finalPath);
            } else {
                finalPath = path.join(this.outputDir, `${jobId}.mp4`);
                fs.copyFileSync(withAudioPath, finalPath);
            }

            // Get final duration
            const finalDuration = await this.getMediaDuration(finalPath);

            // Cleanup temp files
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
     * Download scene video clips to local temp directory
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
                        // Local file
                        const localPath = path.join(__dirname, '../../public', url);
                        fs.copyFileSync(localPath, clipPath);
                    } else {
                        // Remote URL
                        const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
                        fs.writeFileSync(clipPath, resp.data);
                    }
                    clipPaths[num] = clipPath;
                    console.log(`  ✓ Scene ${num} downloaded`);
                } catch (err) {
                    console.warn(`  ✗ Scene ${num} download failed: ${err.message}`);
                }
            });

        await Promise.all(downloads);
        console.log(`  ${Object.keys(clipPaths).length}/${scenes.length} clips ready`);
        return clipPaths;
    }

    /**
     * Build the hook sequence — rapid-fire 0.4-0.5s clips with click sounds
     */
    async buildHook(hookEdl, clipPaths, jobDir) {
        const hookClips = [];

        for (let i = 0; i < hookEdl.clips.length; i++) {
            const clip = hookEdl.clips[i];
            const srcPath = clipPaths[clip.scene];
            if (!srcPath) {
                console.warn(`  Hook clip: scene ${clip.scene} not available, skipping`);
                continue;
            }

            const clipOut = path.join(jobDir, `hook-clip-${i}.mp4`);
            const startSec = clip.startSec || 0;
            const duration = clip.duration || 0.5;

            // Trim the clip
            await this.ffmpeg([
                '-i', srcPath,
                '-ss', String(startSec),
                '-t', String(duration),
                '-c:v', 'libx264', '-preset', 'fast',
                '-an',  // no audio for hook clips (voiceover goes on top)
                '-y', clipOut
            ]);

            // Add click sound if specified
            if (clip.clickSound && fs.existsSync(this.clickSound)) {
                const withClick = path.join(jobDir, `hook-clip-${i}-click.mp4`);
                await this.ffmpeg([
                    '-i', clipOut,
                    '-i', this.clickSound,
                    '-filter_complex', '[1:a]atrim=0:0.3,asetpts=PTS-STARTPTS[click];[click]volume=0.7[a]',
                    '-map', '0:v', '-map', '[a]',
                    '-c:v', 'copy', '-c:a', 'aac', '-shortest',
                    '-y', withClick
                ]);
                fs.unlinkSync(clipOut);
                fs.renameSync(withClick, clipOut);
            }

            hookClips.push(clipOut);
        }

        if (hookClips.length === 0) {
            throw new Error('No hook clips could be built');
        }

        // Concatenate hook clips
        const hookPath = path.join(jobDir, 'hook.mp4');
        await this.concatenateVideos(hookClips, hookPath);

        const hookDur = await this.getMediaDuration(hookPath);
        console.log(`  Hook: ${hookClips.length} clips, ${hookDur.toFixed(1)}s`);

        return hookPath;
    }

    /**
     * Build the body sequence — scene clips matched to sentences
     */
    async buildBody(edl, clipPaths, totalVoiceDuration, jobDir) {
        const bodySegments = edl.body;
        if (!bodySegments || bodySegments.length === 0) {
            throw new Error('No body segments in EDL');
        }

        // Calculate hook duration to know how much time body needs
        const hookClipsDuration = edl.hook.clips.reduce((sum, c) => sum + (c.duration || 0.5), 0);
        const bodyDuration = totalVoiceDuration - hookClipsDuration;
        const perSegmentDuration = bodyDuration / bodySegments.length;

        const bodyClips = [];

        for (let i = 0; i < bodySegments.length; i++) {
            const seg = bodySegments[i];
            const srcPath = clipPaths[seg.scene];

            if (!srcPath) {
                console.warn(`  Body segment ${i}: scene ${seg.scene} not available, skipping`);
                continue;
            }

            const clipOut = path.join(jobDir, `body-clip-${i}.mp4`);
            const startSec = seg.startSec || 0;
            const segDuration = Math.min(perSegmentDuration, 5); // clips are max 5s

            // Trim clip to segment duration
            await this.ffmpeg([
                '-i', srcPath,
                '-ss', String(startSec),
                '-t', String(segDuration),
                '-c:v', 'libx264', '-preset', 'fast',
                '-an',
                '-y', clipOut
            ]);

            // Add click sound on some transitions
            if (seg.clickSound && i > 0 && fs.existsSync(this.clickSound)) {
                const withClick = path.join(jobDir, `body-clip-${i}-click.mp4`);
                await this.ffmpeg([
                    '-i', clipOut,
                    '-i', this.clickSound,
                    '-filter_complex', '[1:a]atrim=0:0.2,asetpts=PTS-STARTPTS[click];[click]volume=0.5[a]',
                    '-map', '0:v', '-map', '[a]',
                    '-c:v', 'copy', '-c:a', 'aac', '-shortest',
                    '-y', withClick
                ]);
                fs.unlinkSync(clipOut);
                fs.renameSync(withClick, clipOut);
            }

            bodyClips.push(clipOut);
        }

        if (bodyClips.length === 0) {
            throw new Error('No body clips could be built');
        }

        const bodyPath = path.join(jobDir, 'body.mp4');
        await this.concatenateVideos(bodyClips, bodyPath);

        const bodyDur = await this.getMediaDuration(bodyPath);
        console.log(`  Body: ${bodyClips.length} segments, ${bodyDur.toFixed(1)}s`);

        return bodyPath;
    }

    /**
     * Concatenate video files using FFmpeg concat demuxer
     */
    async concatenateVideos(clipPaths, outputPath) {
        const listFile = outputPath + '.txt';
        const listContent = clipPaths.map(p => `file '${p}'`).join('\n');
        fs.writeFileSync(listFile, listContent);

        await this.ffmpeg([
            '-f', 'concat', '-safe', '0',
            '-i', listFile,
            '-c:v', 'libx264', '-preset', 'fast',
            '-c:a', 'aac',
            '-y', outputPath
        ]);

        fs.unlinkSync(listFile);
    }

    /**
     * Overlay voiceover audio on video
     */
    async overlayAudio(videoPath, audioPath, outputPath) {
        // Check if video has audio stream
        let hasAudio = false;
        try {
            const { stdout } = await execFileAsync('ffprobe', [
                '-v', 'quiet', '-select_streams', 'a',
                '-show_entries', 'stream=codec_type',
                '-of', 'csv=p=0', videoPath
            ]);
            hasAudio = stdout.trim().includes('audio');
        } catch (e) { /* no audio */ }

        if (hasAudio) {
            // Mix existing audio (click sounds) + voiceover
            await this.ffmpeg([
                '-i', videoPath,
                '-i', audioPath,
                '-filter_complex',
                '[0:a]volume=0.8[clicks];[1:a]volume=1.0[voice];[clicks][voice]amix=inputs=2:duration=longest[out]',
                '-map', '0:v', '-map', '[out]',
                '-c:v', 'copy', '-c:a', 'aac',
                '-shortest',
                '-y', outputPath
            ]);
        } else {
            // No existing audio, just add voiceover
            await this.ffmpeg([
                '-i', videoPath,
                '-i', audioPath,
                '-map', '0:v', '-map', '1:a',
                '-c:v', 'copy', '-c:a', 'aac',
                '-shortest',
                '-y', outputPath
            ]);
        }
    }

    /**
     * Add one-word captions to video
     * Uses FFmpeg drawtext filter with estimated word timing from voiceover duration
     */
    async addCaptions(videoPath, edl, voiceoverPath, outputPath) {
        // Get all words from sentences
        const allWords = edl.sentences.join(' ').split(/\s+/).filter(w => w.length > 0);
        const videoDuration = await this.getMediaDuration(videoPath);

        // Estimate timing: distribute words evenly across voiceover duration
        const wordDuration = videoDuration / allWords.length;

        // Build drawtext filter chain — one word at a time
        const filters = allWords.map((word, i) => {
            const start = (i * wordDuration).toFixed(3);
            const end = ((i + 1) * wordDuration).toFixed(3);
            // Clean word for FFmpeg (escape special chars)
            const clean = word.replace(/[\\':]/g, '').replace(/"/g, '\\"');
            return `drawtext=text='${clean}':fontsize=72:fontcolor=white:borderw=4:bordercolor=black:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:x=(w-text_w)/2:y=h*0.75:enable='between(t,${start},${end})'`;
        });

        // FFmpeg has a filter chain limit, so batch if needed
        const batchSize = 50;
        let currentInput = videoPath;

        for (let batch = 0; batch < filters.length; batch += batchSize) {
            const batchFilters = filters.slice(batch, batch + batchSize);
            const isLast = batch + batchSize >= filters.length;
            const batchOutput = isLast ? outputPath : path.join(path.dirname(outputPath), `caption-batch-${batch}.mp4`);

            await this.ffmpeg([
                '-i', currentInput,
                '-vf', batchFilters.join(','),
                '-c:v', 'libx264', '-preset', 'fast',
                '-c:a', 'copy',
                '-y', batchOutput
            ]);

            // Clean up intermediate files
            if (currentInput !== videoPath && fs.existsSync(currentInput)) {
                fs.unlinkSync(currentInput);
            }
            currentInput = batchOutput;
        }

        console.log(`  Captions: ${allWords.length} words overlaid`);
    }

    /**
     * Get media duration in seconds using ffprobe
     */
    async getMediaDuration(filePath) {
        try {
            const { stdout } = await execFileAsync('ffprobe', [
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
            const { stdout, stderr } = await execFileAsync('ffmpeg', args, {
                timeout: 300000 // 5 min timeout
            });
            return { stdout, stderr };
        } catch (error) {
            // FFmpeg outputs to stderr even on success, only throw on actual errors
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
