const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase payload limit for large datasets
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve mobile app static files
app.use('/mobile', express.static(path.join(__dirname, 'mobile')));
app.use(express.static(path.join(__dirname, 'mobile')));

// Serve mobile app at root and at the routed path
app.get('/', (req, res) => {
    handleMobileApp(req, res);
});

app.get('/viewhunt-collector-server2', (req, res) => {
    handleMobileApp(req, res);
});

function handleMobileApp(req, res) {
    const mobilePath = path.join(__dirname, 'mobile/index.html');
    console.log('Trying to serve mobile app from:', mobilePath);
    
    // Check if file exists
    if (require('fs').existsSync(mobilePath)) {
        res.sendFile(mobilePath);
    } else {
        console.error('Mobile app not found at:', mobilePath);
        res.status(404).send(`
            <h1>ViewHunt Backend is Running!</h1>
            <p>Server is working on port 8080</p>
            <p>Database: ${process.env.DATABASE_PATH || 'viewhunt.db'}</p>
            <p>Looking for mobile app at: ${mobilePath}</p>
            <p>File exists: ${require('fs').existsSync(mobilePath)}</p>
            <p><a href="/api/health">Test API Health</a></p>
        `);
    }
}

// MongoDB setup
const MONGODB_URI = process.env.MONGODB_URI;
let db;

// Connect to MongoDB
async function connectToMongoDB() {
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db('viewhuntv2');
        
        // Create indexes for better performance
        await db.collection('channels').createIndex({ status: 1 });
        await db.collection('channels').createIndex({ view_to_sub_ratio: -1 });
        await db.collection('channels').createIndex({ channel_url: 1 }, { unique: true });
        
        console.log('Connected to MongoDB successfully');
    } catch (error) {
        console.error('MongoDB connection error:', error);
        process.exit(1);
    }
}

// Initialize MongoDB connection
connectToMongoDB();

// API Routes

// Get pending channels (ordered by view-to-sub ratio)
app.get('/api/channels/pending', async (req, res) => {
    try {
        const channels = await db.collection('channels')
            .find({ status: 'pending' })
            .sort({ view_to_sub_ratio: -1 })
            .limit(50)
            .toArray();
        
        res.json(channels);
    } catch (error) {
        console.error('Error fetching pending channels:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Add new channels from scraper
app.post('/api/channels/bulk', async (req, res) => {
    const channels = req.body.channels;
    
    if (!Array.isArray(channels)) {
        return res.status(400).json({ error: 'Channels must be an array' });
    }

    let insertedCount = 0;
    let errorCount = 0;

    try {
        for (const channel of channels) {
            try {
                const channelDoc = {
                    channel_name: channel.channelName,
                    channel_url: channel.channelUrl,
                    video_title: channel.videoTitle,
                    view_count: channel.viewCount,
                    subscriber_count: channel.subscriberCount || 0,
                    view_to_sub_ratio: channel.viewToSubRatio || 0,
                    avatar_url: channel.avatarUrl || null,
                    status: 'pending',
                    created_at: new Date(),
                    updated_at: new Date()
                };

                // Use upsert to replace existing channels
                await db.collection('channels').replaceOne(
                    { channel_url: channel.channelUrl },
                    channelDoc,
                    { upsert: true }
                );
                
                insertedCount++;
            } catch (err) {
                console.error('Error inserting channel:', err);
                errorCount++;
            }
        }
        
        res.json({ 
            message: 'Channels processed',
            inserted: insertedCount,
            errors: errorCount
        });
    } catch (error) {
        console.error('Error processing channels:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Approve a channel
app.put('/api/channels/:id/approve', async (req, res) => {
    const channelId = req.params.id;
    
    try {
        const result = await db.collection('channels').updateOne(
            { _id: new require('mongodb').ObjectId(channelId) },
            { 
                $set: { 
                    status: 'approved', 
                    updated_at: new Date() 
                } 
            }
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Channel not found' });
        }
        
        res.json({ message: 'Channel approved' });
    } catch (error) {
        console.error('Error approving channel:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Reject a channel
app.put('/api/channels/:id/reject', async (req, res) => {
    const channelId = req.params.id;
    
    try {
        const result = await db.collection('channels').updateOne(
            { _id: new require('mongodb').ObjectId(channelId) },
            { 
                $set: { 
                    status: 'rejected', 
                    updated_at: new Date() 
                } 
            }
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Channel not found' });
        }
        
        res.json({ message: 'Channel rejected' });
    } catch (error) {
        console.error('Error rejecting channel:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get approved channels
app.get('/api/channels/approved', async (req, res) => {
    try {
        const channels = await db.collection('channels')
            .find({ status: 'approved' })
            .sort({ updated_at: -1 })
            .limit(100)
            .toArray();
        
        res.json(channels);
    } catch (error) {
        console.error('Error fetching approved channels:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get stats
app.get('/api/stats', async (req, res) => {
    try {
        const [pending, approved, rejected] = await Promise.all([
            db.collection('channels').countDocuments({ status: 'pending' }),
            db.collection('channels').countDocuments({ status: 'approved' }),
            db.collection('channels').countDocuments({ status: 'rejected' })
        ]);

        res.json({
            pending,
            approved,
            rejected
        });
    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
    console.log(`ViewHunt server running on port ${PORT}`);
    console.log(`Database: MongoDB Atlas - viewhuntv2`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    process.exit(0);
});