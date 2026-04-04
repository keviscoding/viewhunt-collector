/**
 * Seedance 2.0 Video Generator — Kie.ai API
 * Text-to-Video and Image-to-Video using bytedance/seedance-2
 * 480p for fast + cheap generation
 *
 * Local uploads are re-uploaded to Kie.ai as assets before generation,
 * since Kie.ai can't access files on our server directly.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

class Seedance2Generator {
    constructor() {
        this.kieApiKey = process.env.KIEAI_API_KEY;
        this.kieBaseUrl = 'https://api.kie.ai';
        this.uploadDir = path.join(__dirname, '../../../public/studio/uploads/seedance');
    }

    /**
     * Resize a video so width*height ≤ maxPixels (927408 for Seedance 2 ref videos).
     * Returns path to resized file (or original if already small enough).
     */
    async resizeVideoIfNeeded(filePath, maxPixels) {
        maxPixels = maxPixels || 927408;
        try {
            var probe = await execFileAsync(ffprobePath, [
                '-v', 'quiet', '-select_streams', 'v:0',
                '-show_entries', 'stream=width,height',
                '-of', 'json', filePath
            ]);
            var info = JSON.parse(probe.stdout);
            var w = info.streams?.[0]?.width || 0;
            var h = info.streams?.[0]?.height || 0;
            var pixels = w * h;

            if (pixels <= maxPixels || pixels === 0) return filePath; // already fine

            // Calculate scale factor to fit within maxPixels
            var scale = Math.sqrt(maxPixels / pixels);
            var newW = Math.floor(w * scale / 2) * 2; // ensure even
            var newH = Math.floor(h * scale / 2) * 2;
            console.log('  Resizing ref video: ' + w + 'x' + h + ' (' + pixels + 'px) → ' + newW + 'x' + newH + ' (' + (newW * newH) + 'px)');

            var resizedPath = filePath.replace(/(\.\w+)$/, '-resized$1');
            await execFileAsync(ffmpegPath, [
                '-i', filePath,
                '-vf', 'scale=' + newW + ':' + newH,
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                '-c:a', 'copy', '-threads', '1', '-y', resizedPath
            ], { timeout: 120000 });

            return resizedPath;
        } catch (err) {
            console.warn('  Video resize check failed:', err.message);
            return filePath; // fallback to original
        }
    }

    /**
     * Upload a local file to Kie.ai's file hosting.
     * Returns a publicly accessible URL that Kie.ai can use.
     */
    async uploadAsset(localUrl) {
        var filename = localUrl.split('/').pop();
        var filePath = path.join(this.uploadDir, filename);

        if (!fs.existsSync(filePath)) {
            console.warn('  Asset file not found locally: ' + filePath);
            return localUrl;
        }

        // Resize video if it exceeds Seedance 2 pixel limit
        var ext = path.extname(filename).toLowerCase();
        var isVideo = ['.mp4', '.mov', '.webm', '.avi'].indexOf(ext) >= 0;
        var uploadPath = filePath;
        if (isVideo) {
            uploadPath = await this.resizeVideoIfNeeded(filePath, 927408);
        }

        console.log('  Uploading to Kie.ai file hosting: ' + path.basename(uploadPath));
        var form = new FormData();
        form.append('file', fs.createReadStream(uploadPath));
        form.append('uploadPath', 'seedance-uploads');
        form.append('fileName', path.basename(uploadPath));

        try {
            var res = await axios.post(
                'https://kieai.redpandaai.co/api/file-stream-upload',
                form,
                {
                    headers: {
                        ...form.getHeaders(),
                        'Authorization': 'Bearer ' + this.kieApiKey
                    },
                    timeout: 120000,
                    maxContentLength: 60 * 1024 * 1024
                }
            );

            if (res.data.success && res.data.data?.downloadUrl) {
                console.log('  ✅ File uploaded: ' + res.data.data.downloadUrl.substring(0, 80));
                return res.data.data.downloadUrl;
            }
            console.warn('  File upload response unexpected:', JSON.stringify(res.data).substring(0, 300));
            return localUrl;
        } catch (err) {
            console.error('  File upload failed:', err.message);
            return localUrl;
        }
    }

    /**
     * Resolve a URL — if it's a local upload path, upload to Kie.ai as asset.
     * External URLs (https://) are passed through as-is.
     */
    async resolveUrl(url) {
        if (!url) return null;
        // Local upload paths start with /studio/uploads/
        if (url.startsWith('/studio/uploads/')) {
            return await this.uploadAsset(url);
        }
        // Already an asset:// or external https:// URL
        return url;
    }

    async resolveUrls(urls) {
        if (!urls || urls.length === 0) return [];
        var resolved = [];
        for (var i = 0; i < urls.length; i++) {
            var r = await this.resolveUrl(urls[i]);
            if (r) resolved.push(r);
        }
        return resolved;
    }

    /**
     * Generate a video from text prompt and optional media inputs
     */
    async generate(options) {
        var prompt = options.prompt;
        var duration = options.duration || 8;
        var aspectRatio = options.aspectRatio || '9:16';
        var generateAudio = options.generateAudio !== false;

        if ([4, 8, 12].indexOf(duration) === -1) duration = 8;

        console.log('🎬 Seedance 2.0: Generating ' + duration + 's video at 480p (' + aspectRatio + ')');

        // Resolve all URLs — upload local files to Kie.ai as assets
        var firstFrameUrl = await this.resolveUrl(options.firstFrameUrl);
        var lastFrameUrl = await this.resolveUrl(options.lastFrameUrl);
        var referenceImageUrls = await this.resolveUrls(options.referenceImageUrls);
        var referenceVideoUrls = await this.resolveUrls(options.referenceVideoUrls);
        var referenceAudioUrls = await this.resolveUrls(options.referenceAudioUrls);

        if (firstFrameUrl) console.log('  First frame: ' + firstFrameUrl.substring(0, 80));
        if (referenceImageUrls.length) console.log('  Reference images: ' + referenceImageUrls.length);
        if (referenceVideoUrls.length) console.log('  Reference videos: ' + referenceVideoUrls.length);
        if (referenceAudioUrls.length) console.log('  Reference audio: ' + referenceAudioUrls.length);

        var input = {
            prompt: prompt,
            resolution: '480p',
            aspect_ratio: aspectRatio,
            duration: duration,
            generate_audio: generateAudio,
            web_search: false
        };

        if (firstFrameUrl) input.first_frame_url = firstFrameUrl;
        if (lastFrameUrl) input.last_frame_url = lastFrameUrl;
        if (referenceImageUrls.length > 0) input.reference_image_urls = referenceImageUrls.slice(0, 9);
        if (referenceVideoUrls.length > 0) input.reference_video_urls = referenceVideoUrls.slice(0, 3);
        if (referenceAudioUrls.length > 0) input.reference_audio_urls = referenceAudioUrls.slice(0, 3);

        // Create task
        var createResponse = await axios.post(
            this.kieBaseUrl + '/api/v1/jobs/createTask',
            { model: 'bytedance/seedance-2', input: input },
            {
                headers: {
                    'Authorization': 'Bearer ' + this.kieApiKey,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        var respData = createResponse.data;
        if (respData.code !== 200 || !respData.data?.taskId) {
            var msg = respData.msg || 'Unknown error';
            console.error('  Seedance 2 createTask failed: ' + msg);
            if (respData.code === 402) throw new Error('Out of Kie.ai credits.');
            throw new Error('Seedance 2 failed: ' + msg);
        }

        var taskId = respData.data.taskId;
        console.log('  Seedance 2 task created: ' + taskId);

        var videoUrl = await this.pollTask(taskId);
        console.log('✅ Seedance 2 video generated: ' + videoUrl.substring(0, 80) + '...');
        return { videoUrl: videoUrl, taskId: taskId };
    }

    async pollTask(taskId, timeout) {
        timeout = timeout || 600000;
        var startTime = Date.now();
        var pollInterval = 5000;
        var pollCount = 0;

        while (Date.now() - startTime < timeout) {
            pollCount++;
            try {
                var response = await axios.get(
                    this.kieBaseUrl + '/api/v1/jobs/recordInfo',
                    {
                        params: { taskId: taskId },
                        headers: { 'Authorization': 'Bearer ' + this.kieApiKey }
                    }
                );

                if (response.data.code !== 200) {
                    throw new Error('Kie.ai API error: ' + response.data.msg);
                }

                var state = response.data.data.state;
                if (pollCount % 6 === 0) {
                    var elapsed = Math.floor((Date.now() - startTime) / 1000);
                    console.log('  Seedance 2 task ' + taskId + ': ' + state + ' (' + elapsed + 's)');
                }

                if (state === 'success') {
                    var resultJson = JSON.parse(response.data.data.resultJson);
                    var urls = resultJson.resultUrls || resultJson.videoUrls || [];
                    if (urls.length === 0) throw new Error('Seedance 2 returned success but no video URLs');
                    return urls[0];
                }

                if (state === 'fail') {
                    throw new Error('Seedance 2 generation failed: ' + (response.data.data.failMsg || 'Unknown'));
                }

                await new Promise(function(resolve) { setTimeout(resolve, pollInterval); });
            } catch (error) {
                if (error.response?.status === 401) throw new Error('Kie.ai auth failed.');
                if (error.response?.status === 402) throw new Error('Out of Kie.ai credits.');
                if (error.message.includes('Seedance') || error.message.includes('Kie.ai')) throw error;
                await new Promise(function(resolve) { setTimeout(resolve, pollInterval); });
            }
        }
        throw new Error('Seedance 2 task timeout after ' + Math.floor(timeout / 1000) + 's');
    }
}

module.exports = Seedance2Generator;
