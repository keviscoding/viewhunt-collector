const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
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
        
        // Collections indexes
        await db.collection('collections').createIndex({ user_id: 1 });
        await db.collection('collection_items').createIndex({ collection_id: 1 });
        await db.collection('collection_items').createIndex({ user_id: 1, channel_id: 1 }, { unique: true });
        
        console.log('Connected to MongoDB successfully');
    } catch (error) {
        console.error('MongoDB connection error:', error);
        process.exit(1);
    }
}

// Initialize MongoDB connection
connectToMongoDB();

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts per window
    message: { error: 'Too many authentication attempts, please try again later.' }
});

// Authentication middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid or expired token' });
        }
        req.user = user;
        next();
    });
};

// Helper function to validate display name
const validateDisplayName = (displayName) => {
    if (!displayName || displayName.length < 3 || displayName.length > 20) {
        return 'Display name must be 3-20 characters long';
    }
    if (!/^[a-zA-Z0-9_]+$/.test(displayName)) {
        return 'Display name can only contain letters, numbers, and underscores';
    }
    return null;
};

// Helper function to validate email
const validateEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

// Authentication Routes

// Register new user
app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
        const { email, password, display_name } = req.body;

        // Validation
        if (!email || !password || !display_name) {
            return res.status(400).json({ error: 'Email, password, and display name are required' });
        }

        if (!validateEmail(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters long' });
        }

        const displayNameError = validateDisplayName(display_name);
        if (displayNameError) {
            return res.status(400).json({ error: displayNameError });
        }

        // Check if user already exists
        const existingUser = await db.collection('users').findOne({
            $or: [
                { email: email.toLowerCase() },
                { display_name: display_name }
            ]
        });

        if (existingUser) {
            if (existingUser.email === email.toLowerCase()) {
                return res.status(400).json({ error: 'Email already registered' });
            } else {
                return res.status(400).json({ error: 'Display name already taken' });
            }
        }

        // Hash password
        const saltRounds = 12;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // Create user
        const newUser = {
            email: email.toLowerCase(),
            password: hashedPassword,
            display_name: display_name,
            created_at: new Date(),
            updated_at: new Date(),
            stats: {
                channels_approved: 0,
                channels_rejected: 0,
                total_reviews: 0
            }
        };

        const result = await db.collection('users').insertOne(newUser);

        // Generate JWT token
        const token = jwt.sign(
            { 
                userId: result.insertedId, 
                email: email.toLowerCase(),
                display_name: display_name
            },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.status(201).json({
            message: 'User registered successfully',
            token,
            user: {
                id: result.insertedId,
                email: email.toLowerCase(),
                display_name: display_name,
                stats: newUser.stats
            }
        });

    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Login user
app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        // Find user
        const user = await db.collection('users').findOne({ 
            email: email.toLowerCase() 
        });

        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Check password
        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Generate JWT token
        const token = jwt.sign(
            { 
                userId: user._id, 
                email: user.email,
                display_name: user.display_name
            },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user._id,
                email: user.email,
                display_name: user.display_name,
                stats: user.stats || { channels_approved: 0, channels_rejected: 0, total_reviews: 0 }
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get current user info
app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const user = await db.collection('users').findOne(
            { _id: new ObjectId(req.user.userId) },
            { projection: { password: 0 } } // Exclude password
        );

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            id: user._id,
            email: user.email,
            display_name: user.display_name,
            created_at: user.created_at,
            stats: user.stats || { channels_approved: 0, channels_rejected: 0, total_reviews: 0 }
        });

    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

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

// Approve a channel (requires authentication)
app.put('/api/channels/:id/approve', authenticateToken, async (req, res) => {
    const channelId = req.params.id;
    
    try {
        const result = await db.collection('channels').updateOne(
            { _id: new ObjectId(channelId) },
            { 
                $set: { 
                    status: 'approved', 
                    approved_by: new ObjectId(req.user.userId),
                    approved_by_name: req.user.display_name,
                    updated_at: new Date() 
                } 
            }
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        // Update user stats
        await db.collection('users').updateOne(
            { _id: new ObjectId(req.user.userId) },
            { 
                $inc: { 
                    'stats.channels_approved': 1,
                    'stats.total_reviews': 1
                },
                $set: { updated_at: new Date() }
            }
        );
        
        res.json({ message: 'Channel approved' });
    } catch (error) {
        console.error('Error approving channel:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Reject a channel (requires authentication)
app.put('/api/channels/:id/reject', authenticateToken, async (req, res) => {
    const channelId = req.params.id;
    
    try {
        const result = await db.collection('channels').updateOne(
            { _id: new ObjectId(channelId) },
            { 
                $set: { 
                    status: 'rejected', 
                    rejected_by: new ObjectId(req.user.userId),
                    rejected_by_name: req.user.display_name,
                    updated_at: new Date() 
                } 
            }
        );
        
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        // Update user stats
        await db.collection('users').updateOne(
            { _id: new ObjectId(req.user.userId) },
            { 
                $inc: { 
                    'stats.channels_rejected': 1,
                    'stats.total_reviews': 1
                },
                $set: { updated_at: new Date() }
            }
        );
        
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

// Get trending channels (approved in last 24 hours)
app.get('/api/channels/trending', async (req, res) => {
    try {
        // Calculate 24 hours ago
        const yesterday = new Date();
        yesterday.setHours(yesterday.getHours() - 24);
        
        // Get channels approved in the last 24 hours
        const trendingChannels = await db.collection('channels')
            .find({ 
                status: 'approved',
                updated_at: { $gte: yesterday }
            })
            .sort({ updated_at: -1 })
            .limit(20)
            .toArray();
        
        // If we have less than 5 trending channels, supplement with recent approved channels
        if (trendingChannels.length < 5) {
            const additionalChannels = await db.collection('channels')
                .find({ status: 'approved' })
                .sort({ updated_at: -1 })
                .limit(10)
                .toArray();
            
            // Merge and deduplicate
            const channelIds = new Set(trendingChannels.map(c => c._id.toString()));
            const supplemented = trendingChannels.concat(
                additionalChannels.filter(c => !channelIds.has(c._id.toString()))
            ).slice(0, 8);
            
            res.json(supplemented);
        } else {
            res.json(trendingChannels.slice(0, 8));
        }
        
    } catch (error) {
        console.error('Error fetching trending channels:', error);
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

// Collections Routes

// Get user's collections
app.get('/api/collections', authenticateToken, async (req, res) => {
    try {
        const collections = await db.collection('collections')
            .find({ user_id: new ObjectId(req.user.userId) })
            .sort({ updated_at: -1 })
            .toArray();
        
        // Get channel count for each collection
        for (let collection of collections) {
            const itemCount = await db.collection('collection_items')
                .countDocuments({ collection_id: collection._id });
            collection.channel_count = itemCount;
        }
        
        res.json(collections);
    } catch (error) {
        console.error('Error fetching collections:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Create new collection
app.post('/api/collections', authenticateToken, async (req, res) => {
    try {
        const { name, description } = req.body;
        
        if (!name || name.trim().length === 0) {
            return res.status(400).json({ error: 'Collection name is required' });
        }
        
        if (name.length > 50) {
            return res.status(400).json({ error: 'Collection name must be 50 characters or less' });
        }
        
        // Check if user already has a collection with this name
        const existingCollection = await db.collection('collections').findOne({
            user_id: new ObjectId(req.user.userId),
            name: name.trim()
        });
        
        if (existingCollection) {
            return res.status(400).json({ error: 'You already have a collection with this name' });
        }
        
        const newCollection = {
            user_id: new ObjectId(req.user.userId),
            name: name.trim(),
            description: description?.trim() || '',
            created_at: new Date(),
            updated_at: new Date()
        };
        
        const result = await db.collection('collections').insertOne(newCollection);
        
        res.status(201).json({
            message: 'Collection created successfully',
            collection: {
                ...newCollection,
                _id: result.insertedId,
                channel_count: 0
            }
        });
        
    } catch (error) {
        console.error('Error creating collection:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get channels in a specific collection
app.get('/api/collections/:id/channels', authenticateToken, async (req, res) => {
    try {
        const collectionId = req.params.id;
        
        // Verify collection belongs to user
        const collection = await db.collection('collections').findOne({
            _id: new ObjectId(collectionId),
            user_id: new ObjectId(req.user.userId)
        });
        
        if (!collection) {
            return res.status(404).json({ error: 'Collection not found' });
        }
        
        // Get channels in collection with full channel data
        const collectionItems = await db.collection('collection_items')
            .aggregate([
                { $match: { collection_id: new ObjectId(collectionId) } },
                {
                    $lookup: {
                        from: 'channels',
                        localField: 'channel_id',
                        foreignField: '_id',
                        as: 'channel'
                    }
                },
                { $unwind: '$channel' },
                { $sort: { added_at: -1 } }
            ])
            .toArray();
        
        const channels = collectionItems.map(item => ({
            ...item.channel,
            added_at: item.added_at,
            notes: item.notes
        }));
        
        res.json({
            collection,
            channels
        });
        
    } catch (error) {
        console.error('Error fetching collection channels:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Add channel to collection
app.post('/api/collections/:id/channels', authenticateToken, async (req, res) => {
    try {
        const collectionId = req.params.id;
        const { channel_id, notes } = req.body;
        
        if (!channel_id) {
            return res.status(400).json({ error: 'Channel ID is required' });
        }
        
        // Verify collection belongs to user
        const collection = await db.collection('collections').findOne({
            _id: new ObjectId(collectionId),
            user_id: new ObjectId(req.user.userId)
        });
        
        if (!collection) {
            return res.status(404).json({ error: 'Collection not found' });
        }
        
        // Verify channel exists
        const channel = await db.collection('channels').findOne({
            _id: new ObjectId(channel_id)
        });
        
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }
        
        // Check if channel is already in collection
        const existingItem = await db.collection('collection_items').findOne({
            collection_id: new ObjectId(collectionId),
            channel_id: new ObjectId(channel_id)
        });
        
        if (existingItem) {
            return res.status(400).json({ error: 'Channel is already in this collection' });
        }
        
        // Add channel to collection
        const collectionItem = {
            collection_id: new ObjectId(collectionId),
            channel_id: new ObjectId(channel_id),
            user_id: new ObjectId(req.user.userId),
            notes: notes?.trim() || '',
            added_at: new Date()
        };
        
        await db.collection('collection_items').insertOne(collectionItem);
        
        // Update collection's updated_at timestamp
        await db.collection('collections').updateOne(
            { _id: new ObjectId(collectionId) },
            { $set: { updated_at: new Date() } }
        );
        
        res.json({ message: 'Channel added to collection successfully' });
        
    } catch (error) {
        console.error('Error adding channel to collection:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Remove channel from collection
app.delete('/api/collections/:id/channels/:channelId', authenticateToken, async (req, res) => {
    try {
        const collectionId = req.params.id;
        const channelId = req.params.channelId;
        
        // Verify collection belongs to user
        const collection = await db.collection('collections').findOne({
            _id: new ObjectId(collectionId),
            user_id: new ObjectId(req.user.userId)
        });
        
        if (!collection) {
            return res.status(404).json({ error: 'Collection not found' });
        }
        
        // Remove channel from collection
        const result = await db.collection('collection_items').deleteOne({
            collection_id: new ObjectId(collectionId),
            channel_id: new ObjectId(channelId)
        });
        
        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Channel not found in collection' });
        }
        
        // Update collection's updated_at timestamp
        await db.collection('collections').updateOne(
            { _id: new ObjectId(collectionId) },
            { $set: { updated_at: new Date() } }
        );
        
        res.json({ message: 'Channel removed from collection successfully' });
        
    } catch (error) {
        console.error('Error removing channel from collection:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Delete collection
app.delete('/api/collections/:id', authenticateToken, async (req, res) => {
    try {
        const collectionId = req.params.id;
        
        // Verify collection belongs to user
        const collection = await db.collection('collections').findOne({
            _id: new ObjectId(collectionId),
            user_id: new ObjectId(req.user.userId)
        });
        
        if (!collection) {
            return res.status(404).json({ error: 'Collection not found' });
        }
        
        // Delete all items in the collection
        await db.collection('collection_items').deleteMany({
            collection_id: new ObjectId(collectionId)
        });
        
        // Delete the collection
        await db.collection('collections').deleteOne({
            _id: new ObjectId(collectionId)
        });
        
        res.json({ message: 'Collection deleted successfully' });
        
    } catch (error) {
        console.error('Error deleting collection:', error);
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