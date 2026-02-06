const OpenAI = require('openai');
const Replicate = require('replicate');
const fs = require('fs');
const path = require('path');

class SkeletonGenerator {
    constructor() {
        // Initialize APIs
        this.openai = new OpenAI({ 
            apiKey: process.env.OPENAI_API_KEY 
        });
        
        this.replicate = new Replicate({ 
            auth: process.env.REPLICATE_API_KEY 
        });
        
        // Ensure output directory exists
        this.outputDir = path.join(__dirname, '../../../../public/studio/generated');
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    /**
     * Generate script from topic
     */
    async generateScript(topic, style = 'dramatic') {
        console.log(`Generating script for topic: ${topic}, style: ${style}`);
        
        const stylePrompts = {
            dramatic: 'Dramatic, fear-based but educational. Use shocking statements and urgent tone.',
            medical: 'Clinical and professional. Use medical terminology but keep it accessible.',
            horror: 'Dark and ominous. Emphasize the scary consequences and use vivid imagery.'
        };
        
        const prompt = `Create a shocking 45-second YouTube Short script about: "${topic}"

Style: ${stylePrompts[style] || stylePrompts.dramatic}

Format Requirements:
- Hook (first 3 seconds): A shocking, attention-grabbing statement
- Body (3-4 key facts): Each fact should be 10-12 seconds, revealing progressively worse consequences
- Each fact should be a separate scene
- End with a mild call to action

Example structure for "Stop Wearing Caps EVERY Day":
Hook: "Your favorite cap is slowly destroying your scalp."
Fact 1: "Wearing caps daily traps sweat and bacteria against your hair follicles..."
Fact 2: "This constant pressure restricts blood flow to your scalp..."
Fact 3: "Over time, this leads to traction alopecia - permanent hair loss..."
CTA: "Give your scalp a break. Your hair will thank you."

Important:
- Keep it under 150 words total
- Make each scene visually distinct
- Use everyday language, not overly technical
- Focus on relatable, common behaviors
- End each scene with a clear visual cue

Return ONLY the narration script. Separate each scene with a blank line.`;

        try {
            const response = await this.openai.chat.completions.create({
                model: "gpt-4",
                messages: [{ 
                    role: "user", 
                    content: prompt 
                }],
                temperature: 0.8,
                max_tokens: 500
            });

            const script = response.choices[0].message.content.trim();
            console.log('Script generated successfully');
            return script;
            
        } catch (error) {
            console.error('OpenAI script generation error:', error);
            throw new Error('Failed to generate script: ' + error.message);
        }
    }

    /**
     * Generate skeleton images from script
     */
    async generateImages(script, style = 'dramatic') {
        console.log('Generating images from script...');
        
        // Parse script into scenes (separated by blank lines or paragraphs)
        const scenes = script
            .split('\n\n')
            .filter(s => s.trim().length > 0)
            .slice(0, 4); // Max 4 scenes
        
        console.log(`Found ${scenes.length} scenes to visualize`);
        
        const images = [];
        
        const styleModifiers = {
            dramatic: 'dramatic cinematic lighting, blue and teal color scheme, high contrast',
            medical: 'clean medical illustration, white background, professional medical textbook style',
            horror: 'dark moody lighting, shadows, eerie atmosphere, horror movie aesthetic'
        };
        
        const styleModifier = styleModifiers[style] || styleModifiers.dramatic;
        
        for (let i = 0; i < scenes.length; i++) {
            console.log(`Generating image ${i + 1}/${scenes.length}...`);
            
            // Extract key visual elements from the scene
            const sceneText = scenes[i].substring(0, 200); // Limit length
            
            const prompt = `Hyper-realistic medical illustration of human skeleton anatomy, ${styleModifier}, 
professional 3D render, anatomically accurate, focus on: ${sceneText}. 
Vertical 9:16 aspect ratio, cinematic composition, detailed bone structure, 
realistic lighting and shadows. Style: like a high-end medical visualization 
mixed with dramatic cinematography. NO text, NO labels, just the visual.`;

            try {
                // Using Flux Schnell for fast, high-quality generation
                const output = await this.replicate.run(
                    "black-forest-labs/flux-schnell",
                    {
                        input: {
                            prompt: prompt,
                            aspect_ratio: "9:16",
                            num_outputs: 1,
                            output_format: "png",
                            output_quality: 90
                        }
                    }
                );

                if (output && output[0]) {
                    images.push(output[0]);
                    console.log(`Image ${i + 1} generated successfully`);
                } else {
                    console.error(`No output for image ${i + 1}`);
                }
                
            } catch (error) {
                console.error(`Error generating image ${i + 1}:`, error);
                // Continue with other images even if one fails
            }
        }
        
        if (images.length === 0) {
            throw new Error('Failed to generate any images');
        }
        
        console.log(`Successfully generated ${images.length} images`);
        return images;
    }

    /**
     * Generate voiceover from script
     */
    async generateVoice(script) {
        console.log('Generating voiceover...');
        
        try {
            const mp3 = await this.openai.audio.speech.create({
                model: "tts-1-hd",
                voice: "onyx", // Deep, dramatic male voice
                input: script,
                speed: 1.05 // Slightly faster for urgency
            });

            // Save audio file
            const timestamp = Date.now();
            const filename = `voiceover-${timestamp}.mp3`;
            const filepath = path.join(this.outputDir, filename);
            
            const buffer = Buffer.from(await mp3.arrayBuffer());
            fs.writeFileSync(filepath, buffer);
            
            console.log('Voiceover generated and saved:', filename);
            
            // Return public URL
            return `/studio/generated/${filename}`;
            
        } catch (error) {
            console.error('OpenAI voice generation error:', error);
            throw new Error('Failed to generate voice: ' + error.message);
        }
    }

    /**
     * Clean up old generated files (optional - call periodically)
     */
    cleanupOldFiles(maxAgeHours = 24) {
        const now = Date.now();
        const maxAge = maxAgeHours * 60 * 60 * 1000;
        
        fs.readdir(this.outputDir, (err, files) => {
            if (err) return;
            
            files.forEach(file => {
                const filepath = path.join(this.outputDir, file);
                fs.stat(filepath, (err, stats) => {
                    if (err) return;
                    
                    if (now - stats.mtimeMs > maxAge) {
                        fs.unlink(filepath, (err) => {
                            if (!err) {
                                console.log('Cleaned up old file:', file);
                            }
                        });
                    }
                });
            });
        });
    }
}

module.exports = SkeletonGenerator;
