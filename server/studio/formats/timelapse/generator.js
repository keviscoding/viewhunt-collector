/**
 * Timelapse Generator — "Surreal Time-Lapse Construction" format
 * 
 * Pipeline:
 *   1. Gemini generates 4 stage image prompts from user concept
 *   2. Nano-banana-2 generates images (each uses previous as reference)
 *   3. Wan-2.1 FLF2V (fal.ai) generates 3 transition videos (start+end frame)
 *   4. FFmpeg stitches 3 clips into final video
 * 
 * Credits: ~19 total (4 images × 0.5 = 2, 3 videos × 5 = 15, assembly = 2)
 */
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

class TimelapseGenerator {
    constructor() {
        this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        this.kieApiKey = process.env.KIEAI_API_KEY;
        this.kieBaseUrl = 'https://api.kie.ai';
        this.falApiKey = process.env.FAL_API_KEY;
        this.falBaseUrl = 'https://queue.fal.run';
        this.outputDir = path.join(__dirname, '../../../public/studio/generated/timelapse');
        if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });
    }

    /**
     * Step 1: Generate 4 stage prompts + 3 transition prompts using Gemini
     */
    async generateStagePrompts(concept) {
        console.log('🧠 Timelapse: Generating stage prompts with Gemini...');

        const systemPrompt = `You are an expert AI image prompt engineer specializing in surreal time-lapse construction videos.

Your job: Given a user's concept, generate 4 chronological image prompts representing the 4 stages of a construction/transformation time-lapse, plus 3 video transition prompts.

THE 4 STAGES (always in this order):
1. THE PRISTINE STATE & THE CUT — The untouched environment. The protagonist approaches and makes the first cut/mark.
2. THE EXCAVATION — The protagonist removes material, revealing a void or clearing space.
3. THE STRUCTURAL BUILD — The protagonist adds structure: framing, flooring, walls, plumbing, etc.
4. THE COZY FINISH / REVEAL — The space is furnished, lit, and livable. The protagonist relaxes in the finished space.

THE GOLDEN RULE:
- Character description (clothing, body type, appearance) must be IDENTICAL in ALL 4 prompts
- Camera angle must be IDENTICAL (static tripod, same position)
- Lighting conditions must be IDENTICAL (same time of day, same light source)
- Background environment must be IDENTICAL (same surroundings)
- ONLY the construction state changes between stages

CRITICAL PROMPT RULES:
- Every prompt must be fully self-contained (no references to "previous" or "next")
- Include the FULL character description in EVERY prompt
- Include the FULL camera/environment description in EVERY prompt
- Format: 9:16 vertical, hyper-realistic photography style
- The character should be actively doing something in each stage (not just standing)

VIDEO TRANSITION PROMPTS:
- Describe the fast-paced time-lapse ACTION between two stages
- Include: tools being used, materials flying, debris being removed, items being placed
- Always mention "time-lapse speed" or "sped-up construction footage"
- Keep the same character and camera descriptions

IMPORTANT: Be holistic. The concept could be ANYTHING — building inside a tree, carving a room in concrete, renovating a van, creating a garden in a rooftop, etc. Adapt the 4 stages to fit whatever the user describes.

Return JSON:
{
  "title": "Short catchy title for the video",
  "character": "Full character description used in all prompts",
  "environment": "Full environment/camera description used in all prompts",
  "stages": [
    {
      "stage": 1,
      "name": "The Pristine State & The Cut",
      "imagePrompt": "Full self-contained image prompt...",
      "description": "Brief description of what this stage shows"
    },
    {
      "stage": 2,
      "name": "The Excavation",
      "imagePrompt": "Full self-contained image prompt...",
      "description": "..."
    },
    {
      "stage": 3,
      "name": "The Structural Build",
      "imagePrompt": "Full self-contained image prompt...",
      "description": "..."
    },
    {
      "stage": 4,
      "name": "The Cozy Finish",
      "imagePrompt": "Full self-contained image prompt...",
      "description": "..."
    }
  ],
  "transitions": [
    {
      "from": 1,
      "to": 2,
      "videoPrompt": "Time-lapse transition prompt describing the action..."
    },
    {
      "from": 2,
      "to": 3,
      "videoPrompt": "..."
    },
    {
      "from": 3,
      "to": 4,
      "videoPrompt": "..."
    }
  ]
}`;

        const userPrompt = `Generate the 4-stage time-lapse construction prompts for this concept:

${concept}

Remember: Lock the character, camera, lighting, and background across ALL prompts. Only the construction state changes.`;

        try {
            const response = await this.ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [{ parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }],
                config: { responseMimeType: 'application/json' }
            });

            const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error('Empty response from Gemini');

            let jsonText = text;
            if (text.includes('```json')) {
                const m = text.match(/```json\s*([\s\S]*?)\s*```/);
                if (m) jsonText = m[1];
            } else if (text.includes('```')) {
                const m = text.match(/```\s*([\s\S]*?)\s*```/);
                if (m) jsonText = m[1];
            }

            const data = JSON.parse(jsonText.trim());
            if (!data.stages || data.stages.length !== 4) {
                throw new Error('Expected exactly 4 stages, got ' + (data.stages?.length || 0));
            }
            if (!data.transitions || data.transitions.length !== 3) {
                throw new Error('Expected exactly 3 transitions, got ' + (data.transitions?.length || 0));
            }

            console.log(`✅ Generated prompts: "${data.title}"`);
            return data;
        } catch (error) {
            console.error('Gemini prompt generation error:', error.message);
            throw new Error('Failed to generate stage prompts: ' + error.message);
        }
    }

    /**
     * Step 2: Generate image with nano-banana-2
     * @param {string} imagePrompt - The image prompt
     * @param {number} stageNumber - 1-4
     * @param {string|null} referenceImageUrl - Previous stage image URL for consistency
     */
    async generateImage(imagePrompt, stageNumber, referenceImageUrl) {
        console.log(`🖼️ Timelapse: Generating image for stage ${stageNumber}...`);
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`  Kie.ai nano-banana-2 - Stage ${stageNumber} (attempt ${attempt}/${maxRetries})`);

                const input = {
                    prompt: imagePrompt,
                    image_input: referenceImageUrl ? [referenceImageUrl] : [],
                    aspect_ratio: '9:16',
                    resolution: '1K',
                    output_format: 'png'
                };

                const createResponse = await axios.post(
                    `${this.kieBaseUrl}/api/v1/jobs/createTask`,
                    { model: 'nano-banana-2', input },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${this.kieApiKey}`
                        },
                        timeout: 30000
                    }
                );

                const respData = createResponse.data;
                const taskId = respData?.data?.taskId;

                if (!taskId) {
                    const code = respData?.code || respData?.status;
                    const msg = respData?.msg || respData?.message || '';
                    if (code === 402 || msg.toLowerCase().includes('credit') || msg.toLowerCase().includes('quota')) {
                        throw new Error('Out of Kie.ai credits.');
                    }
                    if (attempt < maxRetries) {
                        await new Promise(r => setTimeout(r, attempt * 3000));
                        continue;
                    }
                    throw new Error(`Kie.ai image failed after ${maxRetries} attempts`);
                }

                console.log(`  Task created: ${taskId}`);
                const imageUrl = await this.pollKieTask(taskId, 'image');
                console.log(`✅ Stage ${stageNumber} image generated`);
                return imageUrl;

            } catch (error) {
                if (error.message.includes('credit') || error.message.includes('quota')) throw error;
                const status = error.response?.status;
                const isRetryable = !status || status >= 500 || status === 429 || error.code === 'ECONNABORTED';
                if (isRetryable && attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, attempt * 3000));
                    continue;
                }
                throw error;
            }
        }
    }

    /**
     * Step 3: Generate transition video using fal.ai Wan-2.1 FLF2V
     * Takes start frame (stage N) and end frame (stage N+1) and interpolates
     */
    async generateTransitionVideo(startImageUrl, endImageUrl, videoPrompt, transitionNumber) {
        console.log(`🎬 Timelapse: Generating transition ${transitionNumber} video (fal.ai Wan-2.1 FLF2V)...`);
        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`  fal.ai Wan FLF2V - Transition ${transitionNumber} (attempt ${attempt}/${maxRetries})`);

                // Submit to fal.ai queue
                const submitResponse = await axios.post(
                    `${this.falBaseUrl}/fal-ai/wan-flf2v`,
                    {
                        prompt: videoPrompt,
                        start_image_url: startImageUrl,
                        end_image_url: endImageUrl,
                        num_frames: 81,
                        frames_per_second: 16,
                        resolution: '720p',
                        aspect_ratio: '9:16',
                        enable_prompt_expansion: false,
                        acceleration: 'regular'
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Key ${this.falApiKey}`
                        },
                        timeout: 30000
                    }
                );

                const requestId = submitResponse.data?.request_id;
                if (!requestId) {
                    console.warn(`  No request_id (attempt ${attempt}). Response: ${JSON.stringify(submitResponse.data).substring(0, 300)}`);
                    if (attempt < maxRetries) {
                        await new Promise(r => setTimeout(r, attempt * 3000));
                        continue;
                    }
                    throw new Error('fal.ai failed to create video task');
                }

                console.log(`  fal.ai request submitted: ${requestId}`);
                const videoUrl = await this.pollFalTask(requestId);
                console.log(`✅ Transition ${transitionNumber} video generated`);
                return videoUrl;

            } catch (error) {
                if (error.message.includes('credit') || error.message.includes('balance') || error.message.includes('authentication')) {
                    throw error;
                }
                const status = error.response?.status;
                const isRetryable = !status || status >= 500 || status === 429 || error.code === 'ECONNABORTED';
                if (isRetryable && attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, attempt * 3000));
                    continue;
                }
                throw error;
            }
        }
    }

    /**
     * Poll fal.ai queue for result
     */
    async pollFalTask(requestId, timeout = 600000) {
        const startTime = Date.now();
        const pollInterval = 5000;
        let pollCount = 0;

        while (Date.now() - startTime < timeout) {
            pollCount++;
            const elapsed = Math.floor((Date.now() - startTime) / 1000);

            try {
                const response = await axios.get(
                    `${this.falBaseUrl}/fal-ai/wan-flf2v/requests/${requestId}/status`,
                    {
                        headers: { 'Authorization': `Key ${this.falApiKey}` },
                        timeout: 15000
                    }
                );

                const status = response.data?.status;

                if (pollCount % 6 === 0) {
                    console.log(`  fal.ai task ${requestId}: ${status} (${elapsed}s)`);
                }

                if (status === 'COMPLETED') {
                    // Fetch the result
                    const resultResponse = await axios.get(
                        `${this.falBaseUrl}/fal-ai/wan-flf2v/requests/${requestId}`,
                        {
                            headers: { 'Authorization': `Key ${this.falApiKey}` },
                            timeout: 15000
                        }
                    );
                    const videoUrl = resultResponse.data?.video?.url;
                    if (!videoUrl) throw new Error('fal.ai returned success but no video URL');
                    console.log(`  fal.ai task completed in ${elapsed}s`);
                    return videoUrl;
                }

                if (status === 'FAILED') {
                    const error = response.data?.error || 'Unknown error';
                    throw new Error(`fal.ai video generation failed: ${error}`);
                }

                // IN_QUEUE or IN_PROGRESS — keep polling
                await new Promise(resolve => setTimeout(resolve, pollInterval));

            } catch (error) {
                if (error.response?.status === 401) {
                    throw new Error('fal.ai authentication failed. Check FAL_API_KEY.');
                }
                if (error.message.includes('fal.ai')) throw error;
                console.error('  fal.ai polling error:', error.message);
                await new Promise(resolve => setTimeout(resolve, pollInterval));
            }
        }

        throw new Error(`fal.ai video task timeout after ${Math.floor(timeout / 1000)}s`);
    }

    /**
     * Poll Kie.ai task for image result
     */
    async pollKieTask(taskId, type = 'image', timeout = 600000) {
        const startTime = Date.now();
        const pollInterval = 5000;
        let pollCount = 0;

        while (Date.now() - startTime < timeout) {
            pollCount++;
            const elapsed = Math.floor((Date.now() - startTime) / 1000);

            try {
                const response = await axios.get(
                    `${this.kieBaseUrl}/api/v1/jobs/recordInfo`,
                    {
                        params: { taskId },
                        headers: { 'Authorization': `Bearer ${this.kieApiKey}` }
                    }
                );

                if (response.data.code !== 200) {
                    throw new Error(`Kie.ai API error: ${response.data.msg}`);
                }

                const state = response.data.data.state;

                if (pollCount % 6 === 0) {
                    console.log(`  Kie.ai ${type} task ${taskId}: ${state} (${elapsed}s)`);
                }

                if (state === 'success') {
                    const resultJson = JSON.parse(response.data.data.resultJson);
                    const urls = resultJson.resultUrls || resultJson.videoUrls || [];
                    if (urls.length === 0) throw new Error(`Kie.ai returned success but no ${type} URLs`);
                    console.log(`  Kie.ai ${type} task completed in ${elapsed}s`);
                    return urls[0];
                }

                if (state === 'fail') {
                    const msg = response.data.data.failMsg || 'Unknown error';
                    throw new Error(`Kie.ai ${type} generation failed: ${msg}`);
                }

                await new Promise(resolve => setTimeout(resolve, pollInterval));

            } catch (error) {
                if (error.response?.status === 401) throw new Error('Kie.ai auth failed.');
                if (error.response?.status === 402) throw new Error('Out of Kie.ai credits.');
                if (error.response?.status === 429) {
                    await new Promise(resolve => setTimeout(resolve, 10000));
                } else if (error.message.includes('Kie.ai') || error.message.includes('failed')) {
                    throw error;
                } else {
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                }
            }
        }

        throw new Error(`Kie.ai ${type} task timeout after ${Math.floor(timeout / 1000)}s`);
    }

    /**
     * Step 4: Assemble 3 transition clips into final video
     */
    async assembleVideo(videoUrls) {
        console.log('🎬 Timelapse: Assembling final video from ' + videoUrls.length + ' clips...');

        const timestamp = Date.now();
        const tempDir = path.join(this.outputDir, 'temp_' + timestamp);
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        try {
            // Download all clips
            const clipPaths = [];
            for (let i = 0; i < videoUrls.length; i++) {
                const clipPath = path.join(tempDir, 'clip_' + (i + 1) + '.mp4');
                const response = await axios.get(videoUrls[i], { responseType: 'arraybuffer', timeout: 60000 });
                fs.writeFileSync(clipPath, Buffer.from(response.data));
                clipPaths.push(clipPath);
                console.log(`  Downloaded clip ${i + 1}/${videoUrls.length}`);
            }

            // Normalize clips to consistent format
            const normalizedPaths = [];
            for (let i = 0; i < clipPaths.length; i++) {
                const normPath = path.join(tempDir, 'norm_' + (i + 1) + '.mp4');
                await this._runFFmpeg([
                    '-i', clipPaths[i],
                    '-vf', 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1',
                    '-r', '30', '-ar', '44100', '-ac', '2',
                    '-c:a', 'aac', '-b:a', '128k',
                    '-y', normPath
                ]);
                normalizedPaths.push(normPath);
            }

            // Create concat file
            const concatFile = path.join(tempDir, 'concat.txt');
            const concatContent = normalizedPaths.map(p => "file '" + p + "'").join('\n');
            fs.writeFileSync(concatFile, concatContent);

            // Concatenate
            const outputPath = path.join(this.outputDir, 'timelapse_' + timestamp + '.mp4');
            await this._runFFmpeg([
                '-f', 'concat', '-safe', '0', '-i', concatFile,
                '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1',
                '-c:a', 'aac', '-b:a', '128k',
                '-movflags', '+faststart',
                '-y', outputPath
            ]);

            // Cleanup temp
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (e) { /* ignore */ }

            const publicPath = '/studio/generated/timelapse/timelapse_' + timestamp + '.mp4';
            console.log('✅ Final video assembled: ' + publicPath);
            return publicPath;

        } catch (error) {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
            throw new Error('Assembly failed: ' + error.message);
        }
    }

    _runFFmpeg(args) {
        return new Promise((resolve, reject) => {
            const proc = execFile(ffmpegPath, args, { timeout: 300000 });
            let stderr = '';
            proc.stderr.on('data', d => { stderr += d; });
            proc.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error('FFmpeg exit ' + code + ': ' + stderr.slice(-500)));
            });
            proc.on('error', reject);
        });
    }
}

module.exports = TimelapseGenerator;
