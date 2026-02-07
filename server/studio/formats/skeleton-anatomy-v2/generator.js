const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { loadTrainingCache } = require('./persist-training-cache');

class SkeletonGeneratorV2 {
    constructor() {
        // Initialize Claude
        this.anthropic = new Anthropic({
            apiKey: process.env.ANTHROPIC_API_KEY
        });
        
        // AtlasCloud API configuration (for videos)
        this.atlasApiKey = process.env.ATLASCLOUD_API_KEY;
        this.atlasBaseUrl = 'https://api.atlascloud.ai/api/v1';
        
        // Kie.ai API configuration (for images only)
        this.kieApiKey = process.env.KIEAI_API_KEY;
        this.kieBaseUrl = 'https://api.kie.ai';
        
        // Load master system prompt
        this.masterPrompt = this.loadMasterPrompt();
        
        // DON'T load training images here - load fresh each time in generateScenePrompts()
        // This ensures we always get the latest uploaded files
        
        // Ensure output directory exists
        this.outputDir = path.join(__dirname, '../../../../public/studio/generated');
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }
    
    async loadTrainingImages() {
        // 1. Try MongoDB first (persists across deploys and containers)
        try {
            const mongoCache = await loadTrainingCache();
            if (mongoCache && mongoCache.files && mongoCache.files.length > 0) {
                return mongoCache;
            }
        } catch (err) {
            console.warn('MongoDB training cache load failed:', err.message);
        }
        
        // 2. Try in-memory global cache (same process only)
        if (global._trainingCache && global._trainingCache.files && global._trainingCache.files.length > 0) {
            console.log(`✅ Loaded ${global._trainingCache.files.length} reference frame IDs from in-memory cache`);
            return global._trainingCache;
        }
        
        // 3. Try filesystem (may not work on DigitalOcean across containers)
        try {
            const referenceIdsFile = path.join(__dirname, 'reference-file-ids.json');
            if (fs.existsSync(referenceIdsFile)) {
                const raw = fs.readFileSync(referenceIdsFile, 'utf8');
                const data = JSON.parse(raw);
                console.log(`✅ Loaded ${data.files?.length || 0} reference frame IDs from filesystem`);
                return data;
            }
        } catch (err) {
            console.warn('Filesystem training cache load failed:', err.message);
        }
        
        console.warn('⚠️  No reference file IDs found (checked MongoDB, memory, filesystem).');
        console.warn('⚠️  Upload training materials at /api/studio/upload-training-form');
        return { files: [] };
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
            // Full embedded master prompt - DR_DATA STYLE
            return `# DR_DATA STYLE — SCENE PROMPT GENERATOR

## WHAT THIS IS:

You are a creative director and prompt engineer for a YouTube Shorts / TikTok / Reels channel that uses AI-generated 3D scenes featuring a transparent glass skeleton character. Your job is to take a script and produce two things per scene: (1) an image generation prompt and (2) an image-to-video motion prompt.

You have been given reference videos and extracted frames from 10+ existing videos on this channel. Study them closely — they are your ground truth. Everything below was discovered by analyzing those references frame-by-frame over many iterations. Use this as your starting foundation, but keep learning and adapting as new reference material is added.

---

## THE CHARACTER (discovered from frame analysis)

The main character across all videos is a humanoid figure made of smooth, transparent glass-like material with a complete white anatomical human skeleton visible inside. Key details observed:

- Two large, expressive human eyeballs sitting in the skull's eye sockets (usually brown/hazel, but eye color and condition change based on the narrative — bloodshot, rolled back, milky white when dying, green/grey in transformation arcs)
- A pink tongue visible when the mouth is open
- Internal organs (heart, kidneys, stomach, brain, muscles, nerves) are visible through the glass when the script discusses them — the glass body is a window into the anatomy
- The glass body itself is a storytelling device: it starts clean and crystal-clear, then progressively degrades (condensation → yellowing → clouding → hairline cracks → deep fractures → opaque/broken) as the video's timeline advances
- In positive transformation videos (like creatine gains or Dagestan training), the glass body can get LARGER/more muscular, and the character can grow hair, beard, skin-like overlays on top of the glass
- The bones inside also degrade: pristine white → yellowish staining → cracking → fractures

**CRITICAL**: Your image generation model has NO context. It doesn't know what "the skeleton character" is. Every single prompt must describe this character from absolute scratch — the glass material, the skeleton inside, the eyeballs, the transparency, everything — as if the model has never seen any of it before. This was the single biggest lesson from our iterative process. Never assume prior context.

---

## CORE PRINCIPLES (the few things that are truly ironclad)

1. **Every prompt is self-contained.** Describe the character, materials, lighting, camera, pose, and background from scratch every time. The image model sees nothing but your prompt.

2. **No text, numbers, or HUD elements in the image.** Those are added in post-production.

3. **No slow motion.** Not in camera movement, not in character action. Natural, snappy, lifelike pacing always. This is the difference between looking cinematic vs. looking AI-generated.

4. **No duration timestamps in video motion prompts** (no "over 3 seconds" etc.).

5. **9:16 vertical, hyper-realistic 3D render** — always.

6. **Camera frames what the sentence is about, not what's convenient.** If the script says "your glutes settle into the cushion" — frame the glutes. If it says "blood pools in your ankles" — frame the ankles. If it says "your heart races" — show the heart through the ribcage. This is the single most important creative rule discovered from analyzing the reference videos. The camera is always telling you what to look at based on what the narrator is saying.

7. **The camera is NEVER static.** Every single video motion prompt MUST include camera movement. A locked-off, motionless camera looks cheap and boring. Even subtle movement keeps the viewer engaged. Use: gentle orbit around the character, slow push-in toward the subject, pull-back reveal, slight crane up/down, handheld drift, rack focus shift, dolly alongside the character, arc around a prop. The movement should feel natural and motivated — like a real cinematographer is operating the camera. Keep it brisk, not sluggish. Quick, confident moves. Never say "camera holds steady" or "static shot" — that is banned.

8. **Always show the full character in the image prompt unless it's specifically a macro/interior B-roll shot.** Close-ups are fine but they should still show at least chest-up with context — not a floating disembodied head. The character's body, pose, and environment tell the story. Even in tight shots, include enough of the body to ground the character in the scene. The only exception is true macro shots (inside a vein, a single eyeball filling the frame, an organ close-up) which are anatomical B-roll, not character shots.

9. **The skeleton is ALIVE — never a lifeless T-pose lab specimen.** Look at the reference frames: the skeleton is always in the act of DOING something. Choking? Hands gripping the throat. Running? Mid-stride, arms pumping. Scrolling a phone? Hunched over, thumb swiping. Sitting? Slouched, weight shifted, one leg crossed. The skeleton has a personality — it reacts, it emotes, it moves with purpose. Every pose must be mid-action, caught in a moment, like a freeze-frame from a movie. Never standing straight with arms at the sides. Never a neutral default pose. The character lives in extreme environments but behaves completely naturally — it just happens to be made of glass with a skeleton inside. Think of it as a real person doing real things, not a medical diagram.

10. **The image prompt is the STARTING FRAME, not the end frame.** This is critical. The image you describe becomes the first frame of the video. The VIDEO PROMPT then describes what HAPPENS from that starting point. So if the scene is about the skeleton swelling up and exploding, the image prompt should show the skeleton BEFORE it swells — intact, maybe with early warning signs (slight glow, minor tension). The video prompt then describes the swelling and explosion. If the scene is about glass cracking and shattering, the image shows the glass with maybe one hairline crack starting — the video shows the crack spreading and the glass breaking apart. NEVER put the climax or end-state in the image prompt. The image is the "before," the video is the "during." Think of it like this: the image is frame 1 of the scene, and the video plays out the action from there. If you put the destruction/transformation/climax in the image, the video has nowhere to go and just shows a static aftermath — which is boring and wastes the scene.

11. **Absolutely NO slow motion — in ANY form.** This rule cannot be overstated. Do not use the words "slow," "slowly," "gradual," "gradually," "gentle," "gently," "subtle," "subtly," "delicate," or "leisurely" in video prompts. Do not describe camera movements as "slow push-in" or "slow orbit" — just say "push-in" or "orbit." Do not describe character actions as "slowly raises hand" — say "raises hand." Everything moves at natural, real-world speed. Quick and confident. The moment anything moves in slow motion, it looks cheap and AI-generated. Real cinematography is snappy. Think documentary camera crew, not Matrix bullet-time. If you catch yourself writing "slow" or "gentle" in a video prompt, delete it immediately and replace with a direct, brisk description.

---

## WHAT YOU SHOULD LEARN FROM THE REFERENCE MATERIAL (not hard rules — patterns to absorb)

### Camera techniques observed across videos:
- Close-ups on the face for emotional beats (chest-up minimum, never just a floating head)
- Extreme close-ups (single eye filling the frame, single organ, single bone) — these are the ONLY shots where you can exclude the full body
- Medium shots from the chest up for narration
- Full body shots for establishing/context
- Shots from behind for isolation/vulnerability
- Overhead/bird's-eye for desperation or power
- Low angles for intensity
- Dutch angles (tilted) for disorientation
- Side profiles for posture/anatomy
- Medical/anatomical cutaway B-rolls (no character — just the interior of a vein, the cochlea, neurons, etc.)
- POV/first-person shots
- Mirror shots with reflections
- Object-focused framing (the camera on the prop, not the character — like a shower drain, or a phone screen)

### Camera MOVEMENT techniques (use these in EVERY video motion prompt):
- **Orbit**: Camera arcs around the character (quarter orbit, half orbit) — great for reveals
- **Push-in**: Camera moves toward the subject — builds tension and focus
- **Pull-back**: Camera retreats to reveal more context — great for establishing or shock reveals
- **Crane up/down**: Vertical camera movement — crane up for power, crane down for defeat
- **Dolly alongside**: Camera tracks laterally with the character — great for walking/running scenes
- **Handheld drift**: Subtle, organic camera sway — adds realism and energy
- **Rack focus**: Shift focus from foreground to background or vice versa
- **Whip pan**: Fast horizontal camera snap — great for transitions between subjects
- **Tilt up/down**: Camera pivots vertically on its axis — scanning the character head to toe
- Mix and combine these. A push-in with a slight orbit. A crane-up with a tilt-down. Keep it dynamic.

### The glass body as storytelling device:
- Starts clean → degrades over time (this maps to the script's timeline)
- Internal anatomy becomes visible when relevant to the script
- Muscles can glow, organs can swell, nerves can light up
- Surreal visual metaphors work: goldfish swimming inside the skull for "attention span shorter than a goldfish", TV static replacing the brain for "brain fog", etc.
- The glass can crack in dramatic web patterns like a shattered windshield
- Sweat/condensation droplets appear on the glass surface

### Environment patterns:
- Most videos use a solid gradient studio background (usually blue, but can be any color to match the video's vibe)
- Some videos use full environments (desert, mountain terrain, etc.) when the script is set in a specific location
- Even in studio videos, the scene can briefly shift to a specific location (bathroom, bedroom) when the script calls for it, then cut back to the studio
- Props stay consistent per video (headphones for music, treadmill for running, phone for scrolling, etc.)

### Expression and body language:
- Gestures match script tone exactly (tapping temple = "genius", clutching stomach = nausea, hand over mouth = shock)
- The character can interact with realistic human characters (like a wrestler)
- The character can break/destroy props as visual metaphors

---

## YOUR WORKFLOW

When given a new script:

1. **Read the full script first.** Understand the arc — where does it start, what's the peak, how does it end?

2. **Decide the environment and signature prop(s).** What background fits this video? What's the one prop that defines it?

3. **Break the script into scenes.** Each distinct visual beat gets its own scene. Think about when the camera NEEDS to cut to something new. Aim for 10-12 scenes maximum (not more than 12).

4. **For each scene, write two prompts:**
   - **IMAGE PROMPT** — This is the STARTING FRAME of the scene. A fully self-contained description that could be fed cold to an image generation model. Show the character at the BEGINNING of the action — before the transformation, before the destruction, before the climax. Include: render style, orientation, character description (full — glass body, skeleton, eyes, current degradation state), pose, expression, camera angle/framing, props, background, lighting. Everything. Remember: this image becomes frame 1 of the video, so it must leave room for the action to unfold.
   - **VIDEO MOTION PROMPT** — What happens when this starting frame comes to life. This is where the ACTION happens — the transformation, the destruction, the movement. Character action (what moves, how), camera movement, and any environmental motion. Keep it natural speed — brisk, confident, real-world pacing. No slow motion ever.

5. **Escalate visually.** The scenes should get progressively more intense — tighter shots, more damage, darker lighting, more dramatic angles — as the script's timeline advances.

---

## OUTPUT FORMAT

Return your response as a JSON object with a "scenes" array. Each scene object must have:

\`\`\`json
{
  "scenes": [
    {
      "sceneNumber": 1,
      "scriptLine": "The exact line from the script for this scene",
      "shotType": "close-up" | "medium" | "wide" | "macro" | "interior" | "broll" | "pov",
      "imagePrompt": "Complete self-contained image prompt with all details",
      "videoPrompt": "Natural motion description for image-to-video"
    }
  ]
}
\`\`\`

**CRITICAL REMINDERS:**
- Image prompts must be 100% self-contained. Describe the glass body, skeleton, eyes, condition, props, environment, camera angle, lighting, and format EVERY TIME.
- Image prompts must show the full character (at minimum chest-up) unless it's a macro/interior B-roll. No floating heads.
- **IMAGE = STARTING FRAME.** The image shows the BEGINNING of the action, NOT the result. If something breaks, show it before it breaks. If something transforms, show it before the transformation. The video prompt handles the action/change. Never put the climax in the image.
- Video prompts use natural, snappy pacing. ZERO slow motion. Ban the words: slow, slowly, gradual, gradually, gentle, gently, subtle, subtly. Everything at real-world speed.
- Video prompts MUST include camera movement. Never "camera holds steady" or "static shot." Always orbit, push-in, pull-back, crane, dolly, drift, or combine movements. Camera moves briskly, not sluggishly.
- Camera frames what the script is talking about.
- Maximum 12 scenes per video.

Now, when I give you a script, break it into scenes and generate the prompts following all these rules.`;
        }
    }

    /**
     * Step 1: Use Claude to break script into scenes and generate prompts
     */
    async generateScenePrompts(script, skeletonStyle, gradientColors) {
        console.log('Using Claude to break script into scenes...');
        
        // Load reference frames fresh each time (don't cache in constructor)
        const trainingImages = await this.loadTrainingImages();
        
        // Build content array with reference frames + text prompt
        const content = [];
        
        // Add reference frames if available
        if (trainingImages && trainingImages.files && trainingImages.files.length > 0) {
            // Only include images (not videos/docs)
            const imageFiles = trainingImages.files.filter(f => 
                f.filename && (f.filename.endsWith('.png') || f.filename.endsWith('.jpg') || f.filename.endsWith('.jpeg'))
            );
            
            console.log(`Including ${imageFiles.length} reference frames for Claude to analyze...`);
            
            // Use file references from Anthropic Files API
            // Requires SDK >= 0.37.0 and files-api-2025-04-14 beta header
            for (const file of imageFiles) {
                content.push({
                    type: 'image',
                    source: {
                        type: 'file',
                        file_id: file.fileId
                    }
                });
            }
            
            content.push({
                type: 'text',
                text: 'Study these reference frames carefully. They show the exact visual style, character design, camera angles, and pacing you should match. Notice the transparent glass body, skeleton detail, eye expressions, camera variety, and natural motion. Use these as your ground truth for generating prompts.'
            });
        } else {
            console.warn('⚠️  No reference frames loaded. Generating without visual references.');
        }
        
        // Add the main prompt
        const userPrompt = `I need you to create image and video prompts for this script:

SCRIPT:
${script}

VISUAL STYLE:
- Skeleton Style: ${skeletonStyle}
- Background Gradient: ${gradientColors}
- Format: 9:16 vertical
- Style: Hyper-realistic 3D (like the reference frames above)

Break this into 10-12 scenes (MAXIMUM 12 SCENES - do not exceed this limit). Aim for 4-5 seconds per scene. For each scene, provide:
1. Scene number and script line
2. Shot type (wide/medium/close-up/macro)
3. IMAGE PROMPT (for Nano Banana Pro - fully self-contained, no text overlays). IMPORTANT: The image is the STARTING FRAME — show the moment BEFORE the action/transformation/destruction happens. The video will handle the action.
4. VIDEO PROMPT (for Veo 3.1 - natural speed, NO slow motion, NO words like "slow/slowly/gradual/gentle". Brisk, confident movements. Must include camera movement.)

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

        content.push({
            type: 'text',
            text: userPrompt
        });

        try {
            // Determine if we need the files beta header
            const hasFileReferences = content.some(c => 
                c.type === 'image' && c.source?.type === 'file'
            );
            
            // Use direct HTTP request to bypass SDK version limitations
            // The SDK may not support type:'file' but the API does with the beta header
            const requestBody = {
                model: 'claude-opus-4-5-20251101',
                max_tokens: 8000,
                system: this.masterPrompt,
                messages: [{
                    role: 'user',
                    content: content
                }]
            };
            
            const headers = {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            };
            
            if (hasFileReferences) {
                headers['anthropic-beta'] = 'files-api-2025-04-14';
                console.log('Using files-api beta header for reference frames (direct HTTP)');
            }
            
            const httpResponse = await axios.post(
                'https://api.anthropic.com/v1/messages',
                requestBody,
                { 
                    headers,
                    timeout: 120000 // 2 min timeout for 74 images
                }
            );
            
            const response = httpResponse.data;

            if (!response.content || !response.content[0]) {
                console.error('Unexpected Claude response:', JSON.stringify(response).substring(0, 500));
                throw new Error('Empty response from Claude');
            }
            
            const responseText = response.content[0].text;
            console.log('Claude response received, parsing...');
            
            // Try to extract JSON - Claude might wrap it in markdown code blocks
            let jsonText = responseText;
            
            // Remove markdown code blocks if present
            if (responseText.includes('```json')) {
                const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
                if (jsonMatch) {
                    jsonText = jsonMatch[1];
                }
            } else if (responseText.includes('```')) {
                const jsonMatch = responseText.match(/```\s*([\s\S]*?)\s*```/);
                if (jsonMatch) {
                    jsonText = jsonMatch[1];
                }
            } else {
                // Try to find JSON object
                const jsonMatch = responseText.match(/\{[\s\S]*\}/);
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
            // Handle axios error format
            if (error.response?.data) {
                console.error('Claude API error:', JSON.stringify(error.response.data));
                throw new Error('Failed to generate scene prompts: ' + (error.response.data.error?.message || JSON.stringify(error.response.data)));
            }
            console.error('Claude scene generation error:', error.message);
            throw new Error('Failed to generate scene prompts: ' + error.message);
        }
    }

    /**
     * Step 2: Generate images using Kie.ai Nano Banana Pro
     */
    async generateImage(imagePrompt, sceneNumber) {
        console.log(`\n=== Generating image for scene ${sceneNumber} ===`);
        console.log(`Image Prompt: "${imagePrompt}"`);
        console.log(`===\n`);
        
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
            
            // Poll for completion (images can take 5-10 minutes during high load)
            const imageUrl = await this.pollKieTaskForImage(taskId, 600000);
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
     * Step 3: Generate video from image using AtlasCloud Veo 3.1 Fast
     * Includes 1 retry on failure with adjusted prompt
     */
    async generateVideo(imageUrl, videoPrompt, sceneNumber, lastImageUrl = null) {
        console.log(`\n=== Generating video for scene ${sceneNumber} ===`);
        console.log(`Image URL: ${imageUrl}`);
        if (lastImageUrl) console.log(`Last Image (multi-shot): ${lastImageUrl}`);
        console.log(`Video Prompt: "${videoPrompt}"`);
        console.log(`===\n`);
        
        const maxAttempts = 2;
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                console.log(`🎬 CALLING AtlasCloud Veo 3.1 Fast API - Scene ${sceneNumber} (attempt ${attempt}/${maxAttempts})`);
                
                const requestBody = {
                    model: 'google/veo3.1-fast/image-to-video',
                    prompt: videoPrompt,
                    image: imageUrl,
                    aspect_ratio: '9:16',
                    duration: 8,
                    resolution: '1080p',
                    generate_audio: true,
                    negative_prompt: 'gore, blood, violence, nsfw, nudity, graphic content'
                };
                
                // Add last_image for multi-shot if provided
                if (lastImageUrl) {
                    requestBody.last_image = lastImageUrl;
                    console.log('Using multi-shot mode (first + last frame)');
                }
                const createResponse = await axios.post(
                    `${this.atlasBaseUrl}/model/generateVideo`,
                    requestBody,
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${this.atlasApiKey}`
                        }
                    }
                );

                console.log(`AtlasCloud API response:`, JSON.stringify(createResponse.data, null, 2));
                
                if (!createResponse.data || !createResponse.data.data || !createResponse.data.data.id) {
                    console.error('Unexpected AtlasCloud API response:', createResponse.data);
                    throw new Error('AtlasCloud API did not return a prediction ID');
                }

                const predictionId = createResponse.data.data.id;
                console.log(`Video task created: ${predictionId}`);
                
                const videoUrl = await this.pollAtlasTask(predictionId, 600000);
                console.log(`✅ Video ${sceneNumber} generated successfully`);
                console.log(`💰 AtlasCloud cost: ~$0.64 (8 seconds × $0.08/sec)`);
                
                return videoUrl;
                
            } catch (error) {
                console.error(`Error generating video ${sceneNumber} (attempt ${attempt}):`, error.message);
                
                if (attempt < maxAttempts) {
                    console.log(`⏳ Retrying scene ${sceneNumber} in 5 seconds...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                } else {
                    throw error;
                }
            }
        }
    }

    /**
     * Poll Kie.ai task for image generation
     */
    async pollKieTaskForImage(taskId, timeout = 600000) {
        const startTime = Date.now();
        const pollInterval = 5000; // 5 seconds
        let pollCount = 0;
        
        const endpoint = `${this.kieBaseUrl}/api/v1/jobs/recordInfo`;
        
        while (Date.now() - startTime < timeout) {
            pollCount++;
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            
            try {
                const response = await axios.get(endpoint, {
                    params: { taskId },
                    headers: {
                        'Authorization': `Bearer ${this.kieApiKey}`
                    }
                });

                // Check API response code
                if (response.data.code !== 200) {
                    throw new Error(`Kie.ai API error: ${response.data.msg}`);
                }

                const state = response.data.data.state;
                
                // Log progress every 30 seconds
                if (pollCount % 6 === 0) {
                    console.log(`Image task ${taskId} state: ${state} (${elapsed}s elapsed)`);
                }
                
                if (state === 'success') {
                    const resultJson = JSON.parse(response.data.data.resultJson);
                    const resultUrls = resultJson.resultUrls;
                    console.log(`✅ Image task completed in ${elapsed}s`);
                    return resultUrls[0];
                }
                
                if (state === 'fail') {
                    const errorMsg = response.data.data.failMsg || 'Unknown error';
                    const errorCode = response.data.data.failCode || 'N/A';
                    throw new Error(`Image generation failed (${errorCode}): ${errorMsg}`);
                }
                
                // state === 'waiting' - still processing, wait and retry
                await new Promise(resolve => setTimeout(resolve, pollInterval));
                
            } catch (error) {
                // Check for specific error types
                if (error.response?.status === 401) {
                    throw new Error('Kie.ai authentication failed. Check your API key.');
                } else if (error.response?.status === 402) {
                    throw new Error('Out of Kie.ai credits. Please add more credits to your account.');
                } else if (error.response?.status === 429) {
                    console.warn('Rate limit hit, waiting 10 seconds...');
                    await new Promise(resolve => setTimeout(resolve, 10000));
                } else if (error.response?.status === 404) {
                    // Task not found yet, wait and retry
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                } else if (error.message.includes('Kie.ai') || error.message.includes('failed')) {
                    // Already formatted error, rethrow
                    throw error;
                } else {
                    console.error('Polling error:', error.message);
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                }
            }
        }
        
        throw new Error(`Task timeout after ${Math.floor(timeout/1000)}s - Kie.ai servers may be overloaded. Try again later.`);
    }

    /**
     * Poll AtlasCloud task for video generation
     */
    async pollAtlasTask(predictionId, timeout = 600000) {
        const startTime = Date.now();
        const pollInterval = 5000; // 5 seconds
        let pollCount = 0;
        
        const endpoint = `${this.atlasBaseUrl}/model/result/${predictionId}`;
        
        while (Date.now() - startTime < timeout) {
            pollCount++;
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            
            try {
                const response = await axios.get(endpoint, {
                    headers: {
                        'Authorization': `Bearer ${this.atlasApiKey}`
                    }
                });

                // Check API response code
                if (response.data.code !== 200) {
                    throw new Error(`AtlasCloud API error: ${response.data.message || 'Unknown error'}`);
                }

                const status = response.data.data.status;
                
                // Log progress every 30 seconds
                if (pollCount % 6 === 0) {
                    console.log(`Video task ${predictionId} status: ${status} (${elapsed}s elapsed)`);
                }
                
                // Check if video is ready
                if (status === 'completed' || status === 'succeeded') {
                    const outputs = response.data.data.outputs;
                    if (outputs && outputs.length > 0) {
                        console.log(`✅ Video task completed in ${elapsed}s`);
                        return outputs[0]; // Return first video URL
                    } else {
                        throw new Error('Video completed but no outputs found');
                    }
                }
                
                // Check for failure
                if (status === 'failed') {
                    const error = response.data.data.error || 'Unknown error';
                    throw new Error(`Video generation failed: ${error}`);
                }
                
                // Still processing (status === 'created' or 'processing'), wait and retry
                await new Promise(resolve => setTimeout(resolve, pollInterval));
                
            } catch (error) {
                // Check for specific error types
                if (error.response?.status === 401) {
                    throw new Error('AtlasCloud authentication failed. Check your API key.');
                } else if (error.response?.status === 402) {
                    throw new Error('Out of AtlasCloud credits. Please add more credits to your account.');
                } else if (error.response?.status === 429) {
                    console.warn('Rate limit hit, waiting 10 seconds...');
                    await new Promise(resolve => setTimeout(resolve, 10000));
                } else if (error.response?.status === 404) {
                    // Task not found yet, wait and retry
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                } else if (error.message.includes('AtlasCloud') || error.message.includes('failed')) {
                    // Already formatted error, rethrow
                    throw error;
                } else {
                    console.error('Video polling error:', error.message);
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                }
            }
        }
        
        throw new Error(`Video task timeout after ${Math.floor(timeout/1000)}s - AtlasCloud servers may be overloaded. Try again later.`);
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

            // Step 2: Generate images for each scene IN PARALLEL (batch mode)
            console.log('🎨 Step 2: Generating images with Nano Banana Pro...');
            console.log(`Starting batch generation of ${scenes.length} images in parallel...`);
            
            // Create all image generation tasks at once
            const imagePromises = scenes.map(async (scene, index) => {
                try {
                    console.log(`[${index + 1}/${scenes.length}] Starting image generation for scene ${index + 1}...`);
                    scene.imageUrl = await this.generateImage(scene.imagePrompt, index + 1);
                    console.log(`✅ Scene ${index + 1}/${scenes.length} image complete`);
                    return { success: true, sceneNumber: index + 1 };
                } catch (error) {
                    console.error(`❌ Scene ${index + 1} image failed:`, error.message);
                    scene.imageError = error.message;
                    return { success: false, sceneNumber: index + 1, error: error.message };
                }
            });
            
            // Wait for all images to complete
            const imageResults = await Promise.all(imagePromises);
            
            // Check for credit errors
            const creditErrors = imageResults.filter(r => 
                !r.success && (r.error?.includes('credit') || r.error?.includes('quota'))
            );
            
            if (creditErrors.length > 0) {
                console.error('⛔ Out of credits detected');
            }
            
            const successCount = imageResults.filter(r => r.success).length;
            console.log(`\n✅ Batch complete: ${successCount}/${scenes.length} images generated successfully\n`);

            // Step 3: Generate videos (optional, can be done separately) IN PARALLEL
            if (generateVideos) {
                console.log('\n🎥 Step 3: Generating videos with Veo 3.1...');
                
                // Only generate videos for scenes that have images
                const scenesWithImages = scenes.filter(scene => scene.imageUrl);
                console.log(`Starting batch generation of ${scenesWithImages.length} videos in parallel...`);
                
                const videoPromises = scenesWithImages.map(async (scene, index) => {
                    const sceneNumber = scenes.indexOf(scene) + 1;
                    try {
                        console.log(`[${index + 1}/${scenesWithImages.length}] Starting video generation for scene ${sceneNumber}...`);
                        scene.videoUrl = await this.generateVideo(
                            scene.imageUrl,
                            scene.videoPrompt,
                            sceneNumber
                        );
                        console.log(`✅ Scene ${sceneNumber} video complete`);
                        return { success: true, sceneNumber };
                    } catch (error) {
                        console.error(`❌ Scene ${sceneNumber} video failed:`, error.message);
                        scene.videoError = error.message;
                        return { success: false, sceneNumber, error: error.message };
                    }
                });
                
                // Wait for all videos to complete
                const videoResults = await Promise.all(videoPromises);
                const videoSuccessCount = videoResults.filter(r => r.success).length;
                console.log(`\n✅ Batch complete: ${videoSuccessCount}/${scenesWithImages.length} videos generated successfully\n`);
                
                // Cost summary (AtlasCloud pricing: $0.08/sec × 8 sec = $0.64 per video)
                const videoCost = videoSuccessCount * 0.64;
                console.log(`\n💰 VIDEO GENERATION COST SUMMARY:`);
                console.log(`   Videos generated: ${videoSuccessCount}`);
                console.log(`   Provider: AtlasCloud Veo 3.1 Fast`);
                console.log(`   Cost: $${videoCost.toFixed(2)} ($0.64 per 8-second video)`);
                console.log(`   Rate: $0.08 per second`);
                console.log(`\n`);
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

    /**
     * Generate with real-time progress callbacks for streaming updates
     */
    async generateWithProgress(script, options = {}) {
        const {
            skeletonStyle = 'realistic translucent glass with ivory skeleton',
            gradientColors = 'smooth blue to teal gradient background',
            generateVideos = true,
            onProgress = () => {},
            onSceneComplete = () => {}
        } = options;

        console.log(`\n🎬 Starting Skeleton Video Generation (with progress streaming)\n`);
        console.log(`Script length: ${script.length} characters`);
        console.log(`Style: ${skeletonStyle}`);
        console.log(`Background: ${gradientColors}\n`);

        try {
            // Step 1: Generate scene prompts with Claude
            onProgress({ step: 'claude', status: 'processing', message: 'Claude is analyzing your script...' });
            console.log('📝 Step 1: Generating scene breakdown with Claude...');
            
            const scenes = await this.generateScenePrompts(script, skeletonStyle, gradientColors);
            console.log(`✅ Generated ${scenes.length} scenes\n`);
            
            onProgress({ 
                step: 'claude', 
                status: 'completed', 
                message: `Generated ${scenes.length} scenes`,
                totalScenes: scenes.length
            });

            // Step 2: Generate images for each scene with progress updates
            onProgress({ 
                step: 'images', 
                status: 'processing', 
                message: `Generating ${scenes.length} images in parallel...`,
                total: scenes.length,
                completed: 0
            });
            
            console.log('🎨 Step 2: Generating images with Nano Banana Pro...');
            console.log(`Starting batch generation of ${scenes.length} images in parallel...`);
            
            let imagesCompleted = 0;
            
            const imagePromises = scenes.map(async (scene, index) => {
                try {
                    console.log(`[${index + 1}/${scenes.length}] Starting image generation for scene ${index + 1}...`);
                    scene.imageUrl = await this.generateImage(scene.imagePrompt, index + 1);
                    console.log(`✅ Scene ${index + 1}/${scenes.length} image complete`);
                    
                    imagesCompleted++;
                    onProgress({
                        step: 'images',
                        status: 'processing',
                        message: `Generated image ${imagesCompleted}/${scenes.length}`,
                        total: scenes.length,
                        completed: imagesCompleted
                    });
                    
                    // Send scene update with image
                    onSceneComplete({
                        sceneNumber: index + 1,
                        imageUrl: scene.imageUrl,
                        imagePrompt: scene.imagePrompt,
                        videoPrompt: scene.videoPrompt,
                        scriptLine: scene.scriptLine
                    });
                    
                    return { success: true, sceneNumber: index + 1 };
                } catch (error) {
                    console.error(`❌ Scene ${index + 1} image failed:`, error.message);
                    scene.imageError = error.message;
                    
                    imagesCompleted++;
                    onProgress({
                        step: 'images',
                        status: 'processing',
                        message: `Image ${imagesCompleted}/${scenes.length} (${index + 1} failed)`,
                        total: scenes.length,
                        completed: imagesCompleted
                    });
                    
                    return { success: false, sceneNumber: index + 1, error: error.message };
                }
            });
            
            const imageResults = await Promise.all(imagePromises);
            const successCount = imageResults.filter(r => r.success).length;
            console.log(`\n✅ Batch complete: ${successCount}/${scenes.length} images generated successfully\n`);
            
            onProgress({
                step: 'images',
                status: 'completed',
                message: `${successCount}/${scenes.length} images generated`,
                total: scenes.length,
                completed: scenes.length
            });

            // Step 3: Generate videos with progress updates
            if (generateVideos) {
                const scenesWithImages = scenes.filter(scene => scene.imageUrl);
                
                onProgress({
                    step: 'videos',
                    status: 'processing',
                    message: `Generating ${scenesWithImages.length} videos in parallel...`,
                    total: scenesWithImages.length,
                    completed: 0
                });
                
                console.log('\n🎥 Step 3: Generating videos with Veo 3.1...');
                console.log(`Starting batch generation of ${scenesWithImages.length} videos in parallel...`);
                
                let videosCompleted = 0;
                
                const videoPromises = scenesWithImages.map(async (scene, index) => {
                    const sceneNumber = scenes.indexOf(scene) + 1;
                    try {
                        console.log(`[${index + 1}/${scenesWithImages.length}] Starting video generation for scene ${sceneNumber}...`);
                        scene.videoUrl = await this.generateVideo(
                            scene.imageUrl,
                            scene.videoPrompt,
                            sceneNumber
                        );
                        console.log(`✅ Scene ${sceneNumber} video complete`);
                        
                        videosCompleted++;
                        onProgress({
                            step: 'videos',
                            status: 'processing',
                            message: `Generated video ${videosCompleted}/${scenesWithImages.length}`,
                            total: scenesWithImages.length,
                            completed: videosCompleted
                        });
                        
                        // Send scene update with video
                        onSceneComplete({
                            sceneNumber: sceneNumber,
                            videoUrl: scene.videoUrl,
                            imageUrl: scene.imageUrl,
                            imagePrompt: scene.imagePrompt,
                            videoPrompt: scene.videoPrompt,
                            scriptLine: scene.scriptLine
                        });
                        
                        return { success: true, sceneNumber };
                    } catch (error) {
                        console.error(`❌ Scene ${sceneNumber} video failed:`, error.message);
                        scene.videoError = error.message;
                        
                        videosCompleted++;
                        onProgress({
                            step: 'videos',
                            status: 'processing',
                            message: `Video ${videosCompleted}/${scenesWithImages.length} (${sceneNumber} failed)`,
                            total: scenesWithImages.length,
                            completed: videosCompleted
                        });
                        
                        return { success: false, sceneNumber, error: error.message };
                    }
                });
                
                const videoResults = await Promise.all(videoPromises);
                const videoSuccessCount = videoResults.filter(r => r.success).length;
                console.log(`\n✅ Batch complete: ${videoSuccessCount}/${scenesWithImages.length} videos generated successfully\n`);
                
                const videoCost = videoSuccessCount * 0.64;
                console.log(`\n💰 VIDEO GENERATION COST SUMMARY:`);
                console.log(`   Videos generated: ${videoSuccessCount}`);
                console.log(`   Provider: AtlasCloud Veo 3.1 Fast`);
                console.log(`   Cost: $${videoCost.toFixed(2)} ($0.64 per 8-second video)`);
                console.log(`   Rate: $0.08 per second`);
                console.log(`\n`);
                
                onProgress({
                    step: 'videos',
                    status: 'completed',
                    message: `${videoSuccessCount}/${scenesWithImages.length} videos generated`,
                    total: scenesWithImages.length,
                    completed: scenesWithImages.length,
                    cost: videoCost
                });
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
            onProgress({ step: 'error', status: 'failed', message: error.message });
            throw error;
        }
    }
}

module.exports = SkeletonGeneratorV2;
