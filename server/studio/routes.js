const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const SkeletonGenerator = require('./formats/skeleton-anatomy/generator');
const SkeletonGeneratorV2 = require('./formats/skeleton-anatomy-v2/generator');
const GeminiAnalyzer = require('./editor/gemini-analyzer');
const GeminiTTS = require('./editor/gemini-tts');
const VideoEditor = require('./editor/video-editor');

// Configure multer for scene image uploads
const uploadDir = path.join(__dirname, '../public/studio/uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({
    storage: multer.diskStorage({
        destination: uploadDir,
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname) || '.png';
            cb(null, `scene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
        }
    }),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files allowed'));
    }
});

// Lazy-load generators (only initialize when needed, not on server startup)
const generators = {};

function getGenerator(format, version = 'v1') {
    const key = `${format}-${version}`;
    if (!generators[key]) {
        if (format === 'skeleton-anatomy') {
            generators[key] = version === 'v2' ? new SkeletonGeneratorV2() : new SkeletonGenerator();
        }
    }
    return generators[key];
}

// Middleware to check authentication
const requireAuth = (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    // TODO: Verify JWT token with your existing auth system
    // For now, just pass through
    next();
};

// Generate Script
router.post('/generate/script', requireAuth, async (req, res) => {
    try {
        const { format, topic, style } = req.body;
        
        if (!format || !topic) {
            return res.status(400).json({ error: 'Format and topic are required' });
        }
        
        const generator = getGenerator(format);
        if (!generator) {
            return res.status(400).json({ error: 'Invalid format' });
        }
        
        console.log(`Generating script for format: ${format}, topic: ${topic}`);
        
        const script = await generator.generateScript(topic, style);
        
        res.json({ 
            success: true,
            script: script 
        });
        
    } catch (error) {
        console.error('Script generation error:', error);
        res.status(500).json({ 
            error: 'Failed to generate script',
            details: error.message 
        });
    }
});

// Generate Images
router.post('/generate/images', requireAuth, async (req, res) => {
    try {
        const { format, script, style } = req.body;
        
        if (!format || !script) {
            return res.status(400).json({ error: 'Format and script are required' });
        }
        
        const generator = getGenerator(format);
        if (!generator) {
            return res.status(400).json({ error: 'Invalid format' });
        }
        
        console.log(`Generating images for format: ${format}`);
        
        const images = await generator.generateImages(script, style);
        
        res.json({ 
            success: true,
            images: images 
        });
        
    } catch (error) {
        console.error('Image generation error:', error);
        res.status(500).json({ 
            error: 'Failed to generate images',
            details: error.message 
        });
    }
});

// Generate Voice
router.post('/generate/voice', requireAuth, async (req, res) => {
    try {
        const { format, script } = req.body;
        
        if (!format || !script) {
            return res.status(400).json({ error: 'Format and script are required' });
        }
        
        const generator = getGenerator(format);
        if (!generator) {
            return res.status(400).json({ error: 'Invalid format' });
        }
        
        console.log(`Generating voice for format: ${format}`);
        
        const audioUrl = await generator.generateVoice(script);
        
        res.json({ 
            success: true,
            audioUrl: audioUrl 
        });
        
    } catch (error) {
        console.error('Voice generation error:', error);
        res.status(500).json({ 
            error: 'Failed to generate voice',
            details: error.message 
        });
    }
});

// Get available formats
router.get('/formats', (req, res) => {
    res.json({
        formats: [
            {
                id: 'skeleton-anatomy',
                name: 'Skeleton Anatomy',
                description: 'Shocking health facts with dramatic skeleton visuals',
                icon: '🦴',
                avgViews: '2M+',
                generationTime: '5 min',
                versions: ['v1', 'v2']
            }
        ]
    });
});

// V2: Full video generation (script → scenes → images → videos)
router.post('/generate/full', requireAuth, async (req, res) => {
    try {
        const { format, script, skeletonStyle, gradientColors, generateVideos } = req.body;
        
        if (!format || !script) {
            return res.status(400).json({ error: 'Format and script are required' });
        }
        
        const generator = getGenerator(format, 'v2');
        if (!generator) {
            return res.status(400).json({ error: 'Invalid format or V2 not available' });
        }
        
        console.log(`Full generation for format: ${format}`);
        
        const result = await generator.generate(script, {
            skeletonStyle,
            gradientColors,
            generateVideos: generateVideos !== false // Default true
        });
        
        res.json({ 
            success: true,
            ...result
        });
        
    } catch (error) {
        console.error('Full generation error:', error);
        res.status(500).json({ 
            error: 'Failed to generate video',
            details: error.message 
        });
    }
});

// V2: Streaming generation with real-time progress updates
router.post('/generate/stream', requireAuth, async (req, res) => {
    try {
        const { format, script, skeletonStyle, gradientColors, generateVideos } = req.body;
        
        if (!format || !script) {
            return res.status(400).json({ error: 'Format and script are required' });
        }
        
        const generator = getGenerator(format, 'v2');
        if (!generator) {
            return res.status(400).json({ error: 'Invalid format or V2 not available' });
        }
        
        // Set up Server-Sent Events
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        const sendEvent = (event, data) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        
        console.log(`Streaming generation for format: ${format}`);
        
        try {
            // Generate with progress callbacks
            const result = await generator.generateWithProgress(script, {
                skeletonStyle,
                gradientColors,
                generateVideos: generateVideos !== false,
                onProgress: (progress) => {
                    sendEvent('progress', progress);
                },
                onSceneComplete: (scene) => {
                    sendEvent('scene', scene);
                }
            });
            
            sendEvent('complete', { success: true, ...result });
            res.end();
            
        } catch (error) {
            console.error('Streaming generation error:', error);
            sendEvent('error', { error: error.message });
            res.end();
        }
        
    } catch (error) {
        console.error('Stream setup error:', error);
        res.status(500).json({ 
            error: 'Failed to start generation stream',
            details: error.message 
        });
    }
});

// === DIRECTOR MODE ENDPOINTS ===

// Step 1: Generate scene prompts only (no images/videos)
router.post('/generate/scenes', requireAuth, async (req, res) => {
    try {
        const { format, script, skeletonStyle, gradientColors } = req.body;
        if (!format || !script) return res.status(400).json({ error: 'Format and script are required' });
        
        const generator = getGenerator(format, 'v2');
        if (!generator) return res.status(400).json({ error: 'Invalid format' });
        
        console.log(`Director mode: generating scene prompts for ${format}`);
        const scenes = await generator.generateScenePrompts(script, skeletonStyle || 'realistic translucent glass with ivory skeleton', gradientColors || 'smooth blue to teal gradient background');
        
        res.json({ success: true, scenes });
    } catch (error) {
        console.error('Scene generation error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Step 2: Generate images for a single scene (supports multiple variants)
router.post('/generate/scene-images', requireAuth, async (req, res) => {
    try {
        const { format, imagePrompt, sceneNumber, count } = req.body;
        if (!format || !imagePrompt) return res.status(400).json({ error: 'Format and imagePrompt are required' });
        
        const generator = getGenerator(format, 'v2');
        if (!generator) return res.status(400).json({ error: 'Invalid format' });
        
        const numImages = Math.min(count || 2, 4); // Max 4 variants
        console.log(`Director mode: generating ${numImages} image(s) for scene ${sceneNumber}`);
        
        const imagePromises = [];
        for (let i = 0; i < numImages; i++) {
            imagePromises.push(
                generator.generateImage(imagePrompt, sceneNumber).catch(err => ({ error: err.message }))
            );
        }
        
        const results = await Promise.all(imagePromises);
        const images = results.map((r, i) => typeof r === 'string' ? { url: r, index: i } : { error: r.error, index: i });
        
        res.json({ success: true, sceneNumber, images });
    } catch (error) {
        console.error('Scene image generation error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Step 3: Generate video for a single scene with selected image
router.post('/generate/scene-video', requireAuth, async (req, res) => {
    try {
        let { format, imageUrl, videoPrompt, sceneNumber } = req.body;
        if (!format || !imageUrl || !videoPrompt) return res.status(400).json({ error: 'format, imageUrl, and videoPrompt are required' });
        
        const generator = getGenerator(format, 'v2');
        if (!generator) return res.status(400).json({ error: 'Invalid format' });
        
        // Convert relative upload paths to full URLs for Kie.ai
        if (imageUrl.startsWith('/studio/uploads/')) {
            const protocol = req.protocol;
            const host = req.get('host');
            imageUrl = `${protocol}://${host}${imageUrl}`;
            console.log(`Converted relative upload path to full URL: ${imageUrl}`);
        }
        
        console.log(`Director mode: generating video for scene ${sceneNumber}`);
        console.log(`  Image URL: ${imageUrl.substring(0, 80)}...`);
        console.log(`  Video Prompt: ${videoPrompt.substring(0, 100)}...`);
        
        const videoUrl = await generator.generateVideo(imageUrl, videoPrompt, sceneNumber);
        
        console.log(`Director mode: video for scene ${sceneNumber} complete: ${videoUrl.substring(0, 80)}...`);
        res.json({ success: true, sceneNumber, videoUrl });
    } catch (error) {
        console.error('Scene video generation error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Upload custom scene image
router.post('/upload-scene-image', requireAuth, upload.single('image'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image file provided' });
        
        const url = `/studio/uploads/${req.file.filename}`;
        console.log(`Custom image uploaded: ${url}`);
        res.json({ success: true, url, filename: req.file.filename });
    } catch (error) {
        console.error('Scene image upload error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// === VIDEO ASSEMBLY ENDPOINT ===

// Assemble final video from generated scenes
router.post('/assemble', requireAuth, async (req, res) => {
    try {
        const { script, scenes, voiceName } = req.body;
        
        if (!script || !scenes || !Array.isArray(scenes)) {
            return res.status(400).json({ error: 'script and scenes array are required' });
        }
        
        // Filter to scenes that have video URLs
        const scenesWithVideo = scenes.filter(s => s.videoUrl || s._videoUrl);
        if (scenesWithVideo.length === 0) {
            return res.status(400).json({ error: 'No scenes have generated videos' });
        }
        
        console.log(`\n🎬 Video Assembly: ${scenesWithVideo.length} scenes, script ${script.length} chars\n`);
        
        // Step 1: Generate voiceover with Gemini TTS
        const tts = new GeminiTTS();
        const voiceoverPath = await tts.generateVoiceover(script, voiceName || 'Charon');
        
        // Step 2: Get edit decision list from Gemini
        const analyzer = new GeminiAnalyzer();
        const edl = await analyzer.analyze(script, scenesWithVideo);
        
        // Step 3: Assemble video with FFmpeg
        const editor = new VideoEditor();
        const result = await editor.assemble(edl, scenesWithVideo, voiceoverPath, {
            addCaptions: true
        });
        
        res.json({
            success: true,
            videoUrl: result.videoUrl,
            duration: result.duration,
            hookClips: edl.hook.clips.length,
            bodySegments: edl.body.length,
            sentences: edl.sentences.length
        });
        
    } catch (error) {
        console.error('Video assembly error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Health check
router.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        availableFormats: ['skeleton-anatomy']
    });
});

module.exports = router;
