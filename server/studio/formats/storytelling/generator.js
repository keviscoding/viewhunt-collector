/**
 * AI Storytelling Generator
 * 
 * Flow:
 *   1. User pastes a full script (survival stories, animal encounters, etc.)
 *   2. Claude breaks it into scene chunks (~10s each) with POV camera prompts
 *   3. Claude identifies recurring characters and assigns consistent outfits
 *   4. Each scene is generated as a 10s video via Kie.ai Sora 2 text-to-video
 *   5. Director mode only — user reviews clips, no auto assembly
 */

const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

class StorytellingGenerator {
    constructor() {
        this.anthropic = new Anthropic({
            apiKey: process.env.ANTHROPIC_API_KEY
        });

        // Kie.ai API (Sora 2 text-to-video)
        this.kieApiKey = process.env.KIEAI_API_KEY;
        this.kieBaseUrl = 'https://api.kie.ai';
    }

    /**
     * Step 1: Break script into scenes using Claude
     * Claude figures out natural breakpoints for 10-second clips,
     * identifies recurring characters, assigns consistent outfits,
     * and wraps each scene with the POV camera template.
     */
    async generateScenePrompts(script) {
        console.log('📖 Storytelling: Breaking script into scenes with Claude...');

        const systemPrompt = `You are an expert video director specializing in short-form POV storytelling content (like Sora AI survival/animal stories on YouTube Shorts and TikTok).

Your job is to take a full script and break it into individual scene chunks that will each become a 10-second AI-generated video clip.

CRITICAL RULES FOR SCENE BREAKDOWN:
1. Each scene should represent roughly 10 seconds of visual action
2. Find NATURAL breakpoints — don't cut mid-action or mid-sentence awkwardly
3. Sometimes one sentence is enough for 10 seconds (if it's action-heavy)
4. Sometimes 2-3 sentences can fit in 10 seconds (if they describe a continuous moment)
5. A whole paragraph can be one scene if it describes one continuous visual moment
6. The hook/opening line should ALWAYS be its own scene (Scene 1)
7. Do NOT include CTA/subscribe lines as scenes
8. Aim for 6-20 scenes depending on script length

CHARACTER CONSISTENCY:
- Identify ALL characters that appear in 2+ scenes
- Assign each a SPECIFIC, FIXED appearance: outfit color, hair style/color, build, age range, distinguishing features
- Be specific: "wearing a dark green flannel shirt, brown cargo pants, short brown hair, mid-30s, athletic build" — not just "a man"

POV TYPE:
- Default is "rear" (camera holder films what they see — they are NOT visible)
- Use "selfie" ONLY if the protagonist is speaking directly to camera (rare)

DO NOT build any video prompts. Just return the excerpt and metadata. The video prompt wrapper is applied by the backend.

Return JSON:
{
  "characters": [
    {
      "name": "David",
      "description": "Mid-30s, athletic build, short brown hair, wearing a dark green flannel shirt and brown cargo pants, work boots",
      "sceneAppearances": [1, 2, 4, 5, 6, 7, 8]
    }
  ],
  "scenes": [
    {
      "sceneNumber": 1,
      "excerpt": "The exact text from the script for this scene — copy it verbatim",
      "povType": "rear",
      "description": "Brief description of what happens visually"
    }
  ]
}`;

        const userPrompt = `Break this script into scenes for 10-second AI video generation:

SCRIPT:
${script}

Remember:
- Each scene = ~10 seconds of video
- Return the EXACT excerpt text from the script for each scene (verbatim, do not rephrase)
- Identify recurring characters and assign fixed appearances
- Do NOT include CTA/subscribe lines
- Do NOT build videoPrompt — just return excerpt, povType, description`;

        try {
            const response = await axios.post(
                'https://api.anthropic.com/v1/messages',
                {
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 16000,
                    system: systemPrompt,
                    messages: [{ role: 'user', content: userPrompt }]
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': process.env.ANTHROPIC_API_KEY,
                        'anthropic-version': '2023-06-01'
                    },
                    timeout: 300000
                }
            );

            if (!response.data.content || !response.data.content[0]) {
                throw new Error('Empty response from Claude');
            }

            const responseText = response.data.content[0].text;
            let jsonText = responseText;

            if (responseText.includes('```json')) {
                const m = responseText.match(/```json\s*([\s\S]*?)\s*```/);
                if (m) jsonText = m[1];
            } else if (responseText.includes('```')) {
                const m = responseText.match(/```\s*([\s\S]*?)\s*```/);
                if (m) jsonText = m[1];
            } else {
                const m = responseText.match(/\{[\s\S]*\}/);
                if (m) jsonText = m[0];
            }

            const data = JSON.parse(jsonText.trim());

            if (!data.scenes || !Array.isArray(data.scenes)) {
                throw new Error('Invalid response: missing scenes array');
            }

            // Build character lookup for scene appearances
            const charsByScene = {};
            if (data.characters && Array.isArray(data.characters)) {
                data.characters.forEach(function(c) {
                    if (c.sceneAppearances) {
                        c.sceneAppearances.forEach(function(sn) {
                            if (!charsByScene[sn]) charsByScene[sn] = [];
                            charsByScene[sn].push(c.name + ': ' + c.description);
                        });
                    }
                });
            }

            // HARDCODE the video prompt wrapper for each scene
            // Claude only gave us excerpt + povType — we build the actual Sora 2 prompt here
            data.scenes.forEach(function(scene) {
                var sn = scene.sceneNumber;
                var povRear = 'Handheld iPhone rear-camera POV, slightly shaky, natural phone sway, no subject visible, realistic mobile footage. Viewer\'s perspective only.';
                var povSelfie = 'Handheld iPhone selfie recording, slightly shaky, natural phone sway, realistic mobile footage.';
                var pov = scene.povType === 'selfie' ? povSelfie : povRear;

                // Build character descriptions for this scene
                var charBlock = '';
                if (charsByScene[sn] && charsByScene[sn].length > 0) {
                    charBlock = '\n\nCharacters in this scene:\n' + charsByScene[sn].join('\n');
                }

                scene.videoPrompt = 'This is the full story: (' + pov + '): ' + script + charBlock +
                    '\n\nGenerate JUST THIS part of the story: (' + pov + ')\n<' + scene.excerpt + '>';
            });

            console.log(`✅ Generated ${data.scenes.length} scenes (prompts hardcoded)`);
            if (data.characters && data.characters.length > 0) {
                console.log(`👤 Characters identified: ${data.characters.map(c => c.name).join(', ')}`);
            }

            return data;

        } catch (error) {
            if (error.response?.data) {
                console.error('Claude API error:', JSON.stringify(error.response.data));
                throw new Error('Failed to break script into scenes: ' + (error.response.data.error?.message || JSON.stringify(error.response.data)));
            }
            console.error('Scene breakdown error:', error.message);
            throw new Error('Failed to break script into scenes: ' + error.message);
        }
    }

    /**
     * Step 2: Generate a single video via Kie.ai Sora 2 text-to-video
     * 10 seconds, portrait (9:16), no watermark
     */
    async generateVideo(videoPrompt, sceneNumber) {
        console.log(`\n=== Storytelling: Generating video for scene ${sceneNumber} (Sora 2) ===`);
        console.log(`Prompt (first 150 chars): "${videoPrompt.substring(0, 150)}..."`);
        console.log(`===\n`);

        const maxRetries = 3;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`🎬 Sora 2 - Scene ${sceneNumber} (attempt ${attempt}/${maxRetries})`);

                const createResponse = await axios.post(
                    `${this.kieBaseUrl}/api/v1/jobs/createTask`,
                    {
                        model: 'sora-2-text-to-video',
                        input: {
                            prompt: videoPrompt,
                            aspect_ratio: 'portrait',
                            n_frames: '10',
                            remove_watermark: true,
                            upload_method: 's3'
                        }
                    },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${this.kieApiKey}`
                        },
                        timeout: 30000
                    }
                );

                const respData = createResponse.data;
                const taskId = respData?.data?.taskId || respData?.taskId || respData?.data?.task_id || respData?.task_id;

                if (!taskId) {
                    const code = respData?.code || respData?.status;
                    const msg = respData?.msg || respData?.message || '';

                    if (code === 402 || msg.toLowerCase().includes('credit') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('balance')) {
                        throw new Error('Out of Kie.ai credits. Please top up your account.');
                    }

                    console.warn(`Scene ${sceneNumber}: No taskId (attempt ${attempt}/${maxRetries}). Response: ${JSON.stringify(respData).substring(0, 300)}`);

                    if (attempt < maxRetries) {
                        const delay = attempt * 3000;
                        console.log(`Retrying in ${delay / 1000}s...`);
                        await new Promise(r => setTimeout(r, delay));
                        continue;
                    }
                    throw new Error(`Sora 2 failed to create video task after ${maxRetries} attempts`);
                }

                console.log(`Sora 2 video task created: ${taskId}`);

                const videoUrl = await this.pollKieTask(taskId, 600000);
                console.log(`✅ Scene ${sceneNumber} video generated (Sora 2, 10s)`);

                return videoUrl;

            } catch (error) {
                if (error.message.includes('credit') || error.message.includes('quota') || error.message.includes('balance') || error.message.includes('authentication')) {
                    throw error;
                }

                const status = error.response?.status;
                const isRetryable = !status || status >= 500 || status === 429 || error.code === 'ECONNABORTED';

                if (isRetryable && attempt < maxRetries) {
                    const delay = attempt * 3000;
                    console.warn(`Scene ${sceneNumber} Sora 2 error (attempt ${attempt}/${maxRetries}): ${error.message}. Retrying in ${delay / 1000}s...`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }

                console.error(`Error generating Sora 2 video ${sceneNumber}:`, error.response?.data || error.message);
                throw error;
            }
        }
    }

    /**
     * Poll Kie.ai task for video completion
     */
    async pollKieTask(taskId, timeout = 600000) {
        const startTime = Date.now();
        const pollInterval = 5000;
        let pollCount = 0;

        const endpoint = `${this.kieBaseUrl}/api/v1/jobs/recordInfo`;

        while (Date.now() - startTime < timeout) {
            pollCount++;
            const elapsed = Math.floor((Date.now() - startTime) / 1000);

            try {
                const response = await axios.get(endpoint, {
                    params: { taskId },
                    headers: { 'Authorization': `Bearer ${this.kieApiKey}` }
                });

                if (response.data.code !== 200) {
                    throw new Error(`Kie.ai API error: ${response.data.msg}`);
                }

                const state = response.data.data.state;

                if (pollCount % 6 === 0) {
                    console.log(`Sora 2 task ${taskId} state: ${state} (${elapsed}s elapsed)`);
                }

                if (state === 'success') {
                    const resultJson = JSON.parse(response.data.data.resultJson);
                    const resultUrls = resultJson.resultUrls || [];
                    if (resultUrls.length === 0) {
                        throw new Error('Sora 2 returned success but no video URLs');
                    }
                    console.log(`✅ Sora 2 task completed in ${elapsed}s`);
                    return resultUrls[0];
                }

                if (state === 'fail') {
                    const errorMsg = response.data.data.failMsg || 'Unknown error';
                    const errorCode = response.data.data.failCode || 'N/A';
                    throw new Error(`Sora 2 video generation failed (${errorCode}): ${errorMsg}`);
                }

                await new Promise(resolve => setTimeout(resolve, pollInterval));

            } catch (error) {
                if (error.response?.status === 401) {
                    throw new Error('Kie.ai authentication failed. Check your API key.');
                } else if (error.response?.status === 402) {
                    throw new Error('Out of Kie.ai credits.');
                } else if (error.response?.status === 429) {
                    console.warn('Kie.ai rate limit, waiting 10s...');
                    await new Promise(resolve => setTimeout(resolve, 10000));
                } else if (error.message.includes('Kie.ai') || error.message.includes('Sora') || error.message.includes('failed')) {
                    throw error;
                } else {
                    console.error('Sora 2 polling error:', error.message);
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                }
            }
        }

        throw new Error(`Sora 2 task timeout after ${Math.floor(timeout / 1000)}s. Try again later.`);
    }
}

module.exports = StorytellingGenerator;
