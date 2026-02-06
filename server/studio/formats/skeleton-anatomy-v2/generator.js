const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

class SkeletonGeneratorV2 {
    constructor() {
        // Initialize Claude
        this.anthropic = new Anthropic({
            apiKey: process.env.ANTHROPIC_API_KEY
        });
        
        // Kie.ai API configuration
        this.kieApiKey = process.env.KIEAI_API_KEY;
        this.kieBaseUrl = 'https://api.kie.ai';
        
        // Load master system prompt
        this.masterPrompt = this.loadMasterPrompt();
        
        // Ensure output directory exists
        this.outputDir = path.join(__dirname, '../../../../public/studio/generated');
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    loadMasterPrompt() {
        try {
            // Try multiple possible paths
            const possiblePaths = [
                path.join(__dirname, '../../../../../Skeleton Training Data/PROMPT/master_system_prompt_v2.md'),
                path.join(__dirname, '../../../../Skeleton Training Data/PROMPT/master_system_prompt_v2.md'),
                path.join(process.cwd(), 'Skeleton Training Data/PROMPT/master_system_prompt_v2.md'),
                '/workspace/Skeleton Training Data/PROMPT/master_system_prompt_v2.md'
            ];
            
            for (const promptPath of possiblePaths) {
                if (fs.existsSync(promptPath)) {
                    console.log(`✅ Found master prompt at: ${promptPath}`);
                    return fs.readFileSync(promptPath, 'utf8');
                }
            }
            
            console.warn('⚠️ Master prompt file not found, using embedded master prompt');
            throw new Error('File not found');
            
        } catch (error) {
            // Full embedded master prompt
            return `# MASTER BRIEFING — AI Video Prompt Engineering System

You are my AI video prompt engineer. Study everything I've attached — videos, reference frames, transcripts — and internalize the visual style. Then write production-ready prompts for new videos in this exact style.

---

## WHAT WE'RE BUILDING

60-second vertical short-form videos (TikTok/Reels/Shorts) showing "what happens to your body if you [X]." The visual style features a transparent glass human figure with a full anatomical skeleton visible inside — a hyper-realistic 3D animated anatomy character.

---

## THE PIPELINE

For each video, I give you a script. You break it into scenes (typically 10-18 for 60 seconds). For each scene you write:

1. **IMAGE PROMPT** → Sent to an AI image generation model to create a still frame
2. **VIDEO PROMPT** → Sent to an AI image-to-video model that animates the still into a short clip

I edit all clips together with voiceover and text overlays in post.

---

## IRONCLAD RULES

### Rule 1: Every Image Prompt is 100% Self-Contained

The image model has ZERO memory. It's never seen any previous image. It doesn't know what "the character" looks like.

**Every single image prompt must describe the complete visual from scratch:** what the body is made of, what's inside it, the eyes, the current physical condition, any props, the environment, camera angle, framing, lighting, and format.

### Rule 2: No Text in Image Prompts

All text overlays, numbers, scales, timestamps, and watermarks are post-production. Never include any text elements in your image prompts.

### Rule 3: Natural Pacing — No Slow Motion

**This is critical.** The pacing is snappy, lifelike, and natural. Characters move like real things move. Cameras move with energy and purpose.

**Never default to "slow" anything.** Don't write "slow dolly push-in," "very slow zoom," "slowly tilts," "gradually moves." That creates an obviously AI-generated slow-motion look that kills the realism.

Write camera and character movement as natural, real-world motion.

### Rule 4: No Duration Stamps

Don't specify "4 seconds" or "3 seconds" in your video prompts. Just describe the motion and action.

### Rule 5: 9:16 Vertical, Hyper-Realistic 3D

Every image is vertical portrait format. The rendering style is always hyper-realistic 3D — not cartoon, anime, painterly, or stylized.

---

## THE CHARACTER

**The body** is a life-size transparent glass human-shaped shell. Smooth, clear glass with reflections and refractions. A complete ivory-white anatomical skeleton fills it. Realistic human eyeballs sit in the skull's eye sockets. The eyes are the main vehicle for expression.

The glass body is not just a skeleton floating in air — it's a skeleton CONTAINED INSIDE a glass human form that has a human silhouette, shoulders, limbs, and proportions.

Key visual elements:
- Glass catches and refracts light beautifully
- Skeleton is fully visible through the transparent glass
- Eyes express emotion (wide, squinting, bloodshot, etc.)
- Jaw/mouth works (teeth, tongue, open/closed states)
- Organs appear inside the body when relevant

---

## GLASS DEGRADATION

The glass body changes to show damage or effects. The progression goes: pristine clear → faint cloudiness → yellowed/cloudy → crack lines appearing → heavily cracked → sections breaking away.

Color changes on the glass (purple bruising, yellowing, darkening) communicate different types of damage. Internal organs can glow, dim, swell, shrink, or change color to show effects. Blood and fluids can pool inside the glass limbs like liquid in a container.

Degradation should PROGRESS through the video — each scene should reflect where the character is at that point in the timeline.

---

## INTERNAL ANATOMY

The transparent body can reveal different systems depending on what the script needs:
- Skeleton only (default)
- Specific organs (heart, lungs, kidneys, brain, stomach, etc.) when narratively relevant
- Muscles (can be healthy pink, inactive grey, or glowing for enhanced states)
- Blood/fluids pooling or flowing
- Nerves as glowing lines

**Key insight: you show what the script is talking about.** If the script mentions the heart, the heart should be visible and showing the relevant effect.

---

## CAMERA AND MOTION

The camera work and character movement feel alive and natural — not robotic, not slow-motion, not artificially cinematic.

Use a wide variety of angles: medium full body, close-up face, extreme macro (single eyeball filling the frame), interior body shots (camera zoomed into the torso showing organs between ribs), overhead angles, low angles, side profiles, POV first-person shots, and rear views.

**Vary your angles across scenes.** Don't repeat the same framing more than twice in a row. The variety is what makes it engaging.

For video prompts, describe the movement naturally. What is the camera doing? What is the character doing? What's happening inside the body? Keep it punchy and real.

---

## MEDICAL B-ROLL

Some scenes cut to pure medical visualization with no glass character at all — the interior of a blood vessel, a neural network firing, an organ cross-section. These are powerful punctuation moments.

---

## BACKGROUNDS

The default is a smooth gradient (blue-to-teal, purple-to-pink, etc.) — clean, studio-like. But videos also place the character in real environments when the topic calls for it (gym, couch, desert, shower, etc.). Match the environment to the topic.

---

## SURREAL METAPHORS

The style occasionally replaces expected anatomy with surreal objects to represent abstract concepts (brain replaced by TV static for brain fog, etc.). These are used sparingly but are powerful when a concept doesn't have a literal visual equivalent.

---

## OTHER CHARACTERS

The glass skeleton can interact with other figures — other glass skeletons or even fully realistic non-transparent humans. The contrast between the transparent character and a solid human is visually striking.

---

## NARRATIVE ARC

Most videos follow a degradation arc: healthy → early effects → escalation → crisis → climax/collapse. Some follow a positive arc instead (improvement/transformation). Track the progression and make each scene reflect the correct state for that moment.

---

## YOUR WORKFLOW

1. Read the entire script — understand the full arc
2. Break the script into 10-18 scenes (aim for 3-5 seconds per scene)
3. Vary shot types across scenes
4. Write fully self-contained image prompts (describe EVERYTHING from scratch)
5. Write natural-paced video prompts (no slow motion, no durations)
6. Ensure progression through the timeline

---

## OUTPUT FORMAT

Return your response as a JSON array of scenes. Each scene object must have:

{
  "sceneNumber": 1,
  "narration": "The exact line from the script for this scene",
  "shotType": "close-up" | "medium" | "wide" | "macro" | "interior" | "broll",
  "imagePrompt": "Complete self-contained image prompt with all details",
  "videoPrompt": "Natural motion description for image-to-video"
}

**CRITICAL**: Image prompts must be 100% self-contained. Describe the glass body, skeleton, eyes, condition, props, environment, camera angle, lighting, and format EVERY TIME.

Now, when I give you a script, break it into scenes and generate the prompts following all these rules.`;
        }
    }

    /**
     * Step 1: Use Claude to break script into scenes and generate prompts
     */
    async generateScenePrompts(script, skeletonStyle, gradientColors) {
        console.log('Using Claude to break script into scenes...');
        
        const userPrompt = `I need you to create image and video prompts for this script:

SCRIPT:
${script}

VISUAL STYLE:
- Skeleton Style: ${skeletonStyle}
- Background Gradient: ${gradientColors}
- Format: 9:16 vertical
- Style: Hyper-realistic 3D

Break this into 10-18 scenes. For each scene, provide:
1. Scene number and script line
2. Shot type (wide/medium/close-up/macro)
3. IMAGE PROMPT (for Nano Banana Pro - fully self-contained, no text overlays)
4. VIDEO PROMPT (for Veo 3.1 - natural pacing, no duration stamps)

Format your response as JSON:
{
  "scenes": [
    {
      "sceneNumber": 1,
      "scriptLine": "...",
      "shotType": "close-up",
      "imagePrompt": "...",
      "videoPrompt": "..."
    }
  ]
}`;

        try {
            const response = await this.anthropic.messages.create({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 8000,
                system: this.masterPrompt,
                messages: [{
                    role: 'user',
                    content: userPrompt
                }]
            });

            const content = response.content[0].text;
            console.log('Claude response received, parsing...');
            
            // Try to extract JSON - Claude might wrap it in markdown code blocks
            let jsonText = content;
            
            // Remove markdown code blocks if present
            if (content.includes('```json')) {
                const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
                if (jsonMatch) {
                    jsonText = jsonMatch[1];
                }
            } else if (content.includes('```')) {
                const jsonMatch = content.match(/```\s*([\s\S]*?)\s*```/);
                if (jsonMatch) {
                    jsonText = jsonMatch[1];
                }
            } else {
                // Try to find JSON object
                const jsonMatch = content.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    jsonText = jsonMatch[0];
                }
            }
            
            // Parse JSON
            const scenesData = JSON.parse(jsonText.trim());
            
            if (!scenesData.scenes || !Array.isArray(scenesData.scenes)) {
                throw new Error('Invalid response format: missing scenes array');
            }
            
            console.log(`✅ Generated ${scenesData.scenes.length} scenes`);
            
            return scenesData.scenes;
            
        } catch (error) {
            console.error('Claude scene generation error:', error);
            console.error('Claude response content:', error.response?.data || 'No response data');
            throw new Error('Failed to generate scene prompts: ' + error.message);
        }
    }

    /**
     * Step 2: Generate images using Kie.ai Nano Banana Pro
     */
    async generateImage(imagePrompt, sceneNumber) {
        console.log(`Generating image for scene ${sceneNumber}...`);
        
        try {
            // Create task
            const createResponse = await axios.post(
                `${this.kieBaseUrl}/api/v1/jobs/createTask`,
                {
                    model: 'nano-banana-pro',
                    input: {
                        prompt: imagePrompt,
                        aspect_ratio: '9:16',
                        resolution: '2K',
                        output_format: 'png'
                    }
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.kieApiKey}`
                    }
                }
            );

            // Log full response for debugging
            console.log(`Kie.ai API response:`, JSON.stringify(createResponse.data, null, 2));
            
            // Check if response has the expected structure
            if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.taskId) {
                console.error('Unexpected Kie.ai API response structure:', createResponse.data);
                throw new Error('Kie.ai API did not return a taskId. Response: ' + JSON.stringify(createResponse.data));
            }

            const taskId = createResponse.data.data.taskId;
            console.log(`Image task created: ${taskId}`);
            
            // Poll for completion (images can take 2-3 minutes)
            const imageUrl = await this.pollKieTask(taskId, 180000); // 3 min timeout
            console.log(`Image ${sceneNumber} generated successfully`);
            
            return imageUrl;
            
        } catch (error) {
            console.error(`Error generating image ${sceneNumber}:`, error.response?.data || error.message);
            
            // Log more details for debugging
            if (error.response) {
                console.error('Kie.ai API error response:', {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    data: error.response.data
                });
            }
            
            throw error;
        }
    }

    /**
     * Step 3: Generate video from image using Kie.ai Veo 3.1
     */
    async generateVideo(imageUrl, videoPrompt, sceneNumber) {
        console.log(`Generating video for scene ${sceneNumber}...`);
        
        try {
            const createResponse = await axios.post(
                `${this.kieBaseUrl}/api/v1/veo/generate`,
                {
                    prompt: videoPrompt,
                    imageUrls: [imageUrl],
                    model: 'veo3_fast',
                    generationType: 'FIRST_AND_LAST_FRAMES_2_VIDEO',
                    aspect_ratio: '9:16',
                    enableTranslation: true
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.kieApiKey}`
                    }
                }
            );

            const taskId = createResponse.data.data.taskId;
            console.log(`Video task created: ${taskId}`);
            
            // Poll for completion (videos take longer)
            const videoUrl = await this.pollKieTask(taskId, 180000); // 3 min timeout
            console.log(`Video ${sceneNumber} generated successfully`);
            
            return videoUrl;
            
        } catch (error) {
            console.error(`Error generating video ${sceneNumber}:`, error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Poll Kie.ai task until completion
     */
    async pollKieTask(taskId, timeout = 60000) {
        const startTime = Date.now();
        const pollInterval = 3000; // 3 seconds
        
        while (Date.now() - startTime < timeout) {
            try {
                const response = await axios.get(
                    `${this.kieBaseUrl}/api/v1/jobs/getTask/${taskId}`,
                    {
                        headers: {
                            'Authorization': `Bearer ${this.kieApiKey}`
                        }
                    }
                );

                const status = response.data.data.status;
                
                if (status === 'completed') {
                    const resultUrl = response.data.data.info.resultUrls;
                    // Parse the result URL (it's returned as a string array)
                    const urls = JSON.parse(resultUrl);
                    return urls[0];
                }
                
                if (status === 'failed') {
                    throw new Error('Task failed: ' + response.data.msg);
                }
                
                // Still processing, wait and retry
                await new Promise(resolve => setTimeout(resolve, pollInterval));
                
            } catch (error) {
                if (error.response?.status === 404) {
                    // Task not found yet, wait and retry
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                } else {
                    throw error;
                }
            }
        }
        
        throw new Error('Task timeout - took longer than expected');
    }

    /**
     * Main generation flow
     */
    async generate(script, options = {}) {
        const {
            skeletonStyle = 'realistic translucent glass with ivory skeleton',
            gradientColors = 'smooth blue to teal gradient background',
            generateVideos = true
        } = options;

        console.log(`\n🎬 Starting Skeleton Video Generation\n`);
        console.log(`Script length: ${script.length} characters`);
        console.log(`Style: ${skeletonStyle}`);
        console.log(`Background: ${gradientColors}\n`);

        try {
            // Step 1: Generate scene prompts with Claude
            console.log('📝 Step 1: Generating scene breakdown with Claude...');
            const scenes = await this.generateScenePrompts(script, skeletonStyle, gradientColors);
            console.log(`✅ Generated ${scenes.length} scenes\n`);

            // Step 2: Generate images for each scene
            console.log('🎨 Step 2: Generating images with Nano Banana Pro...');
            for (let i = 0; i < scenes.length; i++) {
                const scene = scenes[i];
                try {
                    scene.imageUrl = await this.generateImage(scene.imagePrompt, i + 1);
                    console.log(`✅ Scene ${i + 1}/${scenes.length} image complete`);
                } catch (error) {
                    console.error(`❌ Scene ${i + 1} image failed:`, error.message);
                    scene.imageError = error.message;
                }
            }

            // Step 3: Generate videos (optional, can be done separately)
            if (generateVideos) {
                console.log('\n🎥 Step 3: Generating videos with Veo 3.1...');
                for (let i = 0; i < scenes.length; i++) {
                    const scene = scenes[i];
                    if (scene.imageUrl) {
                        try {
                            scene.videoUrl = await this.generateVideo(
                                scene.imageUrl,
                                scene.videoPrompt,
                                i + 1
                            );
                            console.log(`✅ Scene ${i + 1}/${scenes.length} video complete`);
                        } catch (error) {
                            console.error(`❌ Scene ${i + 1} video failed:`, error.message);
                            scene.videoError = error.message;
                        }
                    }
                }
            }

            console.log('\n✅ Generation complete!');
            
            return {
                success: true,
                totalScenes: scenes.length,
                scenes: scenes,
                script: script
            };

        } catch (error) {
            console.error('❌ Generation failed:', error);
            throw error;
        }
    }
}

module.exports = SkeletonGeneratorV2;
