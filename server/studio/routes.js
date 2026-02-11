const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const SkeletonGenerator = require('./formats/skeleton-anatomy/generator');
const SkeletonGeneratorV2 = require('./formats/skeleton-anatomy-v2/generator');
const GeminiAnalyzer = require('./editor/gemini-analyzer');
const GeminiTTS = require('./editor/gemini-tts');
const VideoEditor = require('./editor/video-editor');
const assemblyQueue = require('./editor/job-queue');
const { saveSfx, listSfx, loadAllSfx } = require('./editor/sfx-store');
const credits = require('./credits');

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
router.post('/generate/scene-images', requireAuth, async (req, res) => {
    try {
        const { format, imagePrompt, sceneNumber, count } = req.body;
        if (!format || !imagePrompt) return res.status(400).json({ error: 'Format and imagePrompt are required' });
        
        // Credit check: image_generation = 3 credits per scene
        const userId = String(req.user.userId);
        const check = await credits.checkCredits(userId, 'image_generation', 1);
        if (!check.allowed) {
            return res.status(402).json({ error: 'Not enough credits', ...check });
        }
        
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
        
        // Deduct credits on success (1 scene worth of image generation)
        await credits.deductCredits(userId, 'image_generation', 1, 'Images for scene ' + sceneNumber);
        
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
        
        // Credit check: video_generation = 8 credits per scene
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
        
        const videoUrl = await generator.generateVideo(imageUrl, videoPrompt, sceneNumber);
        
        // Deduct credits on success
        await credits.deductCredits(userId, 'video_generation', 1, 'Video for scene ' + sceneNumber);
        
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

// === VIDEO ASSEMBLY ENDPOINTS (Queue-based) ===

// Submit assembly job — returns immediately with jobId
router.post('/assemble', requireAuth, async (req, res) => {
    try {
        const { script, scenes, voiceName } = req.body;
        
        if (!script || !scenes || !Array.isArray(scenes)) {
            return res.status(400).json({ error: 'script and scenes array are required' });
        }
        
        const scenesWithVideo = scenes.filter(s => s.videoUrl || s._videoUrl);
        if (scenesWithVideo.length === 0) {
            return res.status(400).json({ error: 'No scenes have generated videos' });
        }
        
        // Credit check: assembly = 10 credits
        const userId = String(req.user.userId);
        const check = await credits.checkCredits(userId, 'assembly', 1);
        if (!check.allowed) {
            return res.status(402).json({ error: 'Not enough credits', ...check });
        }
        
        // Deduct assembly credits upfront (refund on failure)
        await credits.deductCredits(userId, 'assembly', 1, 'Video assembly');
        
        console.log(`\n🎬 Assembly job submitted: ${scenesWithVideo.length} scenes, ${script.length} chars\n`);
        
        const jobId = assemblyQueue.submit(script, scenesWithVideo, voiceName);
        
        res.json({ success: true, jobId, userId });
        
    } catch (error) {
        console.error('Assembly submit error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Poll assembly job status
router.get('/assemble/status/:jobId', requireAuth, (req, res) => {
    const status = assemblyQueue.getStatus(req.params.jobId);
    if (!status) return res.status(404).json({ error: 'Job not found' });
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

        const { MongoClient, ObjectId } = require('mongodb');
        const MONGODB_URI = process.env.MONGODB_URI || process.env.V2_MONGO_URI || process.env.MONGO_URI;
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        const db = client.db('viewhuntv2');
        const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.userId) });
        await client.close();

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
            const client2 = new MongoClient(MONGODB_URI);
            await client2.connect();
            await client2.db('viewhuntv2').collection('users').updateOne(
                { _id: user._id },
                { $set: { 'subscription.stripeCustomerId': customerId } }
            );
            await client2.close();
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

        const { MongoClient, ObjectId } = require('mongodb');
        const MONGODB_URI = process.env.MONGODB_URI || process.env.V2_MONGO_URI || process.env.MONGO_URI;
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        const db = client.db('viewhuntv2');
        const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.userId) });
        
        if (!user || !user.subscription?.stripeCustomerId) {
            await client.close();
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

        await client.close();
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

// Health check
router.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        availableFormats: ['skeleton-anatomy']
    });
});

module.exports = router;
