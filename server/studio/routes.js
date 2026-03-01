const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { getDb } = require('./db');
const SkeletonGenerator = require('./formats/skeleton-anatomy/generator');
const SkeletonGeneratorV2 = require('./formats/skeleton-anatomy-v2/generator');
const RankingAssembler = require('./formats/ranking/assembler');
const GeminiAnalyzer = require('./editor/gemini-analyzer');
const GeminiTTS = require('./editor/gemini-tts');
const VideoEditor = require('./editor/video-editor');
const assemblyQueue = require('./editor/job-queue');
const { saveSfx, listSfx, loadAllSfx } = require('./editor/sfx-store');
const credits = require('./credits');
const taskManager = require('./task-manager');
const rateLimit = require('express-rate-limit');

// Rate limiters for studio endpoints
const studioGenerateLimiter = rateLimit({
    windowMs: 60 * 1000,  // 1 minute
    max: 10,               // 10 generation requests per minute
    message: { error: 'Too many requests. Please wait a moment.' }
});

const studioAssemblyLimiter = rateLimit({
    windowMs: 60 * 1000,  // 1 minute
    max: 3,                // 3 assembly jobs per minute
    message: { error: 'Too many video assembly requests. Please wait.' }
});

const studioGeneralLimiter = rateLimit({
    windowMs: 60 * 1000,  // 1 minute
    max: 60,               // 60 general requests per minute
    message: { error: 'Rate limit exceeded. Please slow down.' }
});

// Apply general limiter to all studio routes
router.use(studioGeneralLimiter);

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

// Middleware to check authentication — decodes JWT to get userId
const requireAuth = (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // { userId, email, display_name }
        
        // Block shared student account from studio
        if (decoded.email === 'students@viewhunt.com') {
            return res.status(403).json({ 
                error: 'Content Studio requires a personal account. Please create your own account at /app',
                redirect: '/app'
            });
        }
        
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }
};



// V1 routes DISABLED — these called OpenAI/Replicate with ZERO credit charging.
// Keeping the endpoints alive but returning 410 Gone so nothing breaks silently.
router.post('/generate/script', requireAuth, (req, res) => {
    res.status(410).json({ error: 'V1 endpoints are disabled. Use the V2 studio at /studio/v2' });
});
router.post('/generate/images', requireAuth, (req, res) => {
    res.status(410).json({ error: 'V1 endpoints are disabled. Use the V2 studio at /studio/v2' });
});
router.post('/generate/voice', requireAuth, (req, res) => {
    res.status(410).json({ error: 'V1 endpoints are disabled. Use the V2 studio at /studio/v2' });
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
            },
            {
                id: 'ranking',
                name: 'Ranking & Countdown',
                description: 'Upload clips, trim, add title + numbered list, assemble ranking video',
                icon: '🏆',
                generationTime: '1-2 min',
                creditCost: 2
            }
        ]
    });
});

// V2: Full video generation (script → scenes → images → videos)
router.post('/generate/full', requireAuth, async (req, res) => {
    try {
        const { format, script, skeletonStyle, gradientColors, generateVideos, videoModel } = req.body;
        
        if (!format || !script) {
            return res.status(400).json({ error: 'Format and script are required' });
        }
        
        // Estimate total cost upfront: script(5) + ~12 images(0.5 each = 6) + ~12 videos(5 each = 60) = ~71
        const userId = String(req.user.userId);
        const estimatedScenes = 12;
        var estimatedCost = credits.COSTS.script_generation;
        estimatedCost += credits.COSTS.image_generation * estimatedScenes;
        if (generateVideos !== false) estimatedCost += credits.COSTS.video_generation * estimatedScenes;
        
        // Check if user has enough for the full estimated cost
        const bal = await credits.getBalance(userId);
        const totalAvailable = (bal.balance || 0) + (bal.topUpBalance || 0);
        if (totalAvailable < estimatedCost) {
            return res.status(402).json({ 
                error: 'Not enough credits for full generation',
                balance: bal.balance,
                topUpBalance: bal.topUpBalance || 0,
                totalAvailable,
                estimatedCost
            });
        }
        
        // Deduct script generation credits upfront
        await credits.deductCredits(userId, 'script_generation', 1, 'Auto mode script generation');
        
        const generator = getGenerator(format, 'v2');
        if (!generator) {
            return res.status(400).json({ error: 'Invalid format or V2 not available' });
        }
        
        console.log(`Full generation for format: ${format}`);
        
        const resolvedModel = (['kling','sora2'].includes(videoModel) && req.user.email === process.env.ADMIN_EMAIL) ? videoModel : 'wan';
        
        const result = await generator.generate(script, {
            skeletonStyle,
            gradientColors,
            generateVideos: generateVideos !== false,
            videoModel: resolvedModel
        });
        
        // Deduct credits for actual scenes generated
        const actualScenes = result.scenes || [];
        const imagesGenerated = actualScenes.filter(s => s.imageUrl).length;
        const videosGenerated = actualScenes.filter(s => s.videoUrl).length;
        
        if (imagesGenerated > 0) {
            await credits.deductCredits(userId, 'image_generation', imagesGenerated, 'Auto mode: ' + imagesGenerated + ' images');
        }
        if (videosGenerated > 0) {
            await credits.deductCredits(userId, 'video_generation', videosGenerated, 'Auto mode: ' + videosGenerated + ' videos');
        }
        
        console.log(`💳 Full mode charged: script(5) + ${imagesGenerated} images(${imagesGenerated * 0.5}) + ${videosGenerated} videos(${videosGenerated * 5}) = ${5 + imagesGenerated * 0.5 + videosGenerated * 5} credits`);
        
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
        const { format, script, skeletonStyle, gradientColors, generateVideos, videoModel } = req.body;
        
        if (!format || !script) {
            return res.status(400).json({ error: 'Format and script are required' });
        }
        
        // Estimate total cost upfront and verify user can afford it
        // script(5) + ~12 images(0.5 each = 6) + ~12 videos(5 each = 60) = ~71 credits
        const userId = String(req.user.userId);
        const estimatedScenes = 12;
        var estimatedCost = credits.COSTS.script_generation;
        estimatedCost += credits.COSTS.image_generation * estimatedScenes;
        if (generateVideos !== false) estimatedCost += credits.COSTS.video_generation * estimatedScenes;
        
        const bal = await credits.getBalance(userId);
        const totalAvailable = (bal.balance || 0) + (bal.topUpBalance || 0);
        if (totalAvailable < estimatedCost) {
            return res.status(402).json({ 
                error: 'Not enough credits for auto mode. Need ~' + Math.ceil(estimatedCost) + ' credits.',
                balance: bal.balance,
                topUpBalance: bal.topUpBalance || 0,
                totalAvailable,
                estimatedCost: Math.ceil(estimatedCost)
            });
        }
        
        // Deduct script generation credits upfront
        await credits.deductCredits(userId, 'script_generation', 1, 'Auto mode script generation');
        
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
        
        // Track what we charge as scenes complete
        let imagesCharged = 0;
        let videosCharged = 0;
        
        try {
            const resolvedModel = (['kling','sora2'].includes(videoModel) && req.user.email === process.env.ADMIN_EMAIL) ? videoModel : 'wan';
            
            const result = await generator.generateWithProgress(script, {
                skeletonStyle,
                gradientColors,
                generateVideos: generateVideos !== false,
                videoModel: resolvedModel,
                onProgress: async (progress) => {
                    sendEvent('progress', progress);
                    
                    // Charge for images when image step completes
                    if (progress.step === 'images' && progress.status === 'completed' && progress.completed > 0) {
                        try {
                            const count = progress.completed;
                            await credits.deductCredits(userId, 'image_generation', count, 'Auto mode: ' + count + ' images');
                            imagesCharged = count;
                            console.log(`💳 Auto mode: charged ${count} images (${count * credits.COSTS.image_generation} credits)`);
                        } catch (e) {
                            console.error('Auto mode image credit deduction failed:', e.message);
                        }
                    }
                    
                    // Charge for videos when video step completes
                    if (progress.step === 'videos' && progress.status === 'completed') {
                        try {
                            // Count actual successful videos from the message (e.g. "8/12 videos generated")
                            const match = progress.message && progress.message.match(/^(\d+)\//);
                            const count = match ? parseInt(match[1]) : (progress.completed || 0);
                            if (count > 0) {
                                await credits.deductCredits(userId, 'video_generation', count, 'Auto mode: ' + count + ' videos');
                                videosCharged = count;
                                console.log(`💳 Auto mode: charged ${count} videos (${count * credits.COSTS.video_generation} credits)`);
                            }
                        } catch (e) {
                            console.error('Auto mode video credit deduction failed:', e.message);
                        }
                    }
                },
                onSceneComplete: (scene) => {
                    sendEvent('scene', scene);
                }
            });
            
            console.log(`💳 Auto mode total: script(5) + ${imagesCharged} images(${imagesCharged * 0.5}) + ${videosCharged} videos(${videosCharged * 5}) = ${5 + imagesCharged * 0.5 + videosCharged * 5} credits`);
            
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
        
        // Credit check: script generation = 5 credits
        const userId = String(req.user.userId);
        const check = await credits.checkCredits(userId, 'script_generation', 1);
        if (!check.allowed) {
            return res.status(402).json({ error: 'Not enough credits', ...check });
        }
        
        const generator = getGenerator(format, 'v2');
        if (!generator) return res.status(400).json({ error: 'Invalid format' });
        
        console.log(`Director mode: generating scene prompts for ${format}`);
        const scenes = await generator.generateScenePrompts(script, skeletonStyle || 'realistic translucent glass with ivory skeleton', gradientColors || 'smooth blue to teal gradient background');
        
        // Deduct credits on success
        await credits.deductCredits(userId, 'script_generation', 1, 'Scene prompts for ' + format);
        
        res.json({ success: true, scenes });
    } catch (error) {
        console.error('Scene generation error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Step 2: Generate images for a single scene (supports multiple variants)
router.post('/generate/scene-images', requireAuth, studioGenerateLimiter, async (req, res) => {
    try {
        const { format, imagePrompt, sceneNumber, count } = req.body;
        if (!format || !imagePrompt) return res.status(400).json({ error: 'Format and imagePrompt are required' });
        
        const numImages = Math.min(count || 2, 4); // Max 4 variants
        
        // Credit check: charge per actual image requested (0.5 credits each)
        const userId = String(req.user.userId);
        const check = await credits.checkCredits(userId, 'image_generation', numImages);
        if (!check.allowed) {
            return res.status(402).json({ error: 'Not enough credits', ...check });
        }
        
        const generator = getGenerator(format, 'v2');
        if (!generator) return res.status(400).json({ error: 'Invalid format' });
        
        console.log(`Director mode: generating ${numImages} image(s) for scene ${sceneNumber}`);
        
        const imagePromises = [];
        for (let i = 0; i < numImages; i++) {
            imagePromises.push(
                generator.generateImage(imagePrompt, sceneNumber).catch(err => ({ error: err.message }))
            );
        }
        
        const results = await Promise.all(imagePromises);
        const images = results.map((r, i) => typeof r === 'string' ? { url: r, index: i } : { error: r.error, index: i });
        
        // Only charge for successful images
        const successCount = images.filter(img => img.url).length;
        const failCount = images.filter(img => img.error).length;
        
        if (successCount > 0) {
            await credits.deductCredits(userId, 'image_generation', successCount, successCount + ' images for scene ' + sceneNumber);
            console.log(`💳 Charged ${successCount} images (${successCount * credits.COSTS.image_generation} credits)`);
        }
        
        if (failCount > 0) {
            console.log(`⚠️ ${failCount} image(s) failed — no credits charged for failures`);
        }
        
        res.json({ success: true, sceneNumber, images });
    } catch (error) {
        console.error('Scene image generation error:', error);
        res.status(500).json({ error: 'Generation failed — no credits deducted. If this persists, please try again in an hour.' });
    }
});

// Step 3: Generate video for a single scene with selected image
router.post('/generate/scene-video', requireAuth, studioGenerateLimiter, async (req, res) => {
    try {
        let { format, imageUrl, videoPrompt, sceneNumber, videoModel } = req.body;
        if (!format || !imageUrl || !videoPrompt) return res.status(400).json({ error: 'format, imageUrl, and videoPrompt are required' });
        
        // Credit check: video_generation = 5 credits per scene
        const userId = String(req.user.userId);
        const check = await credits.checkCredits(userId, 'video_generation', 1);
        if (!check.allowed) {
            return res.status(402).json({ error: 'Not enough credits', ...check });
        }
        
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
        
        // Only admin can use kling model
        const resolvedModel = (['kling','sora2'].includes(videoModel) && req.user.email === process.env.ADMIN_EMAIL) ? videoModel : 'wan';
        
        const videoUrl = await generator.generateVideo(imageUrl, videoPrompt, sceneNumber, resolvedModel);
        
        // Charge only on success
        await credits.deductCredits(userId, 'video_generation', 1, 'Video for scene ' + sceneNumber);
        
        console.log(`Director mode: video for scene ${sceneNumber} complete: ${videoUrl.substring(0, 80)}...`);
        res.json({ success: true, sceneNumber, videoUrl });
    } catch (error) {
        console.error('Scene video generation error:', error.message);
        res.status(500).json({ error: 'Generation failed — no credits deducted. If this persists, please try again in an hour.' });
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

// === VIDEO ASSEMBLY ENDPOINTS (Queue-based) ===

// Submit assembly job — returns immediately with jobId
router.post('/assemble', requireAuth, studioAssemblyLimiter, async (req, res) => {
    try {
        const { script, scenes, voiceName } = req.body;
        
        if (!script || !scenes || !Array.isArray(scenes)) {
            return res.status(400).json({ error: 'script and scenes array are required' });
        }
        
        const scenesWithVideo = scenes.filter(s => s.videoUrl || s._videoUrl);
        if (scenesWithVideo.length === 0) {
            return res.status(400).json({ error: 'No scenes have generated videos' });
        }
        
        // Credit check: assembly = 2 credits
        const userId = String(req.user.userId);
        const check = await credits.checkCredits(userId, 'assembly', 1);
        if (!check.allowed) {
            return res.status(402).json({ error: 'Not enough credits', ...check });
        }
        
        // Deduct assembly credits upfront (refund on failure)
        await credits.deductCredits(userId, 'assembly', 1, 'Video assembly');
        
        console.log(`\n🎬 Assembly job submitted: ${scenesWithVideo.length} scenes, ${script.length} chars\n`);
        
        const jobId = assemblyQueue.submit(script, scenesWithVideo, voiceName, userId);
        
        res.json({ success: true, jobId, userId });
        
    } catch (error) {
        console.error('Assembly submit error:', error);
        var status = error.message.includes('Queue is full') ? 429 : 500;
        res.status(status).json({ error: error.message });
    }
});

// Poll assembly job status
router.get('/assemble/status/:jobId', requireAuth, async (req, res) => {
    const status = assemblyQueue.getStatus(req.params.jobId);
    if (!status) return res.status(404).json({ error: 'Job not found' });
    
    // Auto-refund credits on assembly failure (once)
    if (status.status === 'failed' && !status._refunded) {
        try {
            const userId = String(req.user.userId);
            await credits.refundCredits(userId, 'assembly', 1, 'Assembly failed: ' + (status.error || 'unknown'));
            assemblyQueue.markRefunded(req.params.jobId);
            status.refunded = true;
        } catch (refundErr) {
            console.error('Assembly refund error:', refundErr.message);
        }
    }
    
    res.json(status);
});

// Upload SFX files to MongoDB (hook, transition, riser)
const sfxUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('audio/')) cb(null, true);
        else cb(new Error('Only audio files allowed'));
    }
});

router.post('/upload-sfx', requireAuth, sfxUpload.single('sfx'), async (req, res) => {
    try {
        // Admin only — SFX are global, don't let users overwrite them
        if (req.user.email !== process.env.ADMIN_EMAIL) {
            return res.status(403).json({ error: 'Custom sound effects are coming soon. For now, the preset SFX are used for all videos.' });
        }
        if (!req.file) return res.status(400).json({ error: 'No audio file provided' });
        // Extract SFX name from filename (e.g. "hook.mp3" → "hook")
        var name = path.basename(req.file.originalname, path.extname(req.file.originalname));
        var validNames = ['hook', 'transition', 'riser', 'bgmusic'];
        if (validNames.indexOf(name) === -1) {
            return res.status(400).json({ error: 'File must be named hook, transition, or riser (e.g. hook.mp3)' });
        }
        await saveSfx(name, req.file.buffer, req.file.originalname);
        console.log('🔊 SFX "' + name + '" uploaded to MongoDB');
        res.json({ success: true, filename: req.file.originalname });
    } catch (err) {
        console.error('SFX upload error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// List available SFX from MongoDB
router.get('/sfx', requireAuth, async (req, res) => {
    try {
        var items = await listSfx();
        var files = items.map(function(i) { return i.filename; });
        res.json({ sfx: files });
    } catch (e) {
        res.json({ sfx: [] });
    }
});

// Serve SFX file for preview (load from MongoDB → disk → serve)
router.get('/sfx/:filename', requireAuth, async (req, res) => {
    try {
        // Ensure SFX are on disk
        await loadAllSfx();
        var sfxDir = path.join(__dirname, 'editor/assets/sfx');
        var filePath = path.join(sfxDir, req.params.filename);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
        res.sendFile(filePath);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// === CREDIT SYSTEM ENDPOINTS ===

// Get credit balance
router.get('/credits/balance', requireAuth, async (req, res) => {
    try {
        const bal = await credits.getBalance(String(req.user.userId));
        res.json({ success: true, ...bal, totalAvailable: (bal.balance || 0) + (bal.topUpBalance || 0) });
    } catch (err) {
        console.error('Credit balance error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get transaction history
router.get('/credits/transactions', requireAuth, async (req, res) => {
    try {
        const txns = await credits.getTransactions(String(req.user.userId), 50);
        res.json({ success: true, transactions: txns });
    } catch (err) {
        console.error('Credit transactions error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Check if user has enough credits for an action
router.post('/credits/check', requireAuth, async (req, res) => {
    try {
        const { action, quantity } = req.body;
        const check = await credits.checkCredits(String(req.user.userId), action, quantity || 1);
        res.json({ success: true, ...check });
    } catch (err) {
        console.error('Credit check error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Buy top-up credits — creates Stripe checkout session
router.post('/credits/buy', requireAuth, async (req, res) => {
    try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        if (!stripe) return res.status(500).json({ error: 'Payment system not configured' });

        const { pack } = req.body; // 'small', 'medium', or 'large'
        const packInfo = credits.TOPUP_PACKS[pack || 'small'];
        if (!packInfo) return res.status(400).json({ error: 'Invalid pack. Choose small, medium, or large.' });

        var priceId = process.env[packInfo.envVar];
        if (!priceId) return res.status(500).json({ error: 'Top-up pricing not configured' });

        const db = await getDb();
        const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.userId) });

        if (!user) return res.status(404).json({ error: 'User not found' });

        // Get or use existing Stripe customer
        var customerId = user.subscription?.stripeCustomerId;
        if (!customerId) {
            const customer = await stripe.customers.create({
                email: user.email,
                name: user.display_name,
                metadata: { userId: user._id.toString() }
            });
            customerId = customer.id;
            await db.collection('users').updateOne(
                { _id: user._id },
                { $set: { 'subscription.stripeCustomerId': customerId } }
            );
        }

        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            mode: 'payment',
            success_url: (process.env.APP_URL || 'https://viewhunt.com') + '/studio/v2.html?topup=success',
            cancel_url: (process.env.APP_URL || 'https://viewhunt.com') + '/studio/v2.html?topup=cancelled',
            metadata: {
                userId: user._id.toString(),
                type: 'credit_topup',
                credits: String(packInfo.credits)
            }
        });

        res.json({ success: true, url: session.url });
    } catch (err) {
        console.error('Credit purchase error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Verify and fulfill a credit purchase if webhook missed it
router.post('/credits/verify-purchase', requireAuth, async (req, res) => {
    try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        if (!stripe) return res.json({ credited: false, reason: 'Stripe not configured' });

        const db = await getDb();
        const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.userId) });
        
        if (!user || !user.subscription?.stripeCustomerId) {
            return res.json({ credited: false, reason: 'No Stripe customer' });
        }

        // Find recent completed checkout sessions for this customer
        const sessions = await stripe.checkout.sessions.list({
            customer: user.subscription.stripeCustomerId,
            limit: 5
        });

        var credited = false;
        for (var i = 0; i < sessions.data.length; i++) {
            var session = sessions.data[i];
            var meta = session.metadata || {};
            
            // Only process credit top-ups that completed
            if (meta.type !== 'credit_topup' || session.payment_status !== 'paid') continue;
            
            // Check if this session was already processed
            var existing = await db.collection('credit_transactions').findOne({
                stripeSessionId: session.id
            });
            
            if (!existing) {
                // Grant the credits
                var amount = parseInt(meta.credits) || 100;
                await credits.addTopUpCredits(meta.userId || String(user._id), amount, session.id);
                console.log('💳 Verify-purchase: granted ' + amount + ' credits for session ' + session.id);
                credited = true;
                break; // Only process the most recent unfulfilled one
            }
        }

        res.json({ credited: credited });
    } catch (err) {
        console.error('Verify purchase error:', err);
        res.json({ credited: false, reason: err.message });
    }
});

// Admin: manually grant credits (admin only)
router.post('/credits/admin-grant', requireAuth, async (req, res) => {
    try {
        if (req.user.email !== process.env.ADMIN_EMAIL) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const { amount, plan, email } = req.body;
        if (!amount || amount < 1) return res.status(400).json({ error: 'Amount required' });
        
        var userId;
        
        // If email is provided, find that user and grant to them
        if (email) {
            const db = await getDb();
            const targetUser = await db.collection('users').findOne({ email: email });
            if (!targetUser) return res.status(404).json({ error: 'User not found: ' + email });
            userId = String(targetUser._id);
            console.log(`Admin granting ${amount} credits to ${email} (${userId})`);
        } else {
            userId = String(req.user.userId);
        }
        
        if (plan) {
            await credits.adminSetCredits(userId, amount, plan);
        } else {
            await credits.addTopUpCredits(userId, amount, 'admin-grant-' + Date.now());
        }
        var bal = await credits.getBalance(userId);
        res.json({ success: true, email: email || req.user.email, ...bal, totalAvailable: (bal.balance || 0) + (bal.topUpBalance || 0) });
    } catch (err) {
        console.error('Admin grant error:', err);
        res.status(500).json({ error: err.message });
    }
});

// === AI STORYTELLING FORMAT ENDPOINTS ===

const StorytellingGenerator = require('./formats/storytelling/generator');
const storytellingGenerators = {};
function getStorytellingGenerator() {
    if (!storytellingGenerators.default) {
        storytellingGenerators.default = new StorytellingGenerator();
    }
    return storytellingGenerators.default;
}

// Step 1: Break script into scenes (Claude)
router.post('/storytelling/scenes', requireAuth, async (req, res) => {
    try {
        const { script } = req.body;
        if (!script) return res.status(400).json({ error: 'Script is required' });

        // Credit check: script generation = 5 credits
        const userId = String(req.user.userId);
        const check = await credits.checkCredits(userId, 'script_generation', 1);
        if (!check.allowed) {
            return res.status(402).json({ error: 'Not enough credits', ...check });
        }

        const generator = getStorytellingGenerator();
        console.log('Storytelling: breaking script into scenes...');
        const data = await generator.generateScenePrompts(script);

        // Deduct credits on success
        await credits.deductCredits(userId, 'script_generation', 1, 'Storytelling scene breakdown');

        res.json({ success: true, scenes: data.scenes, characters: data.characters || [] });
    } catch (error) {
        console.error('Storytelling scene breakdown error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Step 2: Generate video for a single scene (Sora 2)
router.post('/storytelling/generate-video', requireAuth, studioGenerateLimiter, async (req, res) => {
    try {
        const { videoPrompt, sceneNumber } = req.body;
        if (!videoPrompt) return res.status(400).json({ error: 'videoPrompt is required' });

        // Credit check: video_generation = 5 credits
        const userId = String(req.user.userId);
        const check = await credits.checkCredits(userId, 'video_generation', 1);
        if (!check.allowed) {
            return res.status(402).json({ error: 'Not enough credits', ...check });
        }

        const generator = getStorytellingGenerator();

        const videoUrl = await generator.generateVideo(videoPrompt, sceneNumber || 1);

        // Charge only on success
        await credits.deductCredits(userId, 'video_generation', 1, 'Storytelling video scene ' + (sceneNumber || '?'));

        console.log(`Storytelling: scene ${sceneNumber} video complete`);
        res.json({ success: true, sceneNumber, videoUrl });
    } catch (error) {
        console.error('Storytelling video generation error:', error.message);
        res.status(500).json({ error: 'Generation failed — no credits deducted. If this persists, please try again in an hour.' });
    }
});

// === RANKING FORMAT ENDPOINTS ===

// Multer for ranking video uploads (up to 50MB per clip)
const rankingUploadDir = path.join(__dirname, '../public/studio/ranking-uploads');
if (!fs.existsSync(rankingUploadDir)) {
    fs.mkdirSync(rankingUploadDir, { recursive: true });
}
const rankingUpload = multer({
    storage: multer.diskStorage({
        destination: rankingUploadDir,
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname) || '.mp4';
            cb(null, `clip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
        }
    }),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/')) cb(null, true);
        else cb(new Error('Only video files allowed'));
    }
});

// Upload a ranking clip (with multer error handling)
router.post('/ranking/upload', requireAuth, function(req, res) {
    rankingUpload.single('clip')(req, res, async function(err) {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ error: 'File too large. Maximum 50MB per clip.' });
            }
            return res.status(400).json({ error: err.message });
        }
        try {
            if (!req.file) return res.status(400).json({ error: 'No video file provided' });

            var assembler = new RankingAssembler();
            var filePath = req.file.path;
            var info = await assembler.getVideoInfo(filePath);
            var duration = await assembler.getDuration(filePath);

            var url = '/studio/ranking-uploads/' + req.file.filename;
            console.log('🏆 Ranking clip uploaded: ' + url + ' (' + duration.toFixed(1) + 's)');

            res.json({
                success: true,
                url: url,
                filename: req.file.filename,
                duration: duration,
                width: info.width,
                height: info.height
            });
        } catch (error) {
            console.error('Ranking upload error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });
});

// Import a ranking clip from URL (yt-dlp — latest binary)
const { execFile } = require('child_process');
const https = require('https');
const axios = require('axios');

// Apify-based video download for TikTok and YouTube
async function downloadViaApify(url, outPath) {
    var apifyToken = process.env.APIFY_TOKEN;
    if (!apifyToken) throw new Error('APIFY_TOKEN not configured');

    var isTikTok = /tiktok\.com|vm\.tiktok|vt\.tiktok/i.test(url);
    var isYouTube = /youtube\.com|youtu\.be|youtube\.com\/shorts/i.test(url);

    if (isTikTok) {
        console.log('🎵 TikTok download via Apify: ' + url);
        var resp = await axios.post(
            'https://api.apify.com/v2/acts/thenetaji~tiktok-video-downloader/run-sync-get-dataset-items?token=' + apifyToken,
            {
                urls: [{ url: url }],
                quality: 'best',
                format: 'mp4',
                proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
        );

        var items = resp.data;
        if (!Array.isArray(items) || items.length === 0) throw new Error('Apify returned no results for TikTok video');

        // Find the download URL from the dataset items
        var item = items[0];
        var videoUrl = item.videoUrlNoWatermark || item.videoUrl || item.downloadUrl || item.url;
        if (!videoUrl && item.video) videoUrl = item.video.downloadAddr || item.video.playAddr;
        if (!videoUrl) {
            console.warn('Apify TikTok response keys:', Object.keys(item));
            throw new Error('Could not find video URL in Apify response');
        }

        console.log('  TikTok video URL found, downloading to server...');
        await downloadFileToPath(videoUrl, outPath);
        return true;

    } else if (isYouTube) {
        console.log('📺 YouTube download via Apify: ' + url);
        // YouTube downloader returns data in the key-value store, use run-sync
        var runResp = await axios.post(
            'https://api.apify.com/v2/acts/streamers~youtube-video-downloader/runs?token=' + apifyToken,
            {
                videos: [{ url: url }],
                preferredQuality: '720p',
                preferredFormat: 'mp4'
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
        );

        var runData = runResp.data?.data;
        if (!runData?.id) throw new Error('Failed to start YouTube download actor');

        var runId = runData.id;
        console.log('  YouTube actor run started: ' + runId);

        // Poll for completion (max 3 minutes)
        var startTime = Date.now();
        var runStatus;
        while (Date.now() - startTime < 180000) {
            await new Promise(r => setTimeout(r, 5000));
            var statusResp = await axios.get(
                'https://api.apify.com/v2/actor-runs/' + runId + '?token=' + apifyToken,
                { timeout: 15000 }
            );
            runStatus = statusResp.data?.data?.status;
            if (runStatus === 'SUCCEEDED') break;
            if (runStatus === 'FAILED' || runStatus === 'ABORTED' || runStatus === 'TIMED-OUT') {
                throw new Error('YouTube download failed: ' + runStatus);
            }
        }
        if (runStatus !== 'SUCCEEDED') throw new Error('YouTube download timed out');

        // Get dataset items
        var datasetId = runResp.data?.data?.defaultDatasetId;
        if (!datasetId) throw new Error('No dataset ID from YouTube actor');

        var dsResp = await axios.get(
            'https://api.apify.com/v2/datasets/' + datasetId + '/items?token=' + apifyToken,
            { timeout: 30000 }
        );

        var dsItems = dsResp.data;
        if (!Array.isArray(dsItems) || dsItems.length === 0) throw new Error('No items in YouTube dataset');

        var ytItem = dsItems[0];
        var ytVideoUrl = ytItem.url || ytItem.videoUrl || ytItem.downloadUrl;
        if (!ytVideoUrl) {
            // Try key-value store
            var kvStoreId = runResp.data?.data?.defaultKeyValueStoreId;
            if (kvStoreId) {
                var kvResp = await axios.get(
                    'https://api.apify.com/v2/key-value-stores/' + kvStoreId + '/keys?token=' + apifyToken,
                    { timeout: 15000 }
                );
                var keys = kvResp.data?.data?.items || [];
                var videoKey = keys.find(k => k.key && (k.key.endsWith('.mp4') || k.contentType?.includes('video')));
                if (videoKey) {
                    ytVideoUrl = 'https://api.apify.com/v2/key-value-stores/' + kvStoreId + '/records/' + encodeURIComponent(videoKey.key) + '?token=' + apifyToken;
                }
            }
            if (!ytVideoUrl) {
                console.warn('YouTube dataset item keys:', Object.keys(ytItem));
                throw new Error('Could not find video URL in YouTube response');
            }
        }

        console.log('  YouTube video URL found, downloading to server...');
        await downloadFileToPath(ytVideoUrl, outPath);
        return true;
    }

    return false; // Not a TikTok/YouTube URL
}

// Download a file from URL to local path
function downloadFileToPath(url, outPath) {
    return new Promise(function(resolve, reject) {
        var fileStream = fs.createWriteStream(outPath);
        function doGet(getUrl, redirects) {
            if (redirects > 5) return reject(new Error('Too many redirects'));
            var mod = getUrl.startsWith('https') ? https : require('http');
            mod.get(getUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 120000 }, function(resp) {
                if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
                    return doGet(resp.headers.location, (redirects || 0) + 1);
                }
                if (resp.statusCode !== 200) {
                    fileStream.close();
                    try { fs.unlinkSync(outPath); } catch(e) {}
                    return reject(new Error('Download failed: HTTP ' + resp.statusCode));
                }
                resp.pipe(fileStream);
                fileStream.on('finish', function() { fileStream.close(resolve); });
                resp.on('error', function(e) { fileStream.close(); reject(e); });
            }).on('error', function(e) { fileStream.close(); reject(e); });
        }
        doGet(url, 0);
    });
}

// Download latest yt-dlp binary if not present (or older than 24h)
var ytdlpPath = path.join(__dirname, '../public/studio/ranking-uploads', '.yt-dlp');
async function ensureYtdlp() {
    var needsDownload = false;
    if (!fs.existsSync(ytdlpPath)) { needsDownload = true; }
    else {
        // Re-download if older than 24 hours
        var stat = fs.statSync(ytdlpPath);
        if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) needsDownload = true;
    }
    if (!needsDownload) return ytdlpPath;

    console.log('Downloading latest yt-dlp binary...');
    var dlUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
    // Detect platform
    if (process.platform === 'darwin') dlUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
    else if (process.platform === 'win32') dlUrl = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

    return new Promise(function(resolve, reject) {
        function download(downloadUrl, redirects) {
            if (redirects > 5) return reject(new Error('Too many redirects'));
            var mod = downloadUrl.startsWith('https') ? https : require('http');
            mod.get(downloadUrl, { headers: { 'User-Agent': 'ViewHunt/1.0' } }, function(resp) {
                if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
                    return download(resp.headers.location, (redirects || 0) + 1);
                }
                if (resp.statusCode !== 200) return reject(new Error('Download failed: HTTP ' + resp.statusCode));
                var chunks = [];
                resp.on('data', function(c) { chunks.push(c); });
                resp.on('end', function() {
                    var buf = Buffer.concat(chunks);
                    fs.writeFileSync(ytdlpPath, buf);
                    fs.chmodSync(ytdlpPath, 0o755);
                    console.log('yt-dlp binary downloaded (' + (buf.length / 1024 / 1024).toFixed(1) + 'MB)');
                    resolve(ytdlpPath);
                });
                resp.on('error', reject);
            }).on('error', reject);
        }
        download(dlUrl, 0);
    });
}

function runYtdlp(args, timeoutMs) {
    return new Promise(function(resolve, reject) {
        var proc = execFile(ytdlpPath, args, { timeout: timeoutMs || 120000, maxBuffer: 10 * 1024 * 1024 }, function(err, stdout, stderr) {
            if (err) {
                var msg = (stderr || '') + ' ' + (err.message || '');
                reject(new Error(msg.trim()));
            } else {
                resolve((stdout || '').trim());
            }
        });
    });
}

const urlImportLimiter = rateLimit({ windowMs: 60000, max: 5, message: { error: 'Too many imports. Wait a minute.' } });
router.post('/ranking/import-url', requireAuth, urlImportLimiter, async (req, res) => {
    try {
        var { url } = req.body;
        if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL required' });

        url = url.trim();
        if (!/^https?:\/\/.+/i.test(url)) return res.status(400).json({ error: 'Invalid URL' });

        // Ensure we have the latest yt-dlp
        try { await ensureYtdlp(); }
        catch (e) {
            console.error('yt-dlp download failed:', e.message);
            return res.status(500).json({ error: 'Video downloader not available. Upload files directly.' });
        }

        var outName = 'clip-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.mp4';
        var outPath = path.join(rankingUploadDir, outName);

        console.log('Ranking URL import: ' + url);

        // Try Apify first for TikTok/YouTube, fall back to yt-dlp for other URLs
        var isTikTokOrYT = /tiktok\.com|vm\.tiktok|vt\.tiktok|youtube\.com|youtu\.be/i.test(url);
        var downloaded = false;

        if (isTikTokOrYT) {
            try {
                downloaded = await downloadViaApify(url, outPath);
                if (downloaded) console.log('  ✅ Apify download succeeded');
            } catch (apifyErr) {
                console.warn('  ⚠️ Apify download failed, falling back to yt-dlp:', apifyErr.message);
                downloaded = false;
            }
        }

        if (!downloaded) {
            var args = [
                url,
                '-o', outPath,
                '-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]/best',
                '--merge-output-format', 'mp4',
                '--no-playlist',
                '--no-check-certificates',
                '--no-warnings',
                '--socket-timeout', '30',
                '--extractor-args', 'youtube:player_client=ios,mweb',
                '--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
            ];

            await runYtdlp(args, 120000);
        }

        if (!fs.existsSync(outPath)) {
            return res.status(500).json({ error: 'Download failed — no output file' });
        }

        var stat = fs.statSync(outPath);
        if (stat.size > 50 * 1024 * 1024) {
            fs.unlinkSync(outPath);
            return res.status(413).json({ error: 'Downloaded video too large (over 50MB). Try a shorter clip.' });
        }

        var assembler = new RankingAssembler();
        var info = await assembler.getVideoInfo(outPath);
        var duration = await assembler.getDuration(outPath);

        var clipUrl = '/studio/ranking-uploads/' + outName;
        console.log('Ranking URL import done: ' + clipUrl + ' (' + duration.toFixed(1) + 's, ' + (stat.size / 1024 / 1024).toFixed(1) + 'MB)');

        res.json({
            success: true,
            url: clipUrl,
            filename: outName,
            duration: duration,
            width: info.width,
            height: info.height
        });
    } catch (error) {
        console.error('Ranking URL import error:', error.message);
        var msg = error.message || '';
        if (msg.includes('not found') || msg.includes('ENOENT')) msg = 'Video downloader not available. Upload files directly.';
        else if (msg.includes('Unsupported URL')) msg = 'Unsupported URL. Try YouTube, TikTok, Instagram, Twitter, etc.';
        else if (msg.includes('Private video') || msg.includes('Sign in') || msg.includes('login')) msg = 'This video requires login or is private. Try a different video or upload directly.';
        else if (msg.includes('Video not available')) msg = 'Video not available on this platform. Try uploading the file directly.';
        else if (msg.length > 200) msg = msg.substring(0, 200);
        res.status(500).json({ error: msg });
    }
});

// Trim a ranking clip
router.post('/ranking/trim', requireAuth, async (req, res) => {
    try {
        var { filename, startTime, endTime } = req.body;
        if (!filename) return res.status(400).json({ error: 'filename required' });

        var inputPath = path.join(rankingUploadDir, filename);
        if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'Clip not found' });

        var assembler = new RankingAssembler();
        var trimmedName = 'trimmed-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.mp4';
        var outputPath = path.join(rankingUploadDir, trimmedName);

        await assembler.trimClip(inputPath, startTime || 0, endTime, outputPath);
        var duration = await assembler.getDuration(outputPath);

        console.log('🏆 Clip trimmed: ' + trimmedName + ' (' + duration.toFixed(1) + 's)');

        res.json({
            success: true,
            url: '/studio/ranking-uploads/' + trimmedName,
            filename: trimmedName,
            duration: duration
        });
    } catch (error) {
        console.error('Ranking trim error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Get clip info (duration, dimensions)
router.post('/ranking/clip-info', requireAuth, async (req, res) => {
    try {
        var { filename } = req.body;
        if (!filename) return res.status(400).json({ error: 'filename required' });

        var filePath = path.join(rankingUploadDir, filename);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Clip not found' });

        var assembler = new RankingAssembler();
        var info = await assembler.getVideoInfo(filePath);
        var duration = await assembler.getDuration(filePath);

        res.json({ success: true, duration: duration, width: info.width, height: info.height });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Assemble ranking video
router.post('/ranking/assemble', requireAuth, studioAssemblyLimiter, async (req, res) => {
    try {
        var { clips, title, layout, commentary: enableCommentary, voiceName, colorPalette, checkeredMode, subtitleFont, subtitleY, subtitleColor } = req.body;
        // clips: [{ filename, number, label, startTime, endTime }]
        // title: { text, highlightWord, highlightColor }
        // commentary: boolean — if true, generate AI commentary voiceovers

        if (!clips || !Array.isArray(clips) || clips.length === 0) {
            return res.status(400).json({ error: 'At least one clip is required' });
        }

        // Credit check — ranking_assembly = 2 credits, commentary adds script_generation cost
        var userId = String(req.user.userId);
        var creditType = enableCommentary ? 'ranking_assembly' : 'ranking_assembly';
        var check = await credits.checkCredits(userId, creditType, 1);
        if (!check.allowed) {
            return res.status(402).json({ error: 'Not enough credits', ...check });
        }

        // Deduct upfront (refund on failure)
        await credits.deductCredits(userId, 'ranking_assembly', 1, 'Ranking video assembly');

        var assembler = new RankingAssembler();

        // Build clip list with full paths
        var clipList = clips.map(function(c, i) {
            var filePath = path.join(rankingUploadDir, c.filename);
            if (!fs.existsSync(filePath)) throw new Error('Clip not found: ' + c.filename);
            return {
                path: filePath,
                number: c.number || (i + 1),
                label: c.label || ''
            };
        });

        // Generate AI commentary if enabled
        var commentaryData = [];
        if (enableCommentary && title && title.text) {
            try {
                console.log('🎙️ Generating AI commentary for ranking video...');
                var RankingCommentary = require('./formats/ranking/commentary');
                var commentaryGen = new RankingCommentary();
                var commentaryResults = await commentaryGen.generateCommentary(clipList, title.text, voiceName || 'Kore');
                commentaryData = commentaryResults.filter(function(c) { return c.audioPath; });

                // Charge for commentary (script_generation cost)
                if (commentaryData.length > 0) {
                    await credits.deductCredits(userId, 'script_generation', 1, 'Ranking AI commentary');
                }
            } catch (commentaryErr) {
                console.warn('Commentary generation failed, assembling without:', commentaryErr.message);
                // Don't fail the whole assembly — just skip commentary
            }
        }

        var result = await assembler.assemble(clipList, title || {}, {
            layout: layout || {},
            commentary: commentaryData,
            commentaryLines: enableCommentary ? commentaryResults || [] : [],
            colorPalette: colorPalette || 'yellow',
            checkeredMode: !!checkeredMode,
            subtitleFont: subtitleFont || 'Arial',
            subtitleY: subtitleY != null ? subtitleY : 55,
            subtitleColor: subtitleColor || 'yellow',
            hookEnabled: !!enableCommentary
        });

        console.log('🏆 Ranking video assembled: ' + result.videoUrl + (commentaryData.length > 0 ? ' (with ' + commentaryData.length + ' commentary lines)' : ''));
        res.json({ success: true, ...result, hasCommentary: commentaryData.length > 0 });

    } catch (error) {
        console.error('Ranking assembly error:', error.message);
        // Refund on failure
        try {
            var userId2 = String(req.user.userId);
            await credits.refundCredits(userId2, 'ranking_assembly', 1, 'Assembly failed: ' + error.message);
        } catch (refundErr) {
            console.error('Ranking refund error:', refundErr.message);
        }
        res.status(500).json({ error: error.message });
    }
});

// Delete a ranking clip (cleanup)
router.delete('/ranking/clip/:filename', requireAuth, (req, res) => {
    try {
        var filePath = path.join(rankingUploadDir, req.params.filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log('🏆 Clip deleted: ' + req.params.filename);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check
router.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        availableFormats: ['skeleton-anatomy', 'ranking', 'avatar']
    });
});

// === AI AVATAR FORMAT ENDPOINTS ===

const AvatarGenerator = require('./formats/avatar/generator');
const avatarGenerators = {};
function getAvatarGenerator() {
    if (!avatarGenerators.default) avatarGenerators.default = new AvatarGenerator();
    return avatarGenerators.default;
}

// Avatar photo upload (multer for multipart)
const avatarUploadDir = path.join(__dirname, '../public/studio/uploads/avatar');
if (!fs.existsSync(avatarUploadDir)) fs.mkdirSync(avatarUploadDir, { recursive: true });
const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 30 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only image files allowed'));
    }
});

// List user's characters
router.get('/avatar/characters', requireAuth, async (req, res) => {
    try {
        var userId = String(req.user.userId);
        var db = await getDb();
        var chars = await db.collection('avatar_characters')
            .find({ userId: userId })
            .sort({ createdAt: -1 })
            .toArray();

        // Refresh status for any non-completed characters from Higgsfield
        var gen = getAvatarGenerator();
        for (var i = 0; i < chars.length; i++) {
            var c = chars[i];
            if (c.status !== 'completed' && c.status !== 'failed' && c.higgsId) {
                try {
                    var hfChar = await gen.getCharacterStatus(c.higgsId);
                    if (hfChar.status !== c.status) {
                        await db.collection('avatar_characters').updateOne(
                            { _id: c._id },
                            { $set: { status: hfChar.status, thumbnailUrl: hfChar.thumbnail_url || c.thumbnailUrl, updatedAt: new Date() } }
                        );
                        chars[i].status = hfChar.status;
                        chars[i].thumbnailUrl = hfChar.thumbnail_url || c.thumbnailUrl;
                    }
                } catch (e) { /* ignore polling errors */ }
            }
        }

        res.json({
            success: true,
            characters: chars.map(function(c) {
                return { id: c._id.toString(), higgsId: c.higgsId, name: c.name, status: c.status, thumbnailUrl: c.thumbnailUrl || null, createdAt: c.createdAt };
            })
        });
    } catch (error) {
        console.error('Avatar list characters error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Create a new character (upload photos → S3 → Higgsfield)
router.post('/avatar/characters', requireAuth, avatarUpload.array('photos', 30), async (req, res) => {
    try {
        var userId = String(req.user.userId);
        var name = req.body.name;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Character name required' });
        if (!req.files || req.files.length < 5) return res.status(400).json({ error: 'Upload at least 5 photos' });

        var gen = getAvatarGenerator();

        // Upload each photo to S3
        console.log('🎭 Avatar: uploading ' + req.files.length + ' photos to S3...');
        var imageUrls = [];
        for (var i = 0; i < req.files.length; i++) {
            var f = req.files[i];
            var url = await gen.uploadToS3(f.buffer, f.originalname, f.mimetype);
            imageUrls.push(url);
        }

        // Create character on Higgsfield
        var hfChar = await gen.createCharacter(name.trim(), imageUrls);

        // Save to our DB
        var db = await getDb();
        var doc = {
            userId: userId,
            higgsId: hfChar.id,
            name: name.trim(),
            status: hfChar.status || 'not_ready',
            thumbnailUrl: hfChar.thumbnail_url || null,
            imageUrls: imageUrls,
            createdAt: new Date()
        };
        await db.collection('avatar_characters').insertOne(doc);

        console.log('🎭 Avatar: character created — ' + name + ' (' + req.files.length + ' photos)');
        res.json({ success: true, id: doc._id || hfChar.id, status: doc.status });
    } catch (error) {
        console.error('Avatar create character error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Delete a character
router.delete('/avatar/characters/:id', requireAuth, async (req, res) => {
    try {
        var userId = String(req.user.userId);
        var db = await getDb();
        await db.collection('avatar_characters').deleteOne({ _id: new ObjectId(req.params.id), userId: userId });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get available styles
router.get('/avatar/styles', requireAuth, async (req, res) => {
    try {
        var gen = getAvatarGenerator();
        var styles = await gen.getStyles();
        res.json({ success: true, styles: styles });
    } catch (error) {
        console.error('Avatar styles error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Upload a reference image (for GPT-4o Vision description)
const refUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.post('/avatar/upload-reference', requireAuth, refUpload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image provided' });
        var gen = getAvatarGenerator();
        var url = await gen.uploadToS3(req.file.buffer, req.file.originalname, req.file.mimetype);
        res.json({ success: true, url: url });
    } catch (error) {
        console.error('Avatar ref upload error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Generate images
router.post('/avatar/generate', requireAuth, studioGenerateLimiter, async (req, res) => {
    try {
        var userId = String(req.user.userId);
        var { characterId, prompt, styleId, size, batchSize, referenceImageUrl } = req.body;

        if (!characterId) return res.status(400).json({ error: 'Select a character' });

        // Verify character belongs to user and is ready
        var db = await getDb();
        var char = await db.collection('avatar_characters').findOne({ userId: userId, higgsId: characterId });
        if (!char) {
            try { char = await db.collection('avatar_characters').findOne({ userId: userId, _id: new ObjectId(characterId) }); } catch(e) {}
        }
        if (!char) return res.status(404).json({ error: 'Character not found' });
        if (char.status !== 'completed') return res.status(400).json({ error: 'Character is still training. Please wait.' });

        var gen = getAvatarGenerator();

        // If reference image, describe it with GPT-4o Vision
        var finalPrompt = prompt || '';
        if (referenceImageUrl) {
            try {
                finalPrompt = await gen.describeReferenceImage(referenceImageUrl, prompt);
                console.log('🎭 Avatar: GPT-4o described reference → ' + finalPrompt.substring(0, 80) + '...');
            } catch (e) {
                console.warn('GPT-4o Vision failed, using raw prompt:', e.message);
                if (!finalPrompt) return res.status(400).json({ error: 'Could not describe reference image and no prompt provided' });
            }
        }

        if (!finalPrompt) return res.status(400).json({ error: 'Prompt required' });

        // Credit check: 0.5 per image (batch of 4 = 2 credits, single = 0.5)
        var count = batchSize === 1 ? 1 : 4;
        var check = await credits.checkCredits(userId, 'image_generation', count);
        if (!check.allowed) return res.status(402).json({ error: 'Not enough credits', ...check });

        // Generate
        var result = await gen.generateImages({
            prompt: finalPrompt,
            characterId: char.higgsId,
            styleId: styleId,
            size: size,
            batchSize: count
        });

        // Deduct credits on successful submission
        await credits.deductCredits(userId, 'image_generation', count, 'Avatar image generation (' + count + ' images)');

        res.json({ success: true, jobSetId: result.jobSetId });
    } catch (error) {
        console.error('Avatar generate error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Poll generation status
router.get('/avatar/poll/:jobSetId', requireAuth, async (req, res) => {
    try {
        var gen = getAvatarGenerator();
        var jobSetId = req.params.jobSetId;

        var pollRes = await axios.get('https://platform.higgsfield.ai/v1/job-sets/' + jobSetId, {
            headers: gen._hfHeaders(), timeout: 15000
        });
        var jobs = pollRes.data.jobs || [];
        var allDone = jobs.every(function(j) {
            return j.status === 'completed' || j.status === 'failed' || j.status === 'nsfw';
        });

        var results = jobs.map(function(j) {
            var r = { status: j.status, imageUrl: null, rawUrl: null };
            if (j.status === 'completed' && j.results) {
                r.imageUrl = j.results.min ? j.results.min.url : null;
                r.rawUrl = j.results.raw ? j.results.raw.url : null;
            }
            return r;
        });

        // If all done, save to gallery
        if (allDone) {
            var userId = String(req.user.userId);
            var db = await getDb();
            var completedImages = results.filter(function(r) { return r.status === 'completed' && r.imageUrl; });
            if (completedImages.length > 0) {
                await db.collection('avatar_generations').insertOne({
                    userId: userId,
                    jobSetId: jobSetId,
                    images: completedImages,
                    createdAt: new Date()
                });
            }
            // Refund for failed images
            var failedCount = results.filter(function(r) { return r.status === 'failed' || r.status === 'nsfw'; }).length;
            if (failedCount > 0) {
                try { await credits.refundCredits(userId, 'image_generation', failedCount, 'Avatar generation failed/nsfw'); } catch(e) {}
            }
        }

        res.json({ success: true, status: allDone ? 'completed' : 'generating', results: results });
    } catch (error) {
        console.error('Avatar poll error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Gallery — list past generations
router.get('/avatar/gallery', requireAuth, async (req, res) => {
    try {
        var userId = String(req.user.userId);
        var db = await getDb();
        var gens = await db.collection('avatar_generations')
            .find({ userId: userId })
            .sort({ createdAt: -1 })
            .limit(50)
            .toArray();
        res.json({ success: true, generations: gens });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// === BACKGROUND TASK ENDPOINTS ===

// Create a background generation task
router.post('/tasks/create', requireAuth, studioGenerateLimiter, async (req, res) => {
    try {
        const userId = String(req.user.userId);
        const { format, script, skeletonStyle, gradientColors, generateVideos, videoModel } = req.body;

        if (!script || !script.trim()) {
            return res.status(400).json({ error: 'Script is required' });
        }

        // Check concurrent task limit
        const canCreate = await taskManager.canCreateTask(userId);
        if (!canCreate.allowed) {
            return res.status(429).json({
                error: 'You already have ' + canCreate.running + ' task(s) running. Your plan allows ' + canCreate.limit + ' concurrent task(s).',
                running: canCreate.running,
                limit: canCreate.limit,
                plan: canCreate.plan
            });
        }

        // Estimate credits needed
        var wordCount = script.trim().split(/\s+/).length;
        var estimatedScenes = Math.max(4, Math.min(16, Math.round(wordCount / 20)));
        var estimatedCost = credits.COSTS.script_generation;
        estimatedCost += credits.COSTS.image_generation * estimatedScenes;
        if (generateVideos !== false) estimatedCost += credits.COSTS.video_generation * estimatedScenes;

        const bal = await credits.getBalance(userId);
        const totalAvailable = (bal.balance || 0) + (bal.topUpBalance || 0);
        if (totalAvailable < estimatedCost) {
            return res.status(402).json({
                error: 'Not enough credits. Need ~' + Math.ceil(estimatedCost) + ' credits.',
                balance: bal.balance,
                topUpBalance: bal.topUpBalance || 0,
                totalAvailable,
                estimatedCost: Math.ceil(estimatedCost)
            });
        }

        // Resolve video model (only admin can use kling)
        const resolvedModel = (['kling','sora2'].includes(videoModel) && req.user.email === process.env.ADMIN_EMAIL) ? videoModel : 'wan';

        // Create the task
        const task = await taskManager.createTask(userId, {
            format: format || 'skeleton-anatomy',
            script: script.trim(),
            skeletonStyle,
            gradientColors,
            generateVideos: generateVideos !== false,
            videoModel: resolvedModel
        });

        // Get the generator and start the task in the background
        const generator = getGenerator(format || 'skeleton-anatomy', 'v2');
        if (!generator) {
            return res.status(400).json({ error: 'Invalid format' });
        }

        taskManager.runTask(task._id, generator, userId);

        res.json({
            success: true,
            taskId: task._id.toString(),
            status: 'pending',
            estimatedCost: Math.ceil(estimatedCost),
            message: 'Task started. You can close this tab — generation will continue in the background.'
        });

    } catch (error) {
        console.error('Task creation error:', error);
        res.status(500).json({ error: error.message });
    }
});

// List user's tasks
router.get('/tasks', requireAuth, async (req, res) => {
    try {
        const userId = String(req.user.userId);
        const tasks = await taskManager.listTasks(userId, 20);

        // Slim down the response (don't send full scene prompts in list view)
        const slim = tasks.map(t => ({
            id: t._id.toString(),
            status: t.status,
            format: t.format,
            progress: t.progress,
            scenesCount: (t.scenes || []).length,
            creditsCharged: t.creditsCharged || 0,
            assemblyVideoUrl: t.assemblyVideoUrl || null,
            createdAt: t.createdAt,
            completedAt: t.completedAt,
            error: t.error,
            // Include first line of script as preview
            scriptPreview: (t.config && t.config.script) ? t.config.script.substring(0, 80) + (t.config.script.length > 80 ? '...' : '') : ''
        }));

        res.json({ success: true, tasks: slim });
    } catch (error) {
        console.error('Task list error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get single task detail (full scene data)
router.get('/tasks/:id', requireAuth, async (req, res) => {
    try {
        const userId = String(req.user.userId);
        const task = await taskManager.getTask(req.params.id, userId);
        if (!task) return res.status(404).json({ error: 'Task not found' });

        res.json({
            success: true,
            task: {
                id: task._id.toString(),
                status: task.status,
                format: task.format,
                config: task.config,
                progress: task.progress,
                scenes: task.scenes || [],
                creditsCharged: task.creditsCharged || 0,
                assemblyVideoUrl: task.assemblyVideoUrl || null,
                createdAt: task.createdAt,
                startedAt: task.startedAt,
                completedAt: task.completedAt,
                error: task.error
            }
        });
    } catch (error) {
        console.error('Task detail error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Save assembly video URL to a task (manual re-assembly)
router.patch('/tasks/:id/assembly', requireAuth, async (req, res) => {
    try {
        const userId = String(req.user.userId);
        const task = await taskManager.getTask(req.params.id, userId);
        if (!task) return res.status(404).json({ error: 'Task not found' });
        const { assemblyVideoUrl } = req.body;
        if (!assemblyVideoUrl) return res.status(400).json({ error: 'assemblyVideoUrl is required' });
        const db = await getDb();
        await db.collection('generation_tasks').updateOne(
            { _id: new ObjectId(req.params.id) },
            { $set: { assemblyVideoUrl, updatedAt: new Date() } }
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Task assembly update error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Update a scene in a completed task (e.g. after retrying a failed video)
router.patch('/tasks/:id/scene/:sceneIndex', requireAuth, async (req, res) => {
    try {
        const userId = String(req.user.userId);
        const task = await taskManager.getTask(req.params.id, userId);
        if (!task) return res.status(404).json({ error: 'Task not found' });
        if (task.status !== 'completed') return res.status(400).json({ error: 'Can only update completed tasks' });

        const sceneIndex = parseInt(req.params.sceneIndex, 10);
        if (isNaN(sceneIndex) || sceneIndex < 0 || sceneIndex >= (task.scenes || []).length) {
            return res.status(400).json({ error: 'Invalid scene index' });
        }

        const { videoUrl } = req.body;
        if (!videoUrl) return res.status(400).json({ error: 'videoUrl is required' });

        // Update the scene in the task document
        const scene = task.scenes[sceneIndex];
        scene.videoUrl = videoUrl;
        scene.videoError = null;
        await taskManager.saveScene(req.params.id, sceneIndex, scene);

        // Recalculate progress counts
        const scenes = task.scenes;
        scenes[sceneIndex] = scene;
        const videosCompleted = scenes.filter(s => s.videoUrl).length;
        const videosFailed = scenes.filter(s => s.imageUrl && !s.videoUrl).length;
        const msg = videosCompleted > 0
            ? `Generated ${task.progress.imagesCompleted} images and ${videosCompleted} videos — ready to assemble`
            : task.progress.message;

        await taskManager.updateProgress(req.params.id, {
            ...task.progress,
            videosCompleted,
            videosFailed,
            message: msg
        });

        console.log(`📋 Task ${req.params.id}: scene ${sceneIndex} video updated via retry`);
        res.json({ success: true, videosCompleted, videosFailed });
    } catch (error) {
        console.error('Task scene update error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Cancel a running task
router.delete('/tasks/:id', requireAuth, async (req, res) => {
    try {
        const userId = String(req.user.userId);
        const result = await taskManager.cancelTask(req.params.id, userId);
        res.json(result);
    } catch (error) {
        console.error('Task cancel error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
