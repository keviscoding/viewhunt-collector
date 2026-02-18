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

// Generate Script
router.post('/generate/script', requireAuth, studioGenerateLimiter, async (req, res) => {
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
router.post('/generate/images', requireAuth, studioGenerateLimiter, async (req, res) => {
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
        const { format, script, skeletonStyle, gradientColors, generateVideos } = req.body;
        
        if (!format || !script) {
            return res.status(400).json({ error: 'Format and script are required' });
        }
        
        // Credit check: at least enough for script generation
        const userId = String(req.user.userId);
        const check = await credits.checkCredits(userId, 'script_generation', 1);
        if (!check.allowed) {
            return res.status(402).json({ error: 'Not enough credits', ...check });
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
        
        // Estimate credit cost for auto mode (script + ~12 scenes images + ~12 scenes videos + assembly)
        // Rough estimate: 5 + 12*3 + 12*8 + 10 = 147 credits
        const userId = String(req.user.userId);
        const estimatedScenes = 12;
        var totalCost = credits.COSTS.script_generation;
        totalCost += credits.COSTS.image_generation * estimatedScenes;
        if (generateVideos !== false) totalCost += credits.COSTS.video_generation * estimatedScenes;
        const check = await credits.checkCredits(userId, 'script_generation', 1);
        // Check if they have at least enough for the script generation to start
        if (!check.allowed) {
            return res.status(402).json({ error: 'Not enough credits', ...check });
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
        
        // Credit check: image_generation = 0.5 credits per scene
        const userId = String(req.user.userId);
        const check = await credits.checkCredits(userId, 'image_generation', 1);
        if (!check.allowed) {
            return res.status(402).json({ error: 'Not enough credits', ...check });
        }
        
        const generator = getGenerator(format, 'v2');
        if (!generator) return res.status(400).json({ error: 'Invalid format' });
        
        const numImages = Math.min(count || 2, 4); // Max 4 variants
        console.log(`Director mode: generating ${numImages} image(s) for scene ${sceneNumber}`);
        
        // Deduct credits upfront — image generation costs us money even if it fails
        await credits.deductCredits(userId, 'image_generation', 1, 'Images for scene ' + sceneNumber);
        
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
router.post('/generate/scene-video', requireAuth, studioGenerateLimiter, async (req, res) => {
    try {
        let { format, imageUrl, videoPrompt, sceneNumber } = req.body;
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
        
        // Deduct credits upfront — video generation costs us money even if it fails
        await credits.deductCredits(userId, 'video_generation', 1, 'Video for scene ' + sceneNumber);
        
        const videoUrl = await generator.generateVideo(imageUrl, videoPrompt, sceneNumber);
        
        console.log(`Director mode: video for scene ${sceneNumber} complete: ${videoUrl.substring(0, 80)}...`);
        res.json({ success: true, sceneNumber, videoUrl });
    } catch (error) {
        console.error('Scene video generation error:', error.message);
        // No refund — video generation costs us money via external API even on failure
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
        const { amount, plan } = req.body;
        if (!amount || amount < 1) return res.status(400).json({ error: 'Amount required' });
        
        var userId = String(req.user.userId);
        if (plan) {
            await credits.adminSetCredits(userId, amount, plan);
        } else {
            await credits.addTopUpCredits(userId, amount, 'admin-grant-' + Date.now());
        }
        var bal = await credits.getBalance(userId);
        res.json({ success: true, ...bal, totalAvailable: (bal.balance || 0) + (bal.topUpBalance || 0) });
    } catch (err) {
        console.error('Admin grant error:', err);
        res.status(500).json({ error: err.message });
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
        var { clips, title, layout } = req.body;
        // clips: [{ filename, number, label, startTime, endTime }]
        // title: { text, highlightWord, highlightColor }

        if (!clips || !Array.isArray(clips) || clips.length === 0) {
            return res.status(400).json({ error: 'At least one clip is required' });
        }

        // Credit check
        var userId = String(req.user.userId);
        var check = await credits.checkCredits(userId, 'ranking_assembly', 1);
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

        var result = await assembler.assemble(clipList, title || {}, { layout: layout || {} });

        console.log('🏆 Ranking video assembled: ' + result.videoUrl);
        res.json({ success: true, ...result });

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
        availableFormats: ['skeleton-anatomy', 'ranking']
    });
});

module.exports = router;
