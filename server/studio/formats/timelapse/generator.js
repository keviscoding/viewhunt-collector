/**
 * Timelapse Generator — "Surreal Time-Lapse Construction" format
 * 
 * Pipeline:
 *   1. Gemini generates N stage image prompts (4-8) from user concept
 *   2. Nano-banana-2 generates 4 images per stage (user picks best)
 *      - Each stage after the first uses the previous selected image as reference
 *   3. Seedance 1.5 Pro (Kie.ai) generates N-1 transition videos (start+end frame)
 *   4. FFmpeg stitches clips into final video
 * 
 * Seedance cost: 720p 5s with audio = ~35 Kie.ai credits ($0.175)
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
        this.outputDir = path.join(__dirname, '../../../public/studio/generated/timelapse');
        if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });
    }

    /**
     * Step 1: Generate N stage prompts + (N-1) transition prompts using Gemini
     * @param {string} concept - User's construction concept
     * @param {number} stageCount - Number of stages (4-8)
     */
    async generateStagePrompts(concept, stageCount) {
        stageCount = Math.max(4, Math.min(8, stageCount || 4));
        console.log('🧠 Timelapse: Generating ' + stageCount + ' stage prompts with Gemini...');

        var stageExamples = '';
        if (stageCount === 4) {
            stageExamples = `Stage 1: THE ESTABLISHING SHOT — Wide exterior showing the full scale of the environment/object. The protagonist stands nearby, giving a sense of how massive it is. This is the HOOK — it must look impressive and set the scene.
Stage 2: THE FIRST MAJOR CUT — A huge opening has been carved/created. Raw interior exposed. Debris everywhere. The protagonist is deep in demolition work with heavy tools.
Stage 3: THE STRUCTURAL BUILD — Walls are paneled, floor is laid, a window or door frame is installed. The space is recognizably becoming a room. Lumber, tools, and building materials visible. Protagonist is installing something.
Stage 4: THE COZY REVEAL — Completely finished and furnished. Warm lighting, rugs, furniture, decorations, plants. Looks like a magazine photo. The protagonist relaxes in the finished space. Should look like a COMPLETELY DIFFERENT PLACE from Stage 2.`;
        } else if (stageCount === 5) {
            stageExamples = `Stage 1: THE ESTABLISHING SHOT — Wide exterior showing the full scale. The protagonist stands nearby. This is the HOOK.
Stage 2: THE FIRST MAJOR CUT — A huge opening carved out. Raw interior exposed, debris everywhere. Heavy demolition tools in use.
Stage 3: THE EXCAVATION COMPLETE — The full void is hollowed out and cleaned. Bare but spacious. The shape of the future room is clear. Protagonist measures or plans.
Stage 4: THE STRUCTURAL BUILD — Floor laid, walls paneled, window/door frames installed, electrical wires visible. Clearly becoming a livable space. Protagonist uses power tools.
Stage 5: THE COZY REVEAL — Fully furnished with warm lighting, rugs, furniture, art, plants, cozy details. Looks like a completely different world from Stage 2. Protagonist relaxes inside.`;
        } else if (stageCount === 6) {
            stageExamples = `Stage 1: THE ESTABLISHING SHOT — Wide exterior showing the full scale. This is the HOOK.
Stage 2: THE FIRST MAJOR CUT — Huge opening carved. Raw interior, debris, heavy tools.
Stage 3: THE FULL EXCAVATION — Entire void hollowed out and cleaned. Bare spacious interior. Shape of future room visible.
Stage 4: THE FOUNDATION — Subfloor framing laid, moisture barrier down, base structure built. Stacks of lumber and materials.
Stage 5: THE BUILD-OUT — Walls fully paneled, ceiling done, window installed, light fixtures mounted, plumbing visible. Recognizably a room.
Stage 6: THE COZY REVEAL — Fully furnished, decorated, warm lighting, rugs, art, plants, cozy blankets. A completely transformed space. Protagonist relaxes.`;
        } else if (stageCount === 7) {
            stageExamples = `Stage 1: THE ESTABLISHING SHOT — Wide exterior showing the full scale. This is the HOOK.
Stage 2: THE FIRST MAJOR CUT — Huge opening carved. Raw interior exposed, debris everywhere.
Stage 3: THE FULL EXCAVATION — Entire void hollowed out. Clean, bare, spacious.
Stage 4: THE FOUNDATION — Subfloor framing, moisture barrier, base structure built.
Stage 5: THE FRAMING — Wall studs up, ceiling joists in, door/window frames installed. Skeleton of a room.
Stage 6: THE FINISHING — Walls paneled/painted, floor laid, light fixtures, plumbing fixtures, shelving installed.
Stage 7: THE COZY REVEAL — Fully furnished, decorated, warm lighting, completely transformed. Protagonist relaxes.`;
        } else {
            stageExamples = `Stage 1: THE ESTABLISHING SHOT — Wide exterior showing the full scale. This is the HOOK.
Stage 2: THE FIRST MAJOR CUT — Huge opening carved. Raw interior, debris, heavy tools.
Stage 3: THE FULL EXCAVATION — Entire void hollowed out and cleaned. Bare spacious interior.
Stage 4: THE FOUNDATION — Subfloor framing, moisture barrier, base structure.
Stage 5: THE FRAMING — Wall studs, ceiling joists, door/window frames. Skeleton of a room.
Stage 6: THE UTILITIES — Electrical wiring, plumbing pipes, insulation batts installed between studs.
Stage 7: THE FINISHING — Walls paneled/painted, floor laid, fixtures mounted, shelving built.
Stage 8: THE COZY REVEAL — Fully furnished, decorated, warm lighting, plants, art, rugs. Completely transformed. Protagonist relaxes.`;
        }

        const systemPrompt = `You are an expert AI image prompt engineer specializing in surreal time-lapse construction videos.

Your job: Given a user's concept, generate exactly ${stageCount} chronological image prompts representing the stages of a construction/transformation time-lapse, plus ${stageCount - 1} video transition prompts.

THE ${stageCount} STAGES:
${stageExamples}

CRITICAL — STAGE 1 MUST BE AN ESTABLISHING SHOT:
- Stage 1 is ALWAYS a wide exterior shot showing the FULL SCALE of the environment or object
- The protagonist should be visible but small compared to the environment, showing how massive it is
- This is the HOOK — it needs to look impressive, surreal, and make viewers want to see what happens next
- Do NOT start inside or already cutting — start OUTSIDE showing the whole thing

THE GOLDEN RULE — CONSISTENCY:
- Character description (clothing, body type, appearance) must be IDENTICAL in ALL prompts
- Camera angle must be IDENTICAL (static tripod, same position) — except Stage 1 which can be slightly wider
- Lighting conditions must be IDENTICAL (same time of day, same light source)
- Background environment must be IDENTICAL (same surroundings)
- ONLY the construction state changes between stages

CRITICAL — MASSIVE VISUAL CHANGE BETWEEN STAGES:
- Each stage MUST look dramatically different from the previous one at a GLANCE
- At least 30-50% of the visible scene should be DIFFERENT between consecutive stages
- Think of it like skipping WEEKS of work between each photo — not hours
- BAD: Stage 2 = clearing debris, Stage 3 = more clearing debris (too similar)
- GOOD: Stage 2 = raw hollow carved out, Stage 3 = full wooden floor + framed walls + window installed
- The character should be doing a COMPLETELY DIFFERENT activity in each stage (different tools, different posture, different area of the space)
- New MATERIALS and OBJECTS must appear in each stage (lumber, tools, furniture, fixtures, paint, lighting)
- The SURFACES should visibly transform (raw wood → sanded → paneled → painted → decorated)
- If two stages could be confused for each other in a thumbnail, they are TOO SIMILAR — fix it
- The final stage should look like a COMPLETELY DIFFERENT PLACE from stage 2

CRITICAL PROMPT RULES:
- Every prompt must be fully self-contained (no references to "previous" or "next")
- Include the FULL character description in EVERY prompt
- Include the FULL camera/environment description in EVERY prompt
- Format: 9:16 vertical, hyper-realistic photography style
- The character should be actively doing something DIFFERENT in each stage (different tool, different position, different task)

VIDEO TRANSITION PROMPTS:
- Describe the fast-paced time-lapse ACTION between two stages
- Include: tools being used, materials flying, debris being removed, items being placed
- Always mention "time-lapse speed" or "sped-up construction footage"
- Keep the same character and camera descriptions
- MUST include: "No music. No talking. No dialogue. Only construction sounds and foley."

IMPORTANT: Be holistic. The concept could be ANYTHING — building inside a tree, carving a room in concrete, renovating a van, creating a garden on a rooftop, etc. Adapt the stages to fit whatever the user describes. Each stage must show a DRAMATIC visual transformation — imagine skipping weeks of work between each photo. The viewer should immediately see massive progress at every step.

Return JSON:
{
  "title": "Short catchy title for the video",
  "character": "Full character description used in all prompts",
  "environment": "Full environment/camera description used in all prompts",
  "stages": [
    {
      "stage": 1,
      "name": "Stage name",
      "imagePrompt": "Full self-contained image prompt...",
      "description": "Brief description of what this stage shows"
    }
  ],
  "transitions": [
    {
      "from": 1,
      "to": 2,
      "videoPrompt": "Time-lapse transition prompt... No music. No talking. No dialogue. Only construction sounds and foley."
    }
  ]
}`;

        const userPrompt = `Generate ${stageCount}-stage time-lapse construction prompts for this concept:

${concept}

Remember:
- Stage 1 = wide establishing shot showing the full scale (the HOOK)
- Lock the character, camera, lighting, and background across ALL prompts
- Each stage MUST look DRAMATICALLY different from the previous — at least 30-50% of the visible scene changes
- The character must be doing a DIFFERENT activity with DIFFERENT tools in each stage
- New materials, objects, and surfaces must appear in each stage
- If two consecutive stages could be confused in a thumbnail, they are TOO SIMILAR
- The final reveal should look like a COMPLETELY DIFFERENT PLACE from the early stages
- All video prompts must end with: "No music. No talking. No dialogue. Only construction sounds and foley."`;

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
            if (!data.stages || data.stages.length !== stageCount) {
                throw new Error('Expected ' + stageCount + ' stages, got ' + (data.stages?.length || 0));
            }
            if (!data.transitions || data.transitions.length !== stageCount - 1) {
                throw new Error('Expected ' + (stageCount - 1) + ' transitions, got ' + (data.transitions?.length || 0));
            }

            console.log('✅ Generated ' + stageCount + ' stage prompts: "' + data.title + '"');
            return data;
        } catch (error) {
            console.error('Gemini prompt generation error:', error.message);
            throw new Error('Failed to generate stage prompts: ' + error.message);
        }
    }

    /**
     * Step 2: Generate 4 image variants with nano-banana-2
     * @param {string} imagePrompt - The image prompt
     * @param {number} stageNumber - Stage number
     * @param {string|null} referenceImageUrl - Previous stage's selected image for consistency
     * @returns {string[]} Array of 4 image URLs
     */
    async generateImages(imagePrompt, stageNumber, referenceImageUrl) {
        console.log('🖼️ Timelapse: Generating 4 images for stage ' + stageNumber + '...');
        var results = [];
        var promises = [];

        for (var i = 0; i < 4; i++) {
            promises.push(this._generateSingleImage(imagePrompt, stageNumber, referenceImageUrl, i + 1));
        }

        var settled = await Promise.allSettled(promises);
        for (var j = 0; j < settled.length; j++) {
            if (settled[j].status === 'fulfilled') {
                results.push(settled[j].value);
            } else {
                console.warn('  Image ' + (j + 1) + '/4 failed: ' + settled[j].reason?.message);
                results.push(null);
            }
        }

        var successCount = results.filter(function(r) { return r !== null; }).length;
        console.log('✅ Stage ' + stageNumber + ': ' + successCount + '/4 images generated');
        return results;
    }

    async _generateSingleImage(imagePrompt, stageNumber, referenceImageUrl, variantNum) {
        var maxRetries = 3;

        for (var attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                var input = {
                    prompt: imagePrompt,
                    image_input: referenceImageUrl ? [referenceImageUrl] : [],
                    aspect_ratio: '9:16',
                    resolution: '1K',
                    output_format: 'png'
                };

                var createResponse = await axios.post(
                    this.kieBaseUrl + '/api/v1/jobs/createTask',
                    { model: 'nano-banana-2', input: input },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + this.kieApiKey
                        },
                        timeout: 30000
                    }
                );

                var respData = createResponse.data;
                var taskId = respData?.data?.taskId;

                if (!taskId) {
                    var code = respData?.code || respData?.status;
                    var msg = respData?.msg || respData?.message || '';
                    if (code === 402 || msg.toLowerCase().includes('credit') || msg.toLowerCase().includes('quota')) {
                        throw new Error('Out of Kie.ai credits.');
                    }
                    if (attempt < maxRetries) {
                        await new Promise(function(r) { setTimeout(r, attempt * 3000); });
                        continue;
                    }
                    throw new Error('Kie.ai image failed after ' + maxRetries + ' attempts');
                }

                var imageUrl = await this.pollKieTask(taskId, 'image');
                console.log('  Stage ' + stageNumber + ' variant ' + variantNum + ' done');
                return imageUrl;

            } catch (error) {
                if (error.message.includes('credit') || error.message.includes('quota')) throw error;
                var status = error.response?.status;
                var isRetryable = !status || status >= 500 || status === 429 || error.code === 'ECONNABORTED';
                if (isRetryable && attempt < maxRetries) {
                    await new Promise(function(r) { setTimeout(r, attempt * 3000); });
                    continue;
                }
                throw error;
            }
        }
    }

    /**
     * Step 3: Generate transition video using Seedance 1.5 Pro (Kie.ai)
     * Takes start frame and end frame via input_urls [start, end]
     */
    async generateTransitionVideo(startImageUrl, endImageUrl, videoPrompt, transitionNumber) {
        console.log('🎬 Timelapse: Generating transition ' + transitionNumber + ' video (Seedance 1.5 Pro)...');
        var maxRetries = 3;

        for (var attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log('  Seedance 1.5 Pro - Transition ' + transitionNumber + ' (attempt ' + attempt + '/' + maxRetries + ')');

                // Append no-music directive to prompt if not already there
                var fullPrompt = videoPrompt;
                if (fullPrompt.indexOf('No music') === -1) {
                    fullPrompt += ' No music. No talking. No dialogue. Only construction sounds and foley.';
                }

                var createResponse = await axios.post(
                    this.kieBaseUrl + '/api/v1/jobs/createTask',
                    {
                        model: 'bytedance/seedance-1.5-pro',
                        input: {
                            prompt: fullPrompt,
                            input_urls: [startImageUrl, endImageUrl],
                            aspect_ratio: '9:16',
                            resolution: '720p',
                            duration: '5',
                            fixed_lens: true,
                            generate_audio: true
                        }
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + this.kieApiKey
                        },
                        timeout: 30000
                    }
                );

                var respData = createResponse.data;
                var taskId = respData?.data?.taskId;

                if (!taskId) {
                    var code = respData?.code || respData?.status;
                    var msg = respData?.msg || respData?.message || '';
                    if (code === 402 || msg.toLowerCase().includes('credit') || msg.toLowerCase().includes('quota')) {
                        throw new Error('Out of Kie.ai credits.');
                    }
                    if (attempt < maxRetries) {
                        await new Promise(function(r) { setTimeout(r, attempt * 3000); });
                        continue;
                    }
                    throw new Error('Seedance video failed after ' + maxRetries + ' attempts');
                }

                console.log('  Seedance task created: ' + taskId);
                var videoUrl = await this.pollKieTask(taskId, 'video');
                console.log('✅ Transition ' + transitionNumber + ' video generated (Seedance 1.5 Pro)');
                return videoUrl;

            } catch (error) {
                if (error.message.includes('credit') || error.message.includes('quota') || error.message.includes('authentication')) {
                    throw error;
                }
                var status = error.response?.status;
                var isRetryable = !status || status >= 500 || status === 429 || error.code === 'ECONNABORTED';
                if (isRetryable && attempt < maxRetries) {
                    await new Promise(function(r) { setTimeout(r, attempt * 3000); });
                    continue;
                }
                throw error;
            }
        }
    }

    /**
     * Poll Kie.ai task for image or video result
     */
    async pollKieTask(taskId, type, timeout) {
        type = type || 'image';
        timeout = timeout || 600000;
        var startTime = Date.now();
        var pollInterval = 5000;
        var pollCount = 0;

        while (Date.now() - startTime < timeout) {
            pollCount++;
            var elapsed = Math.floor((Date.now() - startTime) / 1000);

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
                    console.log('  Kie.ai ' + type + ' task ' + taskId + ': ' + state + ' (' + elapsed + 's)');
                }

                if (state === 'success') {
                    var resultJson = JSON.parse(response.data.data.resultJson);
                    var urls = resultJson.resultUrls || resultJson.videoUrls || [];
                    if (urls.length === 0) throw new Error('Kie.ai returned success but no ' + type + ' URLs');
                    console.log('  Kie.ai ' + type + ' task completed in ' + elapsed + 's');
                    return urls[0];
                }

                if (state === 'fail') {
                    var failMsg = response.data.data.failMsg || 'Unknown error';
                    throw new Error('Kie.ai ' + type + ' generation failed: ' + failMsg);
                }

                await new Promise(function(resolve) { setTimeout(resolve, pollInterval); });

            } catch (error) {
                if (error.response?.status === 401) throw new Error('Kie.ai auth failed.');
                if (error.response?.status === 402) throw new Error('Out of Kie.ai credits.');
                if (error.response?.status === 429) {
                    await new Promise(function(resolve) { setTimeout(resolve, 10000); });
                } else if (error.message.includes('Kie.ai') || error.message.includes('failed')) {
                    throw error;
                } else {
                    await new Promise(function(resolve) { setTimeout(resolve, pollInterval); });
                }
            }
        }

        throw new Error('Kie.ai ' + type + ' task timeout after ' + Math.floor(timeout / 1000) + 's');
    }

    /**
     * Step 4: Assemble transition clips into final video
     */
    async assembleVideo(videoUrls) {
        console.log('🎬 Timelapse: Assembling final video from ' + videoUrls.length + ' clips...');

        var timestamp = Date.now();
        var tempDir = path.join(this.outputDir, 'temp_' + timestamp);
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        try {
            // Download all clips
            var clipPaths = [];
            for (var i = 0; i < videoUrls.length; i++) {
                var clipPath = path.join(tempDir, 'clip_' + (i + 1) + '.mp4');
                var dlResponse = await axios.get(videoUrls[i], { responseType: 'arraybuffer', timeout: 60000 });
                fs.writeFileSync(clipPath, Buffer.from(dlResponse.data));
                clipPaths.push(clipPath);
                console.log('  Downloaded clip ' + (i + 1) + '/' + videoUrls.length);
            }

            // Normalize clips
            var normalizedPaths = [];
            for (var j = 0; j < clipPaths.length; j++) {
                var normPath = path.join(tempDir, 'norm_' + (j + 1) + '.mp4');
                await this._runFFmpeg([
                    '-i', clipPaths[j],
                    '-vf', 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1',
                    '-r', '30', '-ar', '44100', '-ac', '2',
                    '-c:a', 'aac', '-b:a', '128k',
                    '-y', normPath
                ]);
                normalizedPaths.push(normPath);
            }

            // Concat
            var concatFile = path.join(tempDir, 'concat.txt');
            var concatContent = normalizedPaths.map(function(p) { return "file '" + p + "'"; }).join('\n');
            fs.writeFileSync(concatFile, concatContent);

            var outputPath = path.join(this.outputDir, 'timelapse_' + timestamp + '.mp4');
            await this._runFFmpeg([
                '-f', 'concat', '-safe', '0', '-i', concatFile,
                '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1',
                '-c:a', 'aac', '-b:a', '128k',
                '-movflags', '+faststart',
                '-y', outputPath
            ]);

            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

            var publicPath = '/studio/generated/timelapse/timelapse_' + timestamp + '.mp4';
            console.log('✅ Final video assembled: ' + publicPath);
            return publicPath;

        } catch (error) {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
            throw new Error('Assembly failed: ' + error.message);
        }
    }

    /**
     * Generate voiceover script using Gemini, in the viral short-form storytelling style
     * @param {object} promptData - The stage/transition data from prompt generation
     * @param {number} videoDuration - Total video duration in seconds
     * @returns {string} The voiceover script
     */
    async generateVoiceoverScript(promptData, videoDuration) {
        console.log('🎙️ Timelapse: Generating voiceover script with Gemini...');

        var stageDescriptions = promptData.stages.map(function(s) {
            return 'Stage ' + s.stage + ' (' + s.name + '): ' + s.description;
        }).join('\n');

        var systemPrompt = `You are a viral short-form video scriptwriter. You write voiceover scripts for TikTok/YouTube Shorts construction time-lapse videos.

WRITING STYLE — Learn from these examples of viral scripts (millions of views each):

"This little guy keeps proposing to his friend, but he always says no. So when he finally caught him in a moment where he couldn't refuse, it became the funniest thing ever."

"This Lamborghini racer needed his windshield cleaned, so he pulled over for a quick wipe. But this pit crew guy mistook it for a fuel stop and started pumping fuel into the car."

"This little driver rolled his wheels backwards just before the race started. Everyone was confused, but when he did it again, it's clear he knew exactly what he was doing."

"This little guy found an old abandoned zipline and thought it would be fun to take a ride, but he had no idea it would turn out to be one of the worst decisions of his life."

"These construction workers made an entire pallet of popcorn right on their job site. They started by heating up an excavator using two propane torches."

"This little guy is destroying a YouTube play button, but what he does with it at the end will surprise you because once it's shredded, he melts it down and pours it into this custom mold."

KEY STYLE RULES:
- Start with a hook: "This [person] decided to..." or "When this [person] started..."
- Short punchy sentences. Conversational. Like telling a friend a story.
- Build tension with "But..." and "So when..."
- Describe what's happening visually — the viewer is watching the construction
- Sound amazed/impressed by the transformation
- End with something satisfying about the final reveal
- NO hashtags, NO "subscribe", NO calls to action — this is pure narration
- The script should feel like a nature documentary narrator who's genuinely impressed

CRITICAL: The video is ${videoDuration} seconds long. At normal speaking pace (~150 words per minute), aim for roughly ${Math.round(videoDuration * 2.3)} words. It's OK to be slightly over — the audio will be speed-adjusted to fit. But don't write a novel.`;

        var userPrompt = `Write a voiceover script for this construction time-lapse video:

Title: ${promptData.title}

The video shows these stages:
${stageDescriptions}

The video is ${videoDuration} seconds of continuous time-lapse construction footage. Write the narration that plays over it. Make it engaging, punchy, and satisfying. The viewer should feel the transformation.

Return ONLY the script text, nothing else. No stage markers, no timestamps, no formatting — just the words the narrator says.`;

        try {
            var response = await this.ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [{ parts: [{ text: systemPrompt + '\n\n' + userPrompt }] }]
            });

            var script = response.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!script) throw new Error('Empty response from Gemini');

            script = script.trim().replace(/^["']|["']$/g, '');
            console.log('✅ Voiceover script generated (' + script.split(/\s+/).length + ' words)');
            return script;
        } catch (error) {
            console.error('Voiceover script generation error:', error.message);
            throw new Error('Failed to generate voiceover script: ' + error.message);
        }
    }

    /**
     * Generate TTS audio using Gemini TTS
     * @param {string} script - The voiceover script
     * @param {string} tempDir - Temp directory for output
     * @returns {string} Path to the WAV file
     */
    async generateTTS(script, tempDir) {
        console.log('🎙️ Timelapse: Generating TTS audio...');

        var ttsPrompt = 'Read in a faster pace, engaging and storytelling way:\n\n' + script;

        var response = await this.ai.models.generateContent({
            model: 'gemini-2.5-flash-preview-tts',
            contents: [{ parts: [{ text: ttsPrompt }] }],
            config: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: 'Charon' }
                    }
                }
            }
        });

        var audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!audioData) throw new Error('No audio data in Gemini TTS response');

        var pcmBuffer = Buffer.from(audioData, 'base64');

        // Write as WAV (PCM s16le, 24000Hz, mono)
        var wavPath = path.join(tempDir, 'voiceover.wav');
        var dataSize = pcmBuffer.length;
        var header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataSize, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(1, 22);
        header.writeUInt32LE(24000, 24);
        header.writeUInt32LE(24000 * 1 * 2, 28);
        header.writeUInt16LE(1 * 2, 32);
        header.writeUInt16LE(16, 34);
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);
        fs.writeFileSync(wavPath, Buffer.concat([header, pcmBuffer]));

        console.log('✅ TTS audio generated (' + (pcmBuffer.length / 1024).toFixed(0) + 'KB)');
        return wavPath;
    }

    /**
     * Get audio duration in seconds using ffprobe
     */
    async getAudioDuration(filePath) {
        return new Promise(function(resolve, reject) {
            var ffprobePath = ffmpegPath.replace('ffmpeg', 'ffprobe');
            execFile(ffprobePath, [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                filePath
            ], function(err, stdout) {
                if (err) reject(new Error('ffprobe failed: ' + err.message));
                else resolve(parseFloat(stdout.trim()) || 0);
            });
        });
    }

    /**
     * Get video duration in seconds using ffprobe
     */
    async getVideoDuration(filePath) {
        return this.getAudioDuration(filePath);
    }

    /**
     * Assemble video WITH voiceover
     * 1. Concat clips (same as assembleVideo)
     * 2. Generate voiceover script with Gemini
     * 3. Generate TTS
     * 4. Speed-adjust TTS to match video duration (atempo)
     * 5. Mix: voiceover on top, original construction audio underneath at lower volume
     */
    async assembleWithVoiceover(videoUrls, promptData) {
        console.log('🎬 Timelapse: Assembling with voiceover from ' + videoUrls.length + ' clips...');

        var timestamp = Date.now();
        var tempDir = path.join(this.outputDir, 'temp_vo_' + timestamp);
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        try {
            // Step 1: Download and normalize clips (same as regular assembly)
            var clipPaths = [];
            for (var i = 0; i < videoUrls.length; i++) {
                var clipPath = path.join(tempDir, 'clip_' + (i + 1) + '.mp4');
                var dlResponse = await axios.get(videoUrls[i], { responseType: 'arraybuffer', timeout: 60000 });
                fs.writeFileSync(clipPath, Buffer.from(dlResponse.data));
                clipPaths.push(clipPath);
                console.log('  Downloaded clip ' + (i + 1) + '/' + videoUrls.length);
            }

            var normalizedPaths = [];
            for (var j = 0; j < clipPaths.length; j++) {
                var normPath = path.join(tempDir, 'norm_' + (j + 1) + '.mp4');
                await this._runFFmpeg([
                    '-i', clipPaths[j],
                    '-vf', 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1',
                    '-r', '30', '-ar', '44100', '-ac', '2',
                    '-c:a', 'aac', '-b:a', '128k',
                    '-y', normPath
                ]);
                normalizedPaths.push(normPath);
            }

            // Step 2: Concat into silent base video
            var concatFile = path.join(tempDir, 'concat.txt');
            var concatContent = normalizedPaths.map(function(p) { return "file '" + p + "'"; }).join('\n');
            fs.writeFileSync(concatFile, concatContent);

            var baseVideoPath = path.join(tempDir, 'base.mp4');
            await this._runFFmpeg([
                '-f', 'concat', '-safe', '0', '-i', concatFile,
                '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1',
                '-c:a', 'aac', '-b:a', '128k',
                '-movflags', '+faststart',
                '-y', baseVideoPath
            ]);

            // Step 3: Get video duration
            var videoDuration = await this.getVideoDuration(baseVideoPath);
            console.log('  Base video duration: ' + videoDuration.toFixed(1) + 's');

            // Step 4: Generate voiceover script
            var script = await this.generateVoiceoverScript(promptData, Math.round(videoDuration));

            // Step 5: Generate TTS audio
            var ttsPath = await this.generateTTS(script, tempDir);
            var ttsDuration = await this.getAudioDuration(ttsPath);
            console.log('  TTS duration: ' + ttsDuration.toFixed(1) + 's vs video: ' + videoDuration.toFixed(1) + 's');

            // Step 6: Speed-adjust TTS to match video duration
            var atempo = ttsDuration / videoDuration;
            // Clamp atempo to reasonable range (0.8x to 1.5x)
            atempo = Math.max(0.8, Math.min(1.5, atempo));
            console.log('  Atempo factor: ' + atempo.toFixed(3));

            var adjustedTtsPath = path.join(tempDir, 'voiceover_adjusted.wav');
            await this._runFFmpeg([
                '-i', ttsPath,
                '-filter:a', 'atempo=' + atempo.toFixed(4),
                '-y', adjustedTtsPath
            ]);

            // Step 7: Mix — voiceover at full volume, original construction audio at 20% volume
            var outputPath = path.join(this.outputDir, 'timelapse_vo_' + timestamp + '.mp4');
            await this._runFFmpeg([
                '-i', baseVideoPath,
                '-i', adjustedTtsPath,
                '-filter_complex', '[0:a]volume=0.2[bg];[1:a]aresample=44100[vo];[bg][vo]amix=inputs=2:duration=first:dropout_transition=2[aout]',
                '-map', '0:v',
                '-map', '[aout]',
                '-c:v', 'copy',
                '-c:a', 'aac', '-b:a', '192k',
                '-movflags', '+faststart',
                '-threads', '1',
                '-y', outputPath
            ]);

            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }

            var publicPath = '/studio/generated/timelapse/timelapse_vo_' + timestamp + '.mp4';
            console.log('✅ Final video with voiceover assembled: ' + publicPath);
            return { videoUrl: publicPath, script: script };

        } catch (error) {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
            throw new Error('Assembly with voiceover failed: ' + error.message);
        }
    }

    _runFFmpeg(args) {
        return new Promise(function(resolve, reject) {
            var proc = execFile(ffmpegPath, args, { timeout: 300000 });
            var stderr = '';
            proc.stderr.on('data', function(d) { stderr += d; });
            proc.on('close', function(code) {
                if (code === 0) resolve();
                else reject(new Error('FFmpeg exit ' + code + ': ' + stderr.slice(-500)));
            });
            proc.on('error', reject);
        });
    }
}

module.exports = TimelapseGenerator;
