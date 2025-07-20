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
    console.log('Serving ViewHunt mobile app from:', mobilePath);
    
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
        
        // Compound indexes for optimized sorting with filters
        await db.collection('channels').createIndex({ 
            status: 1, 
            view_to_sub_ratio: -1, 
            _id: 1 
        });
        await db.collection('channels').createIndex({ 
            status: 1, 
            view_count: -1, 
            _id: 1 
        });
        await db.collection('channels').createIndex({ 
            status: 1, 
            subscriber_count: -1, 
            _id: 1 
        });
        await db.collection('channels').createIndex({ 
            status: 1, 
            created_at: -1, 
            _id: 1 
        });
        await db.collection('channels').createIndex({ 
            status: 1, 
            video_count: -1, 
            _id: 1 
        });
        await db.collection('channels').createIndex({ 
            status: 1, 
            average_views: -1, 
            _id: 1 
        });
        
        // Collections indexes
        await db.collection('collections').createIndex({ user_id: 1 });
        await db.collection('collection_items').createIndex({ collection_id: 1 });
        
        // Fix collection_items unique index (allow same channel in different collections)
        try {
            // Drop the old incorrect index if it exists
            await db.collection('collection_items').dropIndex({ user_id: 1, channel_id: 1 });
            console.log('Dropped old collection_items index');
        } catch (error) {
            // Index might not exist, that's okay
            console.log('Old collection_items index not found (this is okay)');
        }
        
        // Create the correct index (prevent duplicates within same collection)
        await db.collection('collection_items').createIndex({ collection_id: 1, channel_id: 1 }, { unique: true });
        
        // User actions indexes for the new system
        await db.collection('user_channel_actions').createIndex({ user_id: 1 });
        await db.collection('user_channel_actions').createIndex({ channel_id: 1 });
        await db.collection('user_channel_actions').createIndex({ user_id: 1, channel_id: 1 }, { unique: true });
        await db.collection('user_channel_actions').createIndex({ action: 1 });
        await db.collection('user_channel_actions').createIndex({ created_at: -1 });
        
        console.log('Connected to MongoDB successfully');
    } catch (error) {
        console.error('MongoDB connection error:', error);
        process.exit(1);
    }
}

// Initialize MongoDB connection
connectToMongoDB();

// Helper function to generate public collection HTML
function generatePublicCollectionHTML(collection, channels, owner) {
    const formatNumber = (num) => {
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return num.toString();
    };

    const escapeHtml = (text) => {
        const div = { textContent: text };
        return div.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    const getTimeAgo = (date) => {
        const now = new Date();
        const diffInSeconds = Math.floor((now - date) / 1000);
        
        if (diffInSeconds < 60) return 'Just now';
        if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
        if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
        if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 86400)}d ago`;
        return `${Math.floor(diffInSeconds / 2592000)}mo ago`;
    };

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${escapeHtml(collection.name)} - ViewHunt Collection</title>
            <meta name="description" content="Discover amazing YouTube Shorts channels curated by ${escapeHtml(owner?.display_name || 'ViewHunt user')}">
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { 
                    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; 
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                    min-height: 100vh; 
                    color: #333; 
                }
                .container { max-width: 1200px; margin: 0 auto; padding: 2rem 1rem; }
                .header { text-align: center; margin-bottom: 3rem; color: white; }
                .header h1 { font-size: 2.5rem; margin-bottom: 0.5rem; }
                .header .subtitle { font-size: 1.2rem; opacity: 0.9; margin-bottom: 1rem; }
                .header .meta { font-size: 1rem; opacity: 0.8; }
                .channels-grid { 
                    display: grid; 
                    grid-template-columns: repeat(auto-fill, minmax(350px, 1fr)); 
                    gap: 1.5rem; 
                    margin-bottom: 3rem; 
                }
                .channel-card { 
                    background: rgba(255, 255, 255, 0.95); 
                    border-radius: 16px; 
                    padding: 1.5rem; 
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1); 
                    backdrop-filter: blur(10px); 
                    border: 1px solid rgba(255, 255, 255, 0.2); 
                    transition: transform 0.2s ease;
                }
                .channel-card:hover { transform: translateY(-4px); }
                .channel-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; }
                .channel-avatar { width: 50px; height: 50px; border-radius: 50%; overflow: hidden; flex-shrink: 0; }
                .channel-avatar img { width: 100%; height: 100%; object-fit: cover; }
                .avatar-letter { 
                    width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; 
                    background: linear-gradient(135deg, #667eea, #764ba2); color: white; font-weight: 600; font-size: 1.2rem; 
                }
                .channel-info h3 { font-size: 1.1rem; margin-bottom: 0.25rem; }
                .channel-info p { color: #666; font-size: 0.9rem; }
                .channel-stats { display: flex; gap: 1rem; margin-bottom: 1rem; }
                .stat-item { text-align: center; }
                .stat-value { display: block; font-weight: 600; font-size: 1.1rem; color: #333; }
                .stat-label { font-size: 0.8rem; color: #666; }
                .ratio-highlight { color: #e74c3c; }
                .channel-link { 
                    display: inline-block; background: linear-gradient(135deg, #667eea, #764ba2); 
                    color: white; padding: 0.75rem 1.5rem; border-radius: 8px; text-decoration: none; 
                    font-weight: 500; transition: transform 0.2s ease; 
                }
                .channel-link:hover { transform: translateY(-1px); }
                .footer { text-align: center; color: white; opacity: 0.8; }
                .footer a { color: white; text-decoration: none; font-weight: 600; }
                .footer a:hover { text-decoration: underline; }
                .empty-state { text-align: center; color: white; padding: 3rem; }
                .empty-state h2 { font-size: 1.5rem; margin-bottom: 1rem; }
                @media (max-width: 768px) {
                    .container { padding: 1rem; }
                    .header h1 { font-size: 2rem; }
                    .channels-grid { grid-template-columns: 1fr; gap: 1rem; }
                    .channel-card { padding: 1rem; }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>📚 ${escapeHtml(collection.name)}</h1>
                    <p class="subtitle">${escapeHtml(collection.description || 'A curated collection of amazing YouTube Shorts channels')}</p>
                    <p class="meta">
                        Curated by <strong>${escapeHtml(owner?.display_name || 'ViewHunt user')}</strong> • 
                        ${channels.length} channel${channels.length !== 1 ? 's' : ''} • 
                        Updated ${getTimeAgo(new Date(collection.updated_at))}
                    </p>
                </div>

                ${channels.length === 0 ? `
                    <div class="empty-state">
                        <h2>📺 No Channels Yet</h2>
                        <p>This collection is empty, but check back soon for amazing channel discoveries!</p>
                    </div>
                ` : `
                    <div class="channels-grid">
                        ${channels.map(channel => `
                            <div class="channel-card">
                                <div class="channel-header">
                                    <div class="channel-avatar">
                                        ${channel.avatar_url ? 
                                            `<img src="${channel.avatar_url}" alt="${escapeHtml(channel.channel_name)}">` :
                                            `<div class="avatar-letter">${channel.channel_name.charAt(0).toUpperCase()}</div>`
                                        }
                                    </div>
                                    <div class="channel-info">
                                        <h3>${escapeHtml(channel.channel_name)}</h3>
                                        <p>${escapeHtml(channel.video_title || 'YouTube Shorts Channel')}</p>
                                    </div>
                                </div>
                                
                                <div class="channel-stats">
                                    <div class="stat-item">
                                        <span class="stat-value">${formatNumber(channel.view_count || 0)}</span>
                                        <span class="stat-label">Views</span>
                                    </div>
                                    <div class="stat-item">
                                        <span class="stat-value">${formatNumber(channel.subscriber_count || 0)}</span>
                                        <span class="stat-label">Subs</span>
                                    </div>
                                    <div class="stat-item">
                                        <span class="stat-value ratio-highlight">${channel.view_to_sub_ratio ? channel.view_to_sub_ratio.toFixed(2) : 'N/A'}</span>
                                        <span class="stat-label">Ratio</span>
                                    </div>
                                </div>
                                
                                <a href="${channel.channel_url}" target="_blank" class="channel-link">
                                    🔗 View Channel
                                </a>
                            </div>
                        `).join('')}
                    </div>
                `}

                <div class="footer">
                    <p>Powered by <a href="https://viewhunt-backend-4fur6.ondigitalocean.app/">ViewHunt</a> - Discover Amazing YouTube Shorts Channels</p>
                </div>
            </div>
        </body>
        </html>
    `;
}

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

// Old pending endpoint removed - using user-specific endpoint below

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
                    // NEW: Add channel-level statistics
                    total_views: channel.totalViews || 0,
                    video_count: channel.videoCount || 0,
                    average_views: channel.averageViews || 0,
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

// Approve a channel (requires authentication) - User-specific approach
app.put('/api/channels/:id/approve', authenticateToken, async (req, res) => {
    const channelId = req.params.id;
    const userId = new ObjectId(req.user.userId);
    
    try {
        // Check if channel exists
        const channel = await db.collection('channels').findOne({ _id: new ObjectId(channelId) });
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        // Check if user already acted on this channel
        const existingAction = await db.collection('user_channel_actions').findOne({
            user_id: userId,
            channel_id: new ObjectId(channelId)
        });

        if (existingAction) {
            return res.status(400).json({ error: 'You have already reviewed this channel' });
        }

        // Record user's approval action
        await db.collection('user_channel_actions').insertOne({
            user_id: userId,
            channel_id: new ObjectId(channelId),
            action: 'approved',
            created_at: new Date(),
            user_name: req.user.display_name
        });

        // Update channel's approval count and trending score
        await db.collection('channels').updateOne(
            { _id: new ObjectId(channelId) },
            { 
                $inc: { 
                    approval_count: 1,
                    trending_score: 1
                },
                $set: { 
                    last_approved_at: new Date(),
                    updated_at: new Date()
                }
            }
        );

        // Update user stats
        await db.collection('users').updateOne(
            { _id: userId },
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

// Reject a channel (requires authentication) - User-specific approach
app.put('/api/channels/:id/reject', authenticateToken, async (req, res) => {
    const channelId = req.params.id;
    const userId = new ObjectId(req.user.userId);
    
    try {
        // Check if channel exists
        const channel = await db.collection('channels').findOne({ _id: new ObjectId(channelId) });
        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        // Check if user already acted on this channel
        const existingAction = await db.collection('user_channel_actions').findOne({
            user_id: userId,
            channel_id: new ObjectId(channelId)
        });

        if (existingAction) {
            return res.status(400).json({ error: 'You have already reviewed this channel' });
        }

        // Record user's rejection action
        await db.collection('user_channel_actions').insertOne({
            user_id: userId,
            channel_id: new ObjectId(channelId),
            action: 'rejected',
            created_at: new Date(),
            user_name: req.user.display_name
        });

        // Update user stats
        await db.collection('users').updateOne(
            { _id: userId },
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

// Get approved channels - User-specific or Admin view
app.get('/api/channels/approved', authenticateToken, async (req, res) => {
    try {
        const userId = new ObjectId(req.user.userId);
        const isAdmin = req.user.email === 'nwalikelv@gmail.com' || req.user.email === 'kevis@viewhunt.com';
        
        if (isAdmin) {
            // Admin sees all channels with approval counts
            const channels = await db.collection('channels')
                .aggregate([
                    {
                        $lookup: {
                            from: 'user_channel_actions',
                            localField: '_id',
                            foreignField: 'channel_id',
                            as: 'approvals'
                        }
                    },
                    {
                        $match: {
                            'approvals.action': 'approved'
                        }
                    },
                    {
                        $addFields: {
                            approval_count: { $size: '$approvals' },
                            recent_approvals: {
                                $size: {
                                    $filter: {
                                        input: '$approvals',
                                        cond: {
                                            $gte: ['$$this.created_at', new Date(Date.now() - 24 * 60 * 60 * 1000)]
                                        }
                                    }
                                }
                            }
                        }
                    },
                    {
                        $addFields: {
                            first_approval_time: { $min: '$approvals.created_at' },
                            latest_approval_time: { $max: '$approvals.created_at' },
                            admin_approved: {
                                $anyElementTrue: {
                                    $map: {
                                        input: '$approvals',
                                        as: 'approval',
                                        in: {
                                            $or: [
                                                { $eq: ['$$approval.user_email', 'nwalikelv@gmail.com'] },
                                                { $eq: ['$$approval.user_email', 'kevis@viewhunt.com'] }
                                            ]
                                        }
                                    }
                                }
                            }
                        }
                    },
                    { $sort: { first_approval_time: -1, approval_count: -1 } },
                    { $limit: 200 }
                ])
                .toArray();
            
            res.json(channels);
        } else {
            // Regular users see only their approved channels
            const userApprovals = await db.collection('user_channel_actions')
                .aggregate([
                    {
                        $match: {
                            user_id: userId,
                            action: 'approved'
                        }
                    },
                    {
                        $lookup: {
                            from: 'channels',
                            localField: 'channel_id',
                            foreignField: '_id',
                            as: 'channel'
                        }
                    },
                    { $unwind: '$channel' },
                    { $sort: { created_at: -1 } },
                    { $limit: 50 },
                    {
                        $replaceRoot: {
                            newRoot: {
                                $mergeObjects: ['$channel', { approved_at: '$created_at' }]
                            }
                        }
                    }
                ])
                .toArray();
            
            res.json(userApprovals);
        }
    } catch (error) {
        console.error('Error fetching approved channels:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get pending channels for user (excluding already reviewed) - SIMPLIFIED VERSION
app.get('/api/channels/pending', authenticateToken, async (req, res) => {
    try {
        const userId = new ObjectId(req.user.userId);
        
        // Pagination parameters
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;
        
        // Sort parameters
        const primarySort = req.query.primarySort || 'ratio-desc';
        const secondarySort = req.query.secondarySort || 'none';
        
        // Filter parameters
        const minViews = parseInt(req.query.minViews) || 0;
        const maxViews = req.query.maxViews ? parseInt(req.query.maxViews) : null;
        const minSubs = parseInt(req.query.minSubs) || 0;
        const maxSubs = req.query.maxSubs ? parseInt(req.query.maxSubs) : null;
        const minVideos = parseInt(req.query.minVideos) || 0;
        const maxVideos = req.query.maxVideos ? parseInt(req.query.maxVideos) : null;
        
        // Get channels user has already acted on
        const reviewedChannelIds = await db.collection('user_channel_actions')
            .find({ user_id: userId })
            .project({ channel_id: 1 })
            .toArray()
            .then(actions => actions.map(action => action.channel_id));
        
        // Build match query with filters
        const matchQuery = {
            status: 'pending',
            _id: { $nin: reviewedChannelIds }
        };
        
        // Add average views filters if specified (more meaningful than single video views)
        if (minViews > 0 || maxViews) {
            matchQuery.average_views = {};
            if (minViews > 0) matchQuery.average_views.$gte = minViews;
            if (maxViews) matchQuery.average_views.$lte = maxViews;
        }
        
        // Add subscriber count filters if specified
        if (minSubs > 0 || maxSubs) {
            matchQuery.subscriber_count = {};
            if (minSubs > 0) matchQuery.subscriber_count.$gte = minSubs;
            if (maxSubs) matchQuery.subscriber_count.$lte = maxSubs;
        }
        
        // Add video count filters if specified
        if (minVideos > 0 || maxVideos) {
            matchQuery.video_count = {};
            if (minVideos > 0) matchQuery.video_count.$gte = minVideos;
            if (maxVideos) matchQuery.video_count.$lte = maxVideos;
        }
        
        // Helper function to get sort field and direction
        const getSortField = (sortType) => {
            switch (sortType) {
                case 'ratio-desc': return ['view_to_sub_ratio', -1];
                case 'ratio-asc': return ['view_to_sub_ratio', 1];
                case 'views-desc': return ['view_count', -1];
                case 'views-asc': return ['view_count', 1];
                case 'subs-desc': return ['subscriber_count', -1];
                case 'subs-asc': return ['subscriber_count', 1];
                case 'videos-desc': return ['video_count', -1];
                case 'videos-asc': return ['video_count', 1];
                case 'newest': return ['created_at', -1];
                case 'oldest': return ['created_at', 1];
                default: return ['view_to_sub_ratio', -1];
            }
        };

        // Build dual sort query
        let sortQuery = {};
        
        // Add primary sort
        const [primaryField, primaryDirection] = getSortField(primarySort);
        sortQuery[primaryField] = primaryDirection;
        
        // Add secondary sort if specified and different from primary
        if (secondarySort && secondarySort !== 'none') {
            const [secondaryField, secondaryDirection] = getSortField(secondarySort);
            
            // Only add if it's a different field than primary
            if (secondaryField !== primaryField) {
                sortQuery[secondaryField] = secondaryDirection;
            }
        }
        
        // Always add _id for consistent pagination
        sortQuery._id = 1;
        
        // Get total count
        const totalChannels = await db.collection('channels').countDocuments(matchQuery);
        const totalPages = Math.ceil(totalChannels / limit);
        
        if (totalChannels === 0) {
            return res.json({
                channels: [],
                pagination: {
                    currentPage: page,
                    totalPages: 0,
                    totalChannels: 0,
                    hasNext: false,
                    hasPrev: false
                }
            });
        }
        
        // Get channels
        const channels = await db.collection('channels')
            .find(matchQuery)
            .sort(sortQuery)
            .skip(skip)
            .limit(limit)
            .toArray();
        
        res.json({
            channels,
            pagination: {
                currentPage: page,
                totalPages,
                totalChannels,
                hasNext: page < totalPages,
                hasPrev: page > 1,
                limit
            }
        });
        
    } catch (error) {
        console.error('Error fetching pending channels:', error);
        res.status(500).json({ error: 'Database error', details: error.message });
    }
});

// Get trending channels (based on recent approvals from multiple users)
app.get('/api/channels/trending', async (req, res) => {
    try {
        // Calculate 24 hours ago
        const yesterday = new Date();
        yesterday.setHours(yesterday.getHours() - 24);
        
        // Get channels with most approvals in last 24 hours
        const trendingChannels = await db.collection('user_channel_actions')
            .aggregate([
                {
                    $match: {
                        action: 'approved',
                        created_at: { $gte: yesterday }
                    }
                },
                {
                    $group: {
                        _id: '$channel_id',
                        approval_count: { $sum: 1 },
                        latest_approval: { $max: '$created_at' }
                    }
                },
                {
                    $lookup: {
                        from: 'channels',
                        localField: '_id',
                        foreignField: '_id',
                        as: 'channel'
                    }
                },
                { $unwind: '$channel' },
                { $sort: { approval_count: -1, latest_approval: -1 } },
                { $limit: 8 },
                {
                    $replaceRoot: {
                        newRoot: {
                            $mergeObjects: [
                                '$channel',
                                { 
                                    trending_approvals: '$approval_count',
                                    latest_approval: '$latest_approval'
                                }
                            ]
                        }
                    }
                }
            ])
            .toArray();
        
        // If we have less than 5 trending channels, supplement with recently approved channels
        if (trendingChannels.length < 5) {
            const additionalChannels = await db.collection('user_channel_actions')
                .aggregate([
                    {
                        $match: {
                            action: 'approved'
                        }
                    },
                    {
                        $group: {
                            _id: '$channel_id',
                            approval_count: { $sum: 1 },
                            latest_approval: { $max: '$created_at' }
                        }
                    },
                    {
                        $lookup: {
                            from: 'channels',
                            localField: '_id',
                            foreignField: '_id',
                            as: 'channel'
                        }
                    },
                    { $unwind: '$channel' },
                    { $sort: { latest_approval: -1 } },
                    { $limit: 10 },
                    {
                        $replaceRoot: {
                            newRoot: {
                                $mergeObjects: [
                                    '$channel',
                                    { 
                                        trending_approvals: '$approval_count',
                                        latest_approval: '$latest_approval'
                                    }
                                ]
                            }
                        }
                    }
                ])
                .toArray();
            
            // Merge and deduplicate
            const channelIds = new Set(trendingChannels.map(c => c._id.toString()));
            const supplemented = trendingChannels.concat(
                additionalChannels.filter(c => !channelIds.has(c._id.toString()))
            ).slice(0, 8);
            
            res.json(supplemented);
        } else {
            res.json(trendingChannels);
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

// Public Kevis's Picks endpoint (no authentication required)
app.get('/api/kevis-picks', async (req, res) => {
    try {
        // Find Kevis's Picks collection by admin user
        const adminUser = await db.collection('users').findOne({
            $or: [
                { email: 'nwalikelv@gmail.com' },
                { email: 'kevis@viewhunt.com' }
            ]
        });

        if (!adminUser) {
            return res.json([]);
        }

        // Find Kevis's Picks collection
        const kevisCollection = await db.collection('collections').findOne({
            user_id: adminUser._id,
            name: "Kevis's Picks"
        });

        if (!kevisCollection) {
            return res.json([]);
        }

        // Get channels in Kevis's Picks collection
        const collectionItems = await db.collection('collection_items')
            .aggregate([
                { $match: { collection_id: kevisCollection._id } },
                {
                    $lookup: {
                        from: 'channels',
                        localField: 'channel_id',
                        foreignField: '_id',
                        as: 'channel'
                    }
                },
                { $unwind: '$channel' },
                { $sort: { added_at: -1 } },
                { $limit: 10 }
            ])
            .toArray();

        const channels = collectionItems.map(item => ({
            ...item.channel,
            added_at: item.added_at
        }));

        res.json(channels);
    } catch (error) {
        console.error('Error fetching Kevis picks:', error);
        res.json([]);
    }
});

// Public collection sharing route (no authentication required)
app.get('/shared/:collectionId', async (req, res) => {
    try {
        const collectionId = req.params.collectionId;
        
        // Get collection details
        const collection = await db.collection('collections').findOne({
            _id: new ObjectId(collectionId)
        });
        
        if (!collection) {
            return res.status(404).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Collection Not Found - ViewHunt</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>
                        body { font-family: Inter, sans-serif; text-align: center; padding: 2rem; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; color: white; }
                        .container { max-width: 500px; margin: 0 auto; }
                        h1 { font-size: 2rem; margin-bottom: 1rem; }
                        p { font-size: 1.1rem; margin-bottom: 2rem; }
                        .btn { background: white; color: #333; padding: 1rem 2rem; border-radius: 8px; text-decoration: none; font-weight: 600; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>📚 Collection Not Found</h1>
                        <p>This collection doesn't exist or has been removed.</p>
                        <a href="https://viewhunt-backend-4fur6.ondigitalocean.app/" class="btn">Discover Channels on ViewHunt</a>
                    </div>
                </body>
                </html>
            `);
        }
        
        // Get channels in the collection
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
            added_at: item.added_at
        }));
        
        // Get collection owner info (without sensitive data)
        const owner = await db.collection('users').findOne(
            { _id: collection.user_id },
            { projection: { display_name: 1 } }
        );
        
        // Render public collection page
        const html = generatePublicCollectionHTML(collection, channels, owner);
        res.send(html);
        
    } catch (error) {
        console.error('Error fetching public collection:', error);
        res.status(500).send('Error loading collection');
    }
});

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
        
        // Handle duplicate key error specifically
        if (error.code === 11000) {
            return res.status(400).json({ error: 'Channel is already in this collection' });
        }
        
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