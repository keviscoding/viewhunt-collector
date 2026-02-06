const express = require('express');
const router = express.Router();
const SkeletonGenerator = require('./formats/skeleton-anatomy/generator');

// Lazy-load generators (only initialize when needed, not on server startup)
const generators = {};

function getGenerator(format) {
    if (!generators[format]) {
        if (format === 'skeleton-anatomy') {
            generators[format] = new SkeletonGenerator();
        }
    }
    return generators[format];
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
                generationTime: '5 min'
            }
        ]
    });
});

// Health check
router.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        availableFormats: ['skeleton-anatomy']
    });
});

module.exports = router;
