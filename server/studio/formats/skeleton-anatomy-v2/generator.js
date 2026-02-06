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
            const promptPath = path.join(__dirname, '../../../../../Skeleton Training Data/PROMPT/master_system_prompt_v2.md');
            return fs.readFileSync(promptPath, 'utf8');
        } catch (error) {
            console.error('Failed to load master prompt:', error);
            // Fallback to embedded prompt
            return `You are an AI video prompt engineer specializing in creating hyper-realistic 3D skeleton anatomy videos...`;
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
            
            // Extract JSON from response
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error('Could not parse Claude response as JSON');
            }
            
            const scenesData = JSON.parse(jsonMatch[0]);
            console.log(`Claude generated ${scenesData.scenes.length} scenes`);
            
            return scenesData.scenes;
            
        } catch (error) {
            console.error('Claude scene generation error:', error);
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

            const taskId = createResponse.data.data.taskId;
            console.log(`Image task created: ${taskId}`);
            
            // Poll for completion
            const imageUrl = await this.pollKieTask(taskId);
            console.log(`Image ${sceneNumber} generated successfully`);
            
            return imageUrl;
            
        } catch (error) {
            console.error(`Error generating image ${sceneNumber}:`, error.response?.data || error.message);
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
