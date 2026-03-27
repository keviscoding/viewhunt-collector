const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

// Email verification via Resend
const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Studio routes
const studioRoutes = require('./studio/routes');

// Auto channel collector (daily cron)
const { scheduleDailyCollection, runDailyCollection } = require('./auto-collector');

// Initialize Stripe only if secret key is available
let stripe;
if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
} else {
    console.warn('STRIPE_SECRET_KEY not found in environment variables');
}

const app = express();
const PORT = process.env.PORT || 8080;

// Trust proxy for DigitalOcean App Platform
app.set('trust proxy', 1);

// Static file serving (no template engine needed)

// Middleware
app.use(cors());

// Stripe webhook needs raw body (before express.json)
app.use('/api/subscription/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Serve static files for landing page (index: false so our route handler controls /)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Serve mobile app static files
app.use('/mobile', express.static(path.join(__dirname, 'mobile')));
app.use('/app', express.static(path.join(__dirname, 'mobile')));

// Studio API routes
app.use('/api/studio', studioRoutes);

// Training upload routes
const trainingUploadRoutes = require('./studio/upload-training-endpoint');
app.use('/api/studio', trainingUploadRoutes);

// Lead capture endpoint (free funnel → MailerLite)
app.post('/api/leads/capture', rateLimit({ windowMs: 60000, max: 10 }), async (req, res) => {
    try {
        var { name, email, phone, situation, source } = req.body;
        if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

        // Generate unique access token
        var crypto = require('crypto');
        var accessToken = crypto.randomBytes(24).toString('hex');

        // Save to MongoDB
        var lead = {
            name, email, phone: phone || '',
            situation: situation || '',
            source: source || 'free-funnel',
            accessToken: accessToken,
            accessClicked: false,
            createdAt: new Date()
        };
        await db.collection('leads').insertOne(lead);
        console.log('📧 Lead captured: ' + email + ' (token: ' + accessToken.slice(0, 8) + '...)');

        // Build the access link (this goes in the MailerLite email)
        var baseUrl = process.env.APP_URL || 'https://viewhunt.com';
        var accessLink = baseUrl + '/free/access?token=' + accessToken;

        // Forward to MailerLite if API key is configured
        if (process.env.MAILERLITE_API_KEY && process.env.MAILERLITE_GROUP_ID) {
            try {
                const mlRes = await fetch('https://connect.mailerlite.com/api/subscribers', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + process.env.MAILERLITE_API_KEY
                    },
                    body: JSON.stringify({
                        email: email,
                        fields: {
                            name: name,
                            phone: phone || '',
                            last_name: '',
                            access_link: accessLink
                        },
                        groups: [process.env.MAILERLITE_GROUP_ID],
                        status: 'active'
                    })
                });
                if (mlRes.ok) {
                    console.log('📧 MailerLite: subscriber added with access link');
                } else {
                    var mlErr = await mlRes.text();
                    console.warn('📧 MailerLite error:', mlErr);
                }
            } catch (mlError) {
                console.warn('📧 MailerLite request failed:', mlError.message);
            }
        }

        res.json({ success: true, email: email });
    } catch (err) {
        console.error('Lead capture error:', err);
        res.status(500).json({ error: 'Failed to save' });
    }
});

// Verify access token from email link → redirect to /app
app.get('/free/access', async (req, res) => {
    var token = req.query.token;
    if (!token) return res.redirect('/');

    try {
        var lead = await db.collection('leads').findOneAndUpdate(
            { accessToken: token },
            { $set: { accessClicked: true, accessClickedAt: new Date() } }
        );

        if (lead) {
            console.log('📧 Access link clicked: ' + lead.email);
            // Redirect to the app — they proved they opened the email
            return res.redirect('/app');
        }
    } catch (err) {
        console.error('Access token error:', err);
    }

    // Invalid or expired token — send to landing page
    res.redirect('/');
});

// Landing page route — serve the original landing page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Free funnel page — redirect to main landing page
app.get('/free', (req, res) => {
    res.redirect('/');
});
app.get('/free/', (req, res) => {
    res.redirect('/');
});

// Pricing page route
app.get('/pricing', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pricing.html'));
});

// Manage subscription page route
app.get('/manage-subscription', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'manage-subscription.html'));
});

// Privacy Policy page route
app.get('/privacy-policy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy-policy.html'));
});

// Terms of Service page route
app.get('/terms-of-service', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'terms-of-service.html'));
});

// Studio page route
app.get('/studio', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'studio', 'index.html'));
});

// Studio V2 page route (Skeleton Video Generator — admin only during maintenance)
app.get('/studio/v2', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'studio', 'v2.html'));
});
app.get('/studio/v2.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'studio', 'v2.html'));
});

// Studio Ranking page route
app.get('/studio/ranking', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'studio', 'ranking.html'));
});

// Studio Storytelling page route
app.get('/studio/storytelling', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'studio', 'storytelling.html'));
});

// Studio AI Avatar page route
app.get('/studio/avatar', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'studio', 'avatar.html'));
});

// Studio Timelapse page route
app.get('/studio/timelapse', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'studio', 'timelapse.html'));
});

// Studio Transcript Extractor page route
app.get('/studio/transcript', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'studio', 'transcript.html'));
});

// Subscription success page
app.get('/subscription-success', async (req, res) => {
    try {
        const { session_id } = req.query;
        
        if (!session_id) {
            console.error('No session_id provided');
            return res.redirect('/app?error=invalid_session');
        }
        
        console.log('Processing subscription success for session:', session_id);
        
        // Check if Stripe is configured
        if (!stripe) {
            console.error('Stripe not configured');
            return res.redirect('/app?error=payment_system_not_configured');
        }
        
        // Retrieve the session from Stripe
        const session = await stripe.checkout.sessions.retrieve(session_id);
        console.log('Stripe session retrieved:', session.payment_status, session.customer);
        
        if (session.payment_status === 'paid') {
            // Update user subscription status
            const subscription = await stripe.subscriptions.retrieve(session.subscription);
            const customer = await stripe.customers.retrieve(session.customer);
            
            console.log('Processing subscription for customer:', customer.email);
            
            // Find user by email
            const user = await db.collection('users').findOne({ email: customer.email });
            
            if (user) {
                console.log('Updating subscription for user:', user.email);
                
                // Use plan from session metadata if available, fallback to 'starter'
                var planFromMeta = (session.metadata && session.metadata.plan) ? session.metadata.plan : 'starter';
                // Map old 'pro' to 'starter' for credit purposes
                if (planFromMeta === 'pro') planFromMeta = 'starter';
                
                await db.collection('users').updateOne(
                    { _id: user._id },
                    {
                        $set: {
                            'subscription.status': 'active',
                            'subscription.plan': planFromMeta,
                            'subscription.stripeSubscriptionId': subscription.id,
                            'subscription.stripeCustomerId': customer.id,
                            'subscription.startDate': new Date(subscription.current_period_start * 1000),
                            'subscription.endDate': new Date(subscription.current_period_end * 1000),
                            updated_at: new Date()
                        }
                    }
                );
                
                console.log('Subscription updated successfully for:', user.email);
                res.redirect('/app?success=subscription_activated');
            } else {
                console.error('User not found for email:', customer.email);
                res.redirect('/app?error=user_not_found');
            }
        } else {
            console.error('Payment not completed:', session.payment_status);
            res.redirect('/app?error=payment_failed');
        }
        
    } catch (error) {
        console.error('Error handling subscription success:', error);
        res.redirect('/app?error=processing_failed');
    }
});

// Serve mobile app for /app path
app.get('/app', (req, res) => {
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
const V1_MONGODB_URI = process.env.MONGO_URI; // V1 database (users + subscriptions)
const V2_MONGODB_URI = process.env.V2_MONGO_URI || process.env.MONGO_URI; // V2 database (channels + beta users)
let db; // V2 database (primary)
let v1Db; // V1 database (for user migration)

// Connect to MongoDB
async function connectToMongoDB() {
    try {
        console.log('Connecting to V2 MongoDB with URI:', V2_MONGODB_URI ? 'V2 URI provided' : 'NO V2 URI PROVIDED');
        console.log('Connecting to V1 MongoDB with URI:', V1_MONGODB_URI ? 'V1 URI provided' : 'NO V1 URI PROVIDED');
        
        // Connect to V2 database (primary)
        const v2Client = new MongoClient(V2_MONGODB_URI);
        await v2Client.connect();
        db = v2Client.db('viewhuntv2');
        
        // Connect to V1 database (for user migration)
        if (V1_MONGODB_URI && V1_MONGODB_URI !== V2_MONGODB_URI) {
            const v1Client = new MongoClient(V1_MONGODB_URI);
            await v1Client.connect();
            v1Db = v1Client.db('youtube-niche-finder'); // Correct V1 database name
            console.log('Connected to both V1 and V2 databases');
            
            // Check V1 database contents
            const v1UserCount = await v1Db.collection('users').countDocuments();
            console.log(`V1 database has ${v1UserCount} users`);
        } else {
            console.log('Using same database for V1 and V2');
            v1Db = db;
        }
        
        // Check what collections exist
        const collections = await db.listCollections().toArray();
        console.log('Available collections:', collections.map(c => c.name));
        
        // Check channel count
        const channelCount = await db.collection('channels').countDocuments();
        console.log(`viewhuntv2 database has ${channelCount} channels`);
        
        // Check if channels collection has any sample data
        if (channelCount > 0) {
            const sampleChannel = await db.collection('channels').findOne();
            console.log('Sample channel:', {
                name: sampleChannel?.channel_name,
                url: sampleChannel?.channel_url,
                status: sampleChannel?.status,
                created_at: sampleChannel?.created_at
            });
        } else {
            console.log('No channels found in database - this might be a new/empty database');
        }
        
        // Check user count
        const userCount = await db.collection('users').countDocuments();
        console.log(`Database has ${userCount} users`);
        
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

        // Start auto-collector daily scheduler
        scheduleDailyCollection(db);
    } catch (error) {
        console.error('MongoDB connection error:', error);
        process.exit(1);
    }
}

// Initialize MongoDB connection
connectToMongoDB();

// Subscription middleware
const requireSubscription = async (req, res, next) => {
    try {
        const user = req.user;
        
        // Admin always has access
        if (user.email === process.env.ADMIN_EMAIL) {
            return next();
        }
        
        // Student account gets niche access only (NOT studio)
        if (user.email === 'students@viewhunt.com') {
            console.log('Student account access granted (niches only)');
            return next();
        }
        
        // Get full user data from database to check migration status
        const fullUser = await db.collection('users').findOne({ _id: new ObjectId(req.user.userId) });
        
        if (!fullUser) {
            return res.status(403).json({ 
                error: 'User not found',
                redirect: '/pricing'
            });
        }
        
        // INVITE USERS get free access (registered with invite codes)
        // BUT only if their invite code is still active
        if (fullUser.invited_by_code) {
            // Check if the invite code is still active
            const inviteCode = await db.collection('invite_codes').findOne({ 
                code: fullUser.invited_by_code 
            });
            
            if (inviteCode && inviteCode.active) {
                console.log('Invite user with active code, granting free access:', user.email, 'code:', fullUser.invited_by_code);
                return next();
            } else {
                console.log('Invite user with deactivated code, access revoked:', user.email, 'code:', fullUser.invited_by_code);
                return res.status(403).json({ 
                    error: 'Access expired. Check your ViewMastery subscription for details.',
                    redirect: '/pricing',
                    userType: 'revoked_invite'
                });
            }
        }
        
        // V2 Beta users (existing users before cutoff date) get free access
        // New users after a certain date need subscription
        const BETA_CUTOFF_DATE = new Date('2025-07-21'); // No more free beta access after today
        const userCreatedAt = new Date(fullUser.created_at);
        
        if (!fullUser.migrated_from_v1 && userCreatedAt < BETA_CUTOFF_DATE) {
            console.log('V2 beta user (grandfathered), granting free access:', user.email);
            return next();
        }
        
        // New V2 users (after cutoff) — free tier gets limited access, paid gets full
        if (!fullUser.migrated_from_v1 && userCreatedAt >= BETA_CUTOFF_DATE) {
            console.log('New V2 user, checking subscription:', user.email);
            
            // If Stripe is not configured, allow access for development
            if (!stripe) {
                console.warn('Stripe not configured, allowing access for new V2 user');
                return next();
            }
            
            // Check if user has active paid subscription
            if (fullUser.subscription && fullUser.subscription.stripeSubscriptionId) {
                try {
                    const subscription = await stripe.subscriptions.retrieve(fullUser.subscription.stripeSubscriptionId);
                    
                    if (subscription.status === 'active') {
                        console.log('New V2 user subscription verified as active');
                        req.subscription = subscription;
                        req.userPlan = fullUser.subscription.plan || 'starter';
                        return next();
                    }
                    
                    console.log('New V2 user subscription not active:', subscription.status);
                } catch (stripeError) {
                    console.error('Stripe subscription check failed for new V2 user:', stripeError);
                }
            }
            
            // No active subscription — free tier (limited niche access)
            console.log('Free tier user, granting limited access:', user.email);
            req.userPlan = 'free';
            return next();
        }
        
        // V1 migrated users need active subscription
        console.log('V1 migrated user, checking subscription:', user.email);
        
        // If Stripe is not configured, allow access for development
        if (!stripe) {
            console.warn('Stripe not configured, allowing access for V1 user');
            return next();
        }
        
        // Check if user has subscription data
        if (!fullUser.subscription || !fullUser.subscription.stripeSubscriptionId) {
            console.log('V1 user has no subscription data');
            return res.status(403).json({ 
                error: 'Active subscription required',
                redirect: '/pricing'
            });
        }
        
        // Verify subscription with Stripe
        try {
            const subscription = await stripe.subscriptions.retrieve(fullUser.subscription.stripeSubscriptionId);
            
            // Check if subscription is active
            if (subscription.status !== 'active') {
                console.log('V1 user subscription not active:', subscription.status);
                return res.status(403).json({ 
                    error: 'Active subscription required',
                    redirect: '/pricing'
                });
            }
            
            console.log('V1 user subscription verified as active');
            // Add subscription info to request
            req.subscription = subscription;
            next();
            
        } catch (stripeError) {
            console.error('Stripe subscription check failed for V1 user:', stripeError);
            return res.status(403).json({ 
                error: 'Subscription verification failed',
                redirect: '/pricing'
            });
        }
        
    } catch (error) {
        console.error('Subscription middleware error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

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

// Helper function to migrate V1 user to V2
const migrateV1UserToV2 = async (v1User) => {
    try {
        console.log('Migrating V1 user to V2:', v1User.email);
        console.log('V1 user type:', v1User.googleId ? 'Google OAuth' : 'Email/Password');
        
        // Create V2 user structure
        const v2User = {
            email: v1User.email.toLowerCase(),
            password: v1User.password || null, // Google users might not have password
            display_name: v1User.name || v1User.display_name || v1User.email.split('@')[0],
            created_at: v1User.createdAt || new Date(),
            updated_at: new Date(),
            migrated_from_v1: true,
            v1_user_id: v1User._id,
            // Preserve Google OAuth data
            googleId: v1User.googleId || null,
            profilePicture: v1User.profilePicture || null,
            firebaseUid: v1User.firebaseUid || null,
            stats: {
                channels_approved: 0,
                channels_rejected: 0,
                total_reviews: 0
            },
            // Preserve subscription data if it exists
            subscription: v1User.subscription || null,
            // Preserve other V1 fields
            isAdmin: v1User.isAdmin || false,
            verified: v1User.verified || false
        };
        
        // Insert into V2 database
        const result = await db.collection('users').insertOne(v2User);
        console.log('V1 user migrated to V2 with ID:', result.insertedId);
        
        // Return the migrated user
        return {
            ...v2User,
            _id: result.insertedId
        };
        
    } catch (error) {
        console.error('Error migrating V1 user:', error);
        throw error;
    }
};

// Helper: generate 6-digit verification code
function generateVerificationCode() {
    return crypto.randomInt(100000, 999999).toString();
}

// Helper: send verification email via Resend
async function sendVerificationEmail(email, code, displayName) {
    if (!resend) {
        console.warn('⚠️ RESEND_API_KEY not set — skipping verification email for', email);
        return false;
    }
    try {
        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'ViewHunt <noreply@viewhunt.app>',
            to: email,
            subject: 'Your ViewHunt verification code: ' + code,
            html: '<div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:0 auto;padding:2rem;background:#0e0e12;color:#e8e8ed;border-radius:12px;">' +
                '<h2 style="margin:0 0 0.5rem;color:#7c6aef;">ViewHunt</h2>' +
                '<p style="margin:0 0 1.5rem;color:#8b8b9e;">Hey ' + (displayName || 'there') + ', verify your email to get started.</p>' +
                '<div style="background:#18181f;border:1px solid #2a2a36;border-radius:10px;padding:1.5rem;text-align:center;margin-bottom:1.5rem;">' +
                '<div style="font-size:2.5rem;font-weight:800;letter-spacing:0.3em;color:#e8e8ed;">' + code + '</div>' +
                '<p style="margin:0.5rem 0 0;font-size:0.85rem;color:#8b8b9e;">Enter this code in the app</p>' +
                '</div>' +
                '<p style="font-size:0.78rem;color:#5c5c6e;margin:0;">This code expires in 15 minutes. If you didn\'t create a ViewHunt account, ignore this email.</p>' +
                '</div>'
        });
        console.log('📧 Verification email sent to', email);
        return true;
    } catch (err) {
        console.error('📧 Failed to send verification email:', err.message);
        return false;
    }
}

// Authentication Routes

// Register new user - Free tier (no invite code) or Invite tier (with code)
app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
        const { email, password, display_name, invite_code } = req.body;

        // If invite code is provided, validate it
        let inviteCodeDoc = null;
        if (invite_code) {
            inviteCodeDoc = await db.collection('invite_codes').findOne({ 
                code: invite_code,
                active: true,
                $or: [
                    { expires_at: { $exists: false } },
                    { expires_at: null },
                    { expires_at: { $gt: new Date() } }
                ]
            });

            if (!inviteCodeDoc) {
                return res.status(403).json({ 
                    error: 'Invalid or expired invite code.' 
                });
            }

            if (inviteCodeDoc.max_uses && inviteCodeDoc.used_count >= inviteCodeDoc.max_uses) {
                return res.status(403).json({ 
                    error: 'This invite code has reached its usage limit.' 
                });
            }
        }

        const { email: reqEmail, password: reqPassword, display_name: reqDisplayName } = req.body;

        // Validation
        if (!reqEmail || !reqPassword || !reqDisplayName) {
            return res.status(400).json({ error: 'Email, password, and display name are required' });
        }

        if (!validateEmail(reqEmail)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        if (reqPassword.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters long' });
        }

        const displayNameError = validateDisplayName(reqDisplayName);
        if (displayNameError) {
            return res.status(400).json({ error: displayNameError });
        }

        // Check if user already exists
        const existingUser = await db.collection('users').findOne({
            $or: [
                { email: reqEmail.toLowerCase() },
                { display_name: reqDisplayName }
            ]
        });

        if (existingUser) {
            if (existingUser.email === reqEmail.toLowerCase()) {
                return res.status(400).json({ error: 'Email already registered' });
            } else {
                return res.status(400).json({ error: 'Display name already taken' });
            }
        }

        // Hash password
        const saltRounds = 12;
        const hashedPassword = await bcrypt.hash(reqPassword, saltRounds);

        // Generate verification code
        const verificationCode = generateVerificationCode();

        // Create user — free tier or invite tier
        const newUser = {
            email: reqEmail.toLowerCase(),
            password: hashedPassword,
            display_name: reqDisplayName,
            created_at: new Date(),
            updated_at: new Date(),
            plan: invite_code ? 'invite' : 'free',
            invited_by_code: invite_code || null,
            emailVerified: false,
            verificationCode: verificationCode,
            verificationCodeExpires: new Date(Date.now() + 15 * 60 * 1000), // 15 min
            stats: {
                channels_approved: 0,
                channels_rejected: 0,
                total_reviews: 0
            }
        };

        const result = await db.collection('users').insertOne(newUser);

        // Update invite code usage if applicable
        if (invite_code && inviteCodeDoc) {
            await db.collection('invite_codes').updateOne(
                { code: invite_code },
                { 
                    $inc: { used_count: 1 },
                    $push: { 
                        used_by: {
                            user_id: result.insertedId,
                            email: reqEmail.toLowerCase(),
                            used_at: new Date()
                        }
                    }
                }
            );
        }

        // Send verification email
        await sendVerificationEmail(reqEmail.toLowerCase(), verificationCode, reqDisplayName);

        res.status(201).json({
            message: 'Account created. Please check your email for a verification code.',
            requiresVerification: true,
            email: reqEmail.toLowerCase()
        });

    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Verify email with 6-digit code
app.post('/api/auth/verify-email', authLimiter, async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) return res.status(400).json({ error: 'Email and code are required' });

        const user = await db.collection('users').findOne({ email: email.toLowerCase() });
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (user.emailVerified) {
            return res.json({ message: 'Email already verified', alreadyVerified: true });
        }

        if (user.verificationCode !== code.trim()) {
            return res.status(400).json({ error: 'Invalid verification code' });
        }

        if (user.verificationCodeExpires && new Date() > new Date(user.verificationCodeExpires)) {
            return res.status(400).json({ error: 'Code expired. Please request a new one.' });
        }

        // Mark as verified, clear code
        await db.collection('users').updateOne(
            { _id: user._id },
            { $set: { emailVerified: true, updated_at: new Date() }, $unset: { verificationCode: '', verificationCodeExpires: '' } }
        );

        // Generate JWT token now that they're verified
        const token = jwt.sign(
            { userId: user._id, email: user.email, display_name: user.display_name },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        console.log('✅ Email verified:', email.toLowerCase());

        res.json({
            message: 'Email verified successfully',
            token,
            user: {
                id: user._id,
                email: user.email,
                display_name: user.display_name,
                stats: user.stats || { channels_approved: 0, channels_rejected: 0, total_reviews: 0 }
            }
        });
    } catch (error) {
        console.error('Verify email error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Resend verification code
app.post('/api/auth/resend-code', rateLimit({ windowMs: 60000, max: 3, message: { error: 'Too many requests. Wait a minute.' } }), async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const user = await db.collection('users').findOne({ email: email.toLowerCase() });
        if (!user) return res.status(404).json({ error: 'User not found' });

        if (user.emailVerified) {
            return res.json({ message: 'Email already verified' });
        }

        const newCode = generateVerificationCode();
        await db.collection('users').updateOne(
            { _id: user._id },
            { $set: { verificationCode: newCode, verificationCodeExpires: new Date(Date.now() + 15 * 60 * 1000) } }
        );

        await sendVerificationEmail(user.email, newCode, user.display_name);

        res.json({ message: 'New verification code sent' });
    } catch (error) {
        console.error('Resend code error:', error);
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

        console.log('Login attempt for email:', email.toLowerCase());

        // Step 1: Try to find user in V2 database first
        let user = await db.collection('users').findOne({ 
            email: email.toLowerCase() 
        });

        let userSource = 'V2';

        // Step 2: If not found in V2, try V1 database
        if (!user && v1Db && v1Db !== db) {
            console.log('User not found in V2, checking V1 database');
            const v1User = await v1Db.collection('users').findOne({ 
                email: email.toLowerCase() 
            });

            if (v1User) {
                console.log('User found in V1 database, migrating to V2');
                user = await migrateV1UserToV2(v1User);
                userSource = 'V1_MIGRATED';
            }
        }

        // Step 3: Handle admin user creation if still not found
        if (!user) {
            console.log('User not found in either database');
            
            // Check if this is admin trying to login for the first time
            if (email.toLowerCase() === process.env.ADMIN_EMAIL?.toLowerCase() && process.env.ADMIN_PASSWORD) {
                console.log('Creating admin user for first time login');
                
                // Create admin user
                const saltRounds = 12;
                const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD, saltRounds);
                
                const adminUser = {
                    email: process.env.ADMIN_EMAIL.toLowerCase(),
                    password: hashedPassword,
                    display_name: 'Admin',
                    created_at: new Date(),
                    updated_at: new Date(),
                    stats: {
                        channels_approved: 0,
                        channels_rejected: 0,
                        total_reviews: 0
                    }
                };

                const result = await db.collection('users').insertOne(adminUser);
                console.log('Admin user created with ID:', result.insertedId);
                
                // Generate JWT token for admin
                const token = jwt.sign(
                    { 
                        userId: result.insertedId, 
                        email: adminUser.email,
                        display_name: adminUser.display_name
                    },
                    process.env.JWT_SECRET,
                    { expiresIn: '7d' }
                );

                return res.json({
                    message: 'Admin login successful',
                    token,
                    user: {
                        id: result.insertedId,
                        email: adminUser.email,
                        display_name: adminUser.display_name,
                        stats: adminUser.stats
                    }
                });
            }
            
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        console.log(`User found in ${userSource}, checking password`);

        // Step 4: Check password
        // Handle Google OAuth users (they don't have passwords)
        if (user.googleId && !user.password) {
            console.log('Google OAuth user detected, but trying to login with password');
            return res.status(401).json({ 
                error: 'This account uses Google Sign-In. Please use Google to login.',
                isGoogleUser: true
            });
        }
        
        // Regular password check
        if (!user.password) {
            console.log('User has no password set:', email.toLowerCase());
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
            console.log('Invalid password for user:', email.toLowerCase());
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        // Step 5: Check email verification (skip for existing users without the field, admin, and migrated users)
        if (user.emailVerified === false) {
            console.log('Unverified email login attempt:', email.toLowerCase());
            return res.status(403).json({
                error: 'Please verify your email before signing in.',
                requiresVerification: true,
                email: user.email
            });
        }

        console.log(`Login successful for user: ${email.toLowerCase()} (${userSource})`);

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

// Test route to verify OAuth routes are working
app.get('/auth/test', (req, res) => {
    res.json({ message: 'OAuth routes are working', timestamp: new Date() });
});

// Google OAuth initialization route
app.get('/auth/google', (req, res) => {
    // Check if Google OAuth is configured
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CALLBACK_URL) {
        console.error('Google OAuth not configured');
        return res.redirect('/app?error=google_oauth_not_configured');
    }
    
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${process.env.GOOGLE_CLIENT_ID}&` +
        `redirect_uri=${encodeURIComponent(process.env.GOOGLE_CALLBACK_URL)}&` +
        `response_type=code&` +
        `scope=${encodeURIComponent('email profile')}&` +
        `access_type=offline&` +
        `prompt=consent`;
    
    console.log('Redirecting to Google OAuth:', googleAuthUrl);
    res.redirect(googleAuthUrl);
});

// Google OAuth callback route
app.get('/auth/google/callback', async (req, res) => {
    try {
        console.log('Google OAuth callback received');
        console.log('Query params:', req.query);
        
        const { code, error } = req.query;
        
        if (error) {
            console.error('Google OAuth error:', error);
            return res.redirect('/app?error=oauth_denied');
        }
        
        if (!code) {
            console.error('No authorization code received');
            return res.redirect('/app?error=oauth_failed');
        }
        
        // Check if Google OAuth is configured
        if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
            console.error('Google OAuth credentials not configured');
            return res.redirect('/app?error=google_oauth_not_configured');
        }
        
        console.log('Exchanging code for tokens...');
        
        // Exchange code for tokens
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                code: code,
                grant_type: 'authorization_code',
                redirect_uri: process.env.GOOGLE_CALLBACK_URL,
            }),
        });
        
        const tokens = await tokenResponse.json();
        
        if (!tokens.access_token) {
            throw new Error('Failed to get access token');
        }
        
        // Get user info from Google
        const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: {
                'Authorization': `Bearer ${tokens.access_token}`,
            },
        });
        
        const googleUser = await userResponse.json();
        
        // Process the Google user (same logic as POST endpoint)
        const result = await processGoogleUser(googleUser);
        
        if (result.success) {
            // Redirect to app with token
            res.redirect(`/app?token=${result.token}&success=google_login`);
        } else {
            res.redirect(`/app?error=${encodeURIComponent(result.error)}`);
        }
        
    } catch (error) {
        console.error('Google OAuth callback error:', error);
        res.redirect('/app?error=oauth_failed');
    }
});

// Fallback route for debugging OAuth callback issues
app.get('/auth/google/callback/test', (req, res) => {
    res.json({ 
        message: 'OAuth callback route is accessible',
        query: req.query,
        timestamp: new Date()
    });
});

// Google OAuth callback logging middleware
app.use('/auth/google/callback', (req, res, next) => {
    console.log('=== GOOGLE OAUTH CALLBACK HIT ===');
    console.log('Method:', req.method);
    console.log('Query:', req.query);
    console.log('================================');
    next();
});

// Helper function to process Google user
async function processGoogleUser(googleUser) {
    try {
        const { email, name, id: googleId, picture: profilePicture } = googleUser;
        
        console.log('Google OAuth login attempt for:', email);

        // Step 1: Try to find user in V2 database first
        let user = await db.collection('users').findOne({ 
            $or: [
                { email: email.toLowerCase() },
                { googleId: googleId }
            ]
        });

        let userSource = 'V2';

        // Step 2: If not found in V2, try V1 database
        if (!user && v1Db && v1Db !== db) {
            console.log('Google user not found in V2, checking V1 database');
            const v1User = await v1Db.collection('users').findOne({ 
                $or: [
                    { email: email.toLowerCase() },
                    { googleId: googleId }
                ]
            });

            if (v1User) {
                console.log('Google user found in V1 database, migrating to V2');
                user = await migrateV1UserToV2(v1User);
                userSource = 'V1_MIGRATED';
            }
        }

        // Step 3: If still not found, create new user
        if (!user) {
            console.log('Creating new Google user');
            const newUser = {
                email: email.toLowerCase(),
                display_name: name || email.split('@')[0],
                googleId: googleId,
                profilePicture: profilePicture || null,
                created_at: new Date(),
                updated_at: new Date(),
                migrated_from_v1: false, // New V2 user
                plan: 'free',
                stats: {
                    channels_approved: 0,
                    channels_rejected: 0,
                    total_reviews: 0
                }
            };

            const result = await db.collection('users').insertOne(newUser);
            user = { ...newUser, _id: result.insertedId };
            userSource = 'NEW_V2';
        }

        console.log(`Google login successful for: ${email} (${userSource})`);

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

        return {
            success: true,
            token: token,
            user: {
                id: user._id,
                email: user.email,
                display_name: user.display_name,
                profilePicture: user.profilePicture,
                stats: user.stats || { channels_approved: 0, channels_rejected: 0, total_reviews: 0 }
            }
        };

    } catch (error) {
        console.error('Google user processing error:', error);
        return {
            success: false,
            error: 'Failed to process Google login'
        };
    }
}

// Google OAuth login route (for API calls)
app.post('/api/auth/google', async (req, res) => {
    try {
        const { email, name, googleId, profilePicture } = req.body;

        if (!email || !googleId) {
            return res.status(400).json({ error: 'Email and Google ID are required' });
        }

        console.log('Google OAuth login attempt for:', email.toLowerCase());

        // Step 1: Try to find user in V2 database first
        let user = await db.collection('users').findOne({ 
            $or: [
                { email: email.toLowerCase() },
                { googleId: googleId }
            ]
        });

        let userSource = 'V2';

        // Step 2: If not found in V2, try V1 database
        if (!user && v1Db && v1Db !== db) {
            console.log('Google user not found in V2, checking V1 database');
            const v1User = await v1Db.collection('users').findOne({ 
                $or: [
                    { email: email.toLowerCase() },
                    { googleId: googleId }
                ]
            });

            if (v1User) {
                console.log('Google user found in V1 database, migrating to V2');
                user = await migrateV1UserToV2(v1User);
                userSource = 'V1_MIGRATED';
            }
        }

        // Step 3: If still not found, create new user
        if (!user) {
            console.log('Creating new Google user');
            const newUser = {
                email: email.toLowerCase(),
                display_name: name || email.split('@')[0],
                googleId: googleId,
                profilePicture: profilePicture || null,
                created_at: new Date(),
                updated_at: new Date(),
                migrated_from_v1: false, // New V2 user
                plan: 'free',
                stats: {
                    channels_approved: 0,
                    channels_rejected: 0,
                    total_reviews: 0
                }
            };

            const result = await db.collection('users').insertOne(newUser);
            user = { ...newUser, _id: result.insertedId };
            userSource = 'NEW_V2';
        }

        console.log(`Google login successful for: ${email.toLowerCase()} (${userSource})`);

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
            message: 'Google login successful',
            token,
            user: {
                id: user._id,
                email: user.email,
                display_name: user.display_name,
                profilePicture: user.profilePicture,
                stats: user.stats || { channels_approved: 0, channels_rejected: 0, total_reviews: 0 }
            }
        });

    } catch (error) {
        console.error('Google login error:', error);
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

        // Determine subscription status
        const BETA_CUTOFF_DATE = new Date('2025-07-21');
        const userCreatedAt = new Date(user.created_at);
        
        let subscriptionStatus = {
            hasAccess: false,
            type: 'none',
            status: 'inactive',
            reason: 'No subscription'
        };

        // Admin always has access
        if (user.email === process.env.ADMIN_EMAIL) {
            subscriptionStatus = {
                hasAccess: true,
                type: 'admin',
                status: 'active',
                reason: 'Admin access'
            };
        }
        // INVITE USERS get free access (but only if code is still active)
        else if (user.invited_by_code) {
            // Check if the invite code is still active
            const inviteCode = await db.collection('invite_codes').findOne({ 
                code: user.invited_by_code 
            });
            
            if (inviteCode && inviteCode.active) {
                subscriptionStatus = {
                    hasAccess: true,
                    type: 'invite',
                    status: 'active',
                    reason: 'Invite access',
                    inviteCode: user.invited_by_code
                };
            } else {
                subscriptionStatus = {
                    hasAccess: false,
                    type: 'invite_revoked',
                    status: 'inactive',
                    reason: 'Invite code deactivated',
                    inviteCode: user.invited_by_code
                };
            }
        }
        // V2 Beta users (created before cutoff) get free access
        else if (!user.migrated_from_v1 && userCreatedAt < BETA_CUTOFF_DATE) {
            subscriptionStatus = {
                hasAccess: true,
                type: 'beta',
                status: 'active',
                reason: 'Beta tester access'
            };
        }
        // V1 migrated users need active subscription
        else if (user.migrated_from_v1) {
            if (user.subscription && user.subscription.stripeSubscriptionId && stripe) {
                try {
                    const subscription = await stripe.subscriptions.retrieve(user.subscription.stripeSubscriptionId);
                    subscriptionStatus = {
                        hasAccess: subscription.status === 'active',
                        type: 'stripe',
                        status: subscription.status,
                        reason: subscription.status === 'active' ? 'Active subscription' : `Subscription ${subscription.status}`,
                        stripeSubscriptionId: subscription.id,
                        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
                        cancelAtPeriodEnd: subscription.cancel_at_period_end
                    };
                } catch (stripeError) {
                    console.error('Stripe subscription check failed:', stripeError);
                    subscriptionStatus.reason = 'Subscription verification failed';
                }
            } else {
                subscriptionStatus.reason = 'Subscription required';
            }
        }
        // New V2 users — check for paid subscription, otherwise free tier
        else {
            if (user.subscription && user.subscription.stripeSubscriptionId && stripe) {
                try {
                    const subscription = await stripe.subscriptions.retrieve(user.subscription.stripeSubscriptionId);
                    subscriptionStatus = {
                        hasAccess: subscription.status === 'active',
                        type: 'stripe',
                        status: subscription.status,
                        plan: user.subscription.plan || 'starter',
                        reason: subscription.status === 'active' ? 'Active subscription' : `Subscription ${subscription.status}`,
                        stripeSubscriptionId: subscription.id,
                        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
                        cancelAtPeriodEnd: subscription.cancel_at_period_end
                    };
                } catch (stripeError) {
                    console.error('Stripe subscription check failed:', stripeError);
                    subscriptionStatus.reason = 'Subscription verification failed';
                }
            } else {
                // Free tier — limited niche access, no studio
                subscriptionStatus = {
                    hasAccess: true,
                    type: 'free',
                    status: 'active',
                    plan: 'free',
                    reason: 'Free tier — limited access',
                    nicheLimit: 10
                };
            }
        }

        res.json({
            id: user._id,
            email: user.email,
            display_name: user.display_name,
            profilePicture: user.profilePicture,
            created_at: user.created_at,
            migrated_from_v1: user.migrated_from_v1 || false,
            emailVerified: user.emailVerified !== false, // existing users without field = verified
            subscription: subscriptionStatus,
            stats: user.stats || { channels_approved: 0, channels_rejected: 0, total_reviews: 0 }
        });

    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get user subscription status (separate endpoint for frequent checks)
app.get('/api/user/subscription-status', authenticateToken, async (req, res) => {
    try {
        const user = await db.collection('users').findOne(
            { _id: new ObjectId(req.user.userId) },
            { projection: { subscription: 1, created_at: 1, migrated_from_v1: 1 } }
        );

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Determine access level
        const BETA_CUTOFF_DATE = new Date('2025-01-01');
        const userCreatedAt = new Date(user.created_at);
        
        let hasAccess = false;
        let reason = '';
        
        if (user.migrated_from_v1) {
            hasAccess = user.subscription && user.subscription.stripeSubscriptionId;
            reason = hasAccess ? 'v1_subscriber' : 'v1_no_subscription';
        } else if (userCreatedAt < BETA_CUTOFF_DATE) {
            hasAccess = true;
            reason = 'v2_beta_access';
        } else {
            hasAccess = user.subscription && user.subscription.stripeSubscriptionId;
            reason = hasAccess ? 'new_v2_subscriber' : 'new_v2_no_subscription';
        }

        res.json({
            hasAccess: hasAccess,
            reason: reason,
            requiresSubscription: !hasAccess && (user.migrated_from_v1 || userCreatedAt >= BETA_CUTOFF_DATE)
        });

    } catch (error) {
        console.error('Get subscription status error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API Routes

// Old pending endpoint removed - using user-specific endpoint below

// Manually trigger auto-collector (admin only)
app.post('/api/channels/auto-collect', authenticateToken, async (req, res) => {
    if (req.user.email !== process.env.ADMIN_EMAIL) {
        return res.status(403).json({ error: 'Admin only' });
    }
    res.json({ message: 'Auto-collector started. Check server logs for progress.' });
    // Run in background — don't block the response
    runDailyCollection(db).then(function(result) {
        console.log('🤖 Manual auto-collect finished:', result);
    }).catch(function(err) {
        console.error('🤖 Manual auto-collect error:', err.message);
    });
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
                console.log(`Processing channel: ${channel.channelName}, enhanced: ${channel.enhanced}, recentAverage: ${channel.recentAverage}`);
                
                const channelDoc = {
                    channel_name: channel.channelName,
                    channel_url: channel.channelUrl,
                    video_title: channel.videoTitle,
                    view_count: channel.viewCount,
                    subscriber_count: channel.subscriberCount || 0,
                    view_to_sub_ratio: channel.viewToSubRatio || 0,
                    avatar_url: channel.avatarUrl || null,
                    // Video and thumbnail data
                    video_url: channel.videoUrl || null,
                    thumbnail_url: channel.thumbnailUrl || null,
                    // Channel-level statistics
                    total_views: channel.totalViews || 0,
                    video_count: channel.videoCount || 0,
                    average_views: channel.averageViews || 0,
                    // Enhanced analysis data
                    enhanced: channel.enhanced || false,
                    recent_average: channel.recentAverage || null,
                    videos_analyzed: channel.videosAnalyzed || null,
                    // 🔥 NEW: Recent shorts with clickable links
                    recent_shorts: channel.recentShorts || null,
                    last_enhanced_update: channel.lastUpdated || null,
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

// Enhanced analysis endpoint - calls Apify API for recent video data
app.post('/api/channels/enhanced-analysis', async (req, res) => {
    const { channelUrl, channelName } = req.body;
    
    if (!channelUrl) {
        return res.status(400).json({ error: 'Channel URL is required' });
    }
    
    try {
        console.log(`Enhanced analysis requested for: ${channelName || channelUrl}`);
        
        // Call Apify API to get recent video data
        const apifyToken = process.env.APIFY_TOKEN;
        let videos = [];
        
        if (!apifyToken) {
            console.error('APIFY_TOKEN not configured, using mock data');
        } else {
            try {
                console.log(`Calling Apify for channel data: ${channelName}`);
                
                // Call the maged120/youtube-channel-data actor
                const apifyResponse = await fetch(`https://api.apify.com/v2/acts/maged120~youtube-channel-data/run-sync-get-dataset-items?token=${apifyToken}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        channel_identifier: channelUrl,
                        max_results: 10, // Exactly 10 shorts to save quota
                        select_types: ["short"], // Only get shorts for accurate shorts performance
                        sleep_interval: 1, // Reduce sleep to speed up
                        max_retries: 2 // Reduce retries to speed up
                    })
                });
                
                if (apifyResponse.ok) {
                    const apifyData = await apifyResponse.json();
                    console.log(`Apify returned data for ${channelName}:`, JSON.stringify(apifyData.slice(0, 2), null, 2)); // Log first 2 items to see structure
                    
                    if (Array.isArray(apifyData) && apifyData.length > 0) {
                        // Transform Apify data to our expected format
                        videos = apifyData.map(video => ({
                            view_count: parseInt(video.viewCount || video.view_count || video.views) || 0,
                            short: video.isShort || video.is_short || video.type === 'short' || false,
                            type: video.isShort || video.is_short || video.type === 'short' ? 'short' : 'video',
                            title: video.title || 'Unknown',
                            video_id: video.videoId || video.video_id || video.id
                        })).filter(v => v.view_count > 0);
                        
                        console.log(`Processed ${videos.length} valid videos for ${channelName}`);
                        
                        // Debug: Log the view counts we're using for calculation
                        const viewCounts = videos.map(v => v.view_count);
                        const mean = viewCounts.reduce((a, b) => a + b, 0) / viewCounts.length;
                        console.log(`View counts for ${channelName}:`, viewCounts);
                        console.log(`Manual mean calculation: ${Math.round(mean)}`);
                    } else {
                        console.log(`Apify returned empty or invalid data for ${channelName}`);
                    }
                } else {
                    const errorText = await apifyResponse.text();
                    console.error(`Apify API error for ${channelName}: ${apifyResponse.status} - ${errorText}`);
                }
            } catch (apifyError) {
                console.error(`Apify request failed for ${channelName}:`, apifyError.message);
            }
        }
        
        // Fall back to mock data if Apify failed or no token
        if (videos.length === 0) {
            console.log(`Using mock data for: ${channelName}`);
            const baseViews = Math.floor(Math.random() * 100000) + 20000;
            videos = Array.from({ length: 10 }, (_, i) => ({
                view_count: Math.floor(baseViews * (0.7 + Math.random() * 0.6)),
                short: Math.random() > 0.5,
                type: Math.random() > 0.5 ? 'short' : 'video',
                title: `Video ${i + 1}`,
                video_id: `mock_${i}_${Date.now()}`
            }));
            console.log(`Generated ${videos.length} mock videos for ${channelName}`);
        }
        
        if (!Array.isArray(videos) || videos.length === 0) {
            console.log(`No videos found for ${channelName}`);
            return res.json({
                enhanced: false,
                reason: 'No recent videos found'
            });
        }
        
        // Calculate enhanced metrics from recent videos
        const enhancedMetrics = calculateEnhancedMetrics(videos);
        
        if (!enhancedMetrics) {
            console.log(`Enhanced metrics calculation failed for ${channelName}`);
            return res.json({
                enhanced: false,
                reason: 'Failed to calculate enhanced metrics'
            });
        }
        
        console.log(`Enhanced analysis complete for ${channelName}: ${enhancedMetrics.videosAnalyzed} videos analyzed`);
        
        const responseData = {
            enhanced: true,
            ...enhancedMetrics,
            videosAnalyzed: videos.length,
            lastUpdated: new Date()
        };
        
        console.log(`Enhanced analysis response for ${channelName}:`, JSON.stringify(responseData, null, 2));
        res.json(responseData);
        
    } catch (error) {
        console.error('Enhanced analysis error:', error);
        res.status(500).json({ 
            error: 'Enhanced analysis failed',
            enhanced: false 
        });
    }
});

// Helper function to calculate enhanced metrics from video data
function calculateEnhancedMetrics(videos) {
    if (!videos || videos.length === 0) return null;
    
    // Get view counts from recent videos (last 7-10)
    const recentVideos = videos.slice(0, Math.min(10, videos.length));
    const viewCounts = recentVideos
        .map(v => v.view_count || 0)
        .filter(count => count > 0)
        .sort((a, b) => b - a);
    
    console.log(`calculateEnhancedMetrics: Processing ${recentVideos.length} videos`);
    console.log(`View counts (sorted):`, viewCounts);
    
    if (viewCounts.length === 0) {
        return {
            enhanced: false,
            reason: 'No valid view counts found'
        };
    }
    
    const mean = viewCounts.reduce((a, b) => a + b) / viewCounts.length;
    const median = viewCounts[Math.floor(viewCounts.length / 2)];
    
    console.log(`Calculation: mean=${Math.round(mean)}, median=${Math.round(median)}`);
    
    // Trimmed mean (remove highest and lowest to reduce outlier impact)
    let trimmedMean = mean;
    if (viewCounts.length >= 3) {
        const trimmed = viewCounts.slice(1, -1);
        trimmedMean = trimmed.reduce((a, b) => a + b) / trimmed.length;
    }
    
    // Consistency score (lower coefficient of variation = more consistent)
    const variance = viewCounts.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / viewCounts.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = mean > 0 ? stdDev / mean : 0;
    const consistencyScore = Math.max(0, 100 - (coefficientOfVariation * 100));
    
    // Detect viral outliers
    const maxView = Math.max(...viewCounts);
    const avgWithoutMax = viewCounts.filter(v => v !== maxView).reduce((a, b) => a + b, 0) / (viewCounts.length - 1);
    const viralMultiplier = avgWithoutMax > 0 ? maxView / avgWithoutMax : 1;
    const hasViralOutlier = viralMultiplier > 4;
    
    // Performance trend (comparing first half vs second half)
    const firstHalf = viewCounts.slice(0, Math.ceil(viewCounts.length / 2));
    const secondHalf = viewCounts.slice(Math.ceil(viewCounts.length / 2));
    const firstHalfAvg = firstHalf.reduce((a, b) => a + b) / firstHalf.length;
    const secondHalfAvg = secondHalf.reduce((a, b) => a + b) / secondHalf.length;
    const trendPercentage = Math.round(((firstHalfAvg - secondHalfAvg) / secondHalfAvg) * 100);
    
    let trendDirection = 'STABLE';
    if (Math.abs(trendPercentage) >= 15) {
        trendDirection = trendPercentage > 0 ? 'IMPROVING' : 'DECLINING';
    }
    
    // Count shorts vs regular videos
    const shortsCount = recentVideos.filter(v => v.short === true || v.type === 'short').length;
    const regularCount = recentVideos.length - shortsCount;
    
    return {
        // RECENT AVERAGE - Distribution-aware metric from last 10 videos
        recentAverage: hasViralOutlier ? Math.round(trimmedMean) : Math.round(mean),
        
        // Detailed breakdown for debugging/analysis
        recentMean: Math.round(mean),
        recentMedian: Math.round(median),
        recentTrimmedMean: Math.round(trimmedMean),
        
        // Distribution analysis
        consistencyScore: Math.round(consistencyScore),
        hasViralOutlier,
        viralMultiplier: hasViralOutlier ? parseFloat(viralMultiplier.toFixed(1)) : null,
        
        // Performance insights
        trendDirection,
        trendPercentage,
        
        // Content breakdown
        shortsCount,
        regularCount,
        videosAnalyzed: recentVideos.length,
        
        // Quality indicators
        isConsistent: consistencyScore > 70,
        distributionIssue: Math.abs(mean - median) / mean > 0.3,
        
        // View range for context
        viewRange: {
            min: Math.min(...viewCounts),
            max: Math.max(...viewCounts)
        }
    };
}

// Approve a channel (requires authentication) - User-specific approach
app.put('/api/channels/:id/approve', authenticateToken, requireSubscription, async (req, res) => {
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
        
        // AUTO-SYNC TO STUDENT ACCOUNT: If admin approves, also approve for student account
        const isAdmin = req.user.email === process.env.ADMIN_EMAIL;
        if (isAdmin) {
            try {
                // Find the student account
                const studentAccount = await db.collection('users').findOne({ 
                    email: 'students@viewhunt.com' 
                });
                
                if (studentAccount) {
                    // Check if student account already approved this channel
                    const studentExistingAction = await db.collection('user_channel_actions').findOne({
                        user_id: studentAccount._id,
                        channel_id: new ObjectId(channelId)
                    });
                    
                    // Only add if student hasn't already acted on it
                    if (!studentExistingAction) {
                        await db.collection('user_channel_actions').insertOne({
                            user_id: studentAccount._id,
                            channel_id: new ObjectId(channelId),
                            action: 'approved',
                            created_at: new Date(),
                            user_name: 'Student Account (Auto-synced)',
                            synced_from_admin: true
                        });
                        
                        // Update student account stats
                        await db.collection('users').updateOne(
                            { _id: studentAccount._id },
                            { 
                                $inc: { 
                                    'stats.channels_approved': 1,
                                    'stats.total_reviews': 1
                                },
                                $set: { updated_at: new Date() }
                            }
                        );
                        
                        console.log(`✅ Auto-synced approval to student account for channel: ${channel.channel_name}`);
                    }
                }
            } catch (syncError) {
                console.error('Error syncing to student account:', syncError);
                // Don't fail the main approval if sync fails
            }
        }
        
        res.json({ message: 'Channel approved' });
    } catch (error) {
        console.error('Error approving channel:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Reject a channel (requires authentication) - User-specific approach
app.put('/api/channels/:id/reject', authenticateToken, requireSubscription, async (req, res) => {
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
app.get('/api/channels/approved', authenticateToken, requireSubscription, async (req, res) => {
    try {
        const userId = new ObjectId(req.user.userId);
        const isAdmin = req.user.email === 'nwalikelv@gmail.com' || req.user.email === 'kevis@viewhunt.com';
        const isStudentAccount = req.user.email === 'students@viewhunt.com';
        
        // Admin OR Student account get the full approved list
        if (isAdmin || isStudentAccount) {
            // Get admin user ID for marking admin-approved channels
            const adminUser = await db.collection('users').findOne({ 
                email: process.env.ADMIN_EMAIL 
            });
            const adminUserId = adminUser ? adminUser._id : null;
            
            // Pagination parameters
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 50; // 50 channels per page
            const skip = (page - 1) * limit;
            
            // Get filter parameters for admin
            const enhancedOnly = req.query.enhancedOnly === 'true';
            const activeRecently = req.query.activeRecently === 'true';
            const videoTitleSearch = req.query.videoTitle ? req.query.videoTitle.trim() : null;
            const minRecentAvg = parseInt(req.query.minRecentAvg) || 0;
            const maxRecentAvg = req.query.maxRecentAvg ? parseInt(req.query.maxRecentAvg) : null;
            const minViews = parseInt(req.query.minViews) || 0;
            const maxViews = req.query.maxViews ? parseInt(req.query.maxViews) : null;
            const minSubs = parseInt(req.query.minSubs) || 0;
            const maxSubs = req.query.maxSubs ? parseInt(req.query.maxSubs) : null;
            const minVideos = parseInt(req.query.minVideos) || 0;
            const maxVideos = req.query.maxVideos ? parseInt(req.query.maxVideos) : null;
            
            // Build match query for approved channels
            const approvedMatchQuery = {
                'approvals.action': 'approved'
            };
            
            // Add video title search filter (case-insensitive partial match)
            if (videoTitleSearch) {
                approvedMatchQuery.video_title = { $regex: videoTitleSearch, $options: 'i' };
            }
            
            // Add enhanced filter
            if (enhancedOnly) {
                approvedMatchQuery.enhanced = true;
                approvedMatchQuery.recent_average = { $exists: true, $ne: null };
            }
            
            // Active recently filter will be handled in aggregation pipeline
            if (activeRecently) {
                approvedMatchQuery.enhanced = true;
                approvedMatchQuery.recent_shorts = { $exists: true, $ne: null, $not: { $size: 0 } };
            }
            
            // Add recent average filters
            if (minRecentAvg > 0 || maxRecentAvg) {
                approvedMatchQuery.recent_average = approvedMatchQuery.recent_average || {};
                if (minRecentAvg > 0) approvedMatchQuery.recent_average.$gte = minRecentAvg;
                if (maxRecentAvg) approvedMatchQuery.recent_average.$lte = maxRecentAvg;
            }
            
            // Add other filters
            if (minViews > 0 || maxViews) {
                approvedMatchQuery.average_views = {};
                if (minViews > 0) approvedMatchQuery.average_views.$gte = minViews;
                if (maxViews) approvedMatchQuery.average_views.$lte = maxViews;
            }
            
            if (minSubs > 0 || maxSubs) {
                approvedMatchQuery.subscriber_count = {};
                if (minSubs > 0) approvedMatchQuery.subscriber_count.$gte = minSubs;
                if (maxSubs) approvedMatchQuery.subscriber_count.$lte = maxSubs;
            }
            
            if (minVideos > 0 || maxVideos) {
                approvedMatchQuery.video_count = {};
                if (minVideos > 0) approvedMatchQuery.video_count.$gte = minVideos;
                if (maxVideos) approvedMatchQuery.video_count.$lte = maxVideos;
            }
            
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
                        $match: approvedMatchQuery
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
                                        in: { $eq: ['$$approval.user_id', adminUserId] }
                                    }
                                }
                            },
                            current_user_approved: {
                                $anyElementTrue: {
                                    $map: {
                                        input: '$approvals',
                                        as: 'approval',
                                        in: { $eq: ['$$approval.user_id', userId] }
                                    }
                                }
                            }
                        }
                    },
                    ...(activeRecently ? [{
                        $addFields: {
                            recentVideosCount: {
                                $size: {
                                    $filter: {
                                        input: { $ifNull: ["$recent_shorts", []] },
                                        cond: { 
                                            $gte: [
                                                { $toDate: "$$this.publishedAt" },
                                                new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
                                            ]
                                        }
                                    }
                                }
                            }
                        }
                    }, {
                        $match: { recentVideosCount: { $gte: 4 } }
                    }] : []),
                    { $sort: { first_approval_time: -1, approval_count: -1 } },
                    {
                        $facet: {
                            channels: [
                                { $skip: skip },
                                { $limit: limit }
                            ],
                            totalCount: [
                                { $count: 'count' }
                            ]
                        }
                    }
                ], { allowDiskUse: true })
                .toArray();
            
            const result = channels[0];
            const totalChannels = result.totalCount[0]?.count || 0;
            const totalPages = Math.ceil(totalChannels / limit);
            
            res.json({
                channels: result.channels,
                pagination: {
                    currentPage: page,
                    totalPages,
                    totalChannels,
                    hasMore: page < totalPages,
                    limit
                }
            });
        } else {
            // Regular users see only their approved channels
            // Pagination parameters
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 50;
            const skip = (page - 1) * limit;
            
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
                    {
                        $facet: {
                            channels: [
                                { $skip: skip },
                                { $limit: limit }
                            ],
                            totalCount: [
                                { $count: 'count' }
                            ]
                        }
                    },
                    {
                        $project: {
                            channels: {
                                $map: {
                                    input: '$channels',
                                    as: 'item',
                                    in: {
                                        $mergeObjects: ['$$item.channel', { approved_at: '$$item.created_at' }]
                                    }
                                }
                            },
                            totalCount: 1
                        }
                    }
                ])
                .toArray();
            
            const result = userApprovals[0];
            const totalChannels = result.totalCount[0]?.count || 0;
            const totalPages = Math.ceil(totalChannels / limit);
            
            res.json({
                channels: result.channels,
                pagination: {
                    currentPage: page,
                    totalPages,
                    totalChannels,
                    hasMore: page < totalPages,
                    limit
                }
            });
        }
    } catch (error) {
        console.error('Error fetching approved channels:', error);
        res.status(500).json({ error: 'Database error' });
    }
});

// Get pending channels for user (excluding already reviewed) - SIMPLIFIED VERSION
app.get('/api/channels/pending', authenticateToken, requireSubscription, async (req, res) => {
    try {
        const userId = new ObjectId(req.user.userId);
        
        // Free tier: limit to 10 channels per day
        if (req.userPlan === 'free') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const viewsToday = await db.collection('free_tier_views').countDocuments({
                user_id: userId,
                date: { $gte: today }
            });
            if (viewsToday >= 10) {
                return res.json({
                    channels: [],
                    pagination: { page: 1, limit: 0, total: 0, totalPages: 0 },
                    freeTierLimitReached: true,
                    message: 'Free tier limit reached (10 channels/day). Upgrade for unlimited access.'
                });
            }
        }
        
        // Pagination parameters
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;
        
        // Sort parameters
        const primarySort = req.query.primarySort || 'ratio-desc';
        const secondarySort = req.query.secondarySort || 'none';
        
        // Filter parameters
        const enhancedOnly = req.query.enhancedOnly === 'true';
        const activeRecently = req.query.activeRecently === 'true';
        const videoTitleSearch = req.query.videoTitle ? req.query.videoTitle.trim() : null;
        const minRecentAvg = parseInt(req.query.minRecentAvg) || 0;
        const maxRecentAvg = req.query.maxRecentAvg ? parseInt(req.query.maxRecentAvg) : null;
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
        
        // Add video title search filter (case-insensitive partial match)
        if (videoTitleSearch) {
            matchQuery.video_title = { $regex: videoTitleSearch, $options: 'i' };
        }
        
        // Add enhanced filter if specified
        if (enhancedOnly) {
            matchQuery.enhanced = true;
            matchQuery.recent_average = { $exists: true, $ne: null };
        }
        
        // Active recently filter requires enhanced data and will be handled in aggregation
        if (activeRecently) {
            matchQuery.enhanced = true;
            matchQuery.recent_shorts = { $exists: true, $ne: null, $not: { $size: 0 } };
        }
        
        // Add recent average filters if specified
        if (minRecentAvg > 0 || maxRecentAvg) {
            matchQuery.recent_average = matchQuery.recent_average || {};
            if (minRecentAvg > 0) matchQuery.recent_average.$gte = minRecentAvg;
            if (maxRecentAvg) matchQuery.recent_average.$lte = maxRecentAvg;
        }
        
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
                case 'recent-avg-desc': return ['recent_average', -1];
                case 'recent-avg-asc': return ['recent_average', 1];
                case 'subs-desc': return ['subscriber_count', -1];
                case 'subs-asc': return ['subscriber_count', 1];
                case 'videos-desc': return ['video_count', -1];
                case 'videos-asc': return ['video_count', 1];
                case 'newest': return ['created_at', -1];
                case 'oldest': return ['created_at', 1];
                case 'approval-time-desc': return ['first_approval_time', -1];
                case 'approval-time-asc': return ['first_approval_time', 1];
                case 'approvals-desc': return ['approval_count', -1];
                case 'approvals-asc': return ['approval_count', 1];
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
        
        let channels, totalChannels;
        
        if (activeRecently) {
            try {
                // Use aggregation pipeline for Active Recently filter
                const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
                console.log('Active Recently filter - twoWeeksAgo:', twoWeeksAgo);
                
                // Simplified pipeline to avoid complex date operations
                const pipeline = [
                    { $match: matchQuery },
                    {
                        $addFields: {
                            recentVideosCount: {
                                $size: {
                                    $filter: {
                                        input: { $ifNull: ["$recent_shorts", []] },
                                        cond: { 
                                            $and: [
                                                { $ne: ["$$this.publishedAt", null] },
                                                { $ne: ["$$this.publishedAt", ""] },
                                                { $gte: ["$$this.publishedAt", twoWeeksAgo.toISOString()] }
                                            ]
                                        }
                                    }
                                }
                            }
                        }
                    },
                    { $match: { recentVideosCount: { $gte: 4 } } },
                    { $sort: sortQuery },
                    {
                        $facet: {
                            channels: [{ $skip: skip }, { $limit: limit }],
                            totalCount: [{ $count: "count" }]
                        }
                    }
                ];
                
                console.log('Executing aggregation pipeline for activeRecently');
                const result = await db.collection('channels').aggregate(pipeline, { allowDiskUse: true }).toArray();
                channels = result[0].channels;
                totalChannels = result[0].totalCount[0]?.count || 0;
                console.log('Active Recently results:', { totalChannels, channelsCount: channels.length });
            } catch (error) {
                console.error('Error in activeRecently aggregation:', error);
                // Fallback to simple query without activeRecently filter
                totalChannels = await db.collection('channels').countDocuments(matchQuery);
                channels = await db.collection('channels')
                    .find(matchQuery)
                    .sort(sortQuery)
                    .skip(skip)
                    .limit(limit)
                    .toArray();
            }
        } else {
            // Use simple query for other filters
            totalChannels = await db.collection('channels').countDocuments(matchQuery);
            
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
            
            channels = await db.collection('channels')
                .find(matchQuery)
                .sort(sortQuery)
                .skip(skip)
                .limit(limit)
                .toArray();
        }
        
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
        
        // Track free tier views
        if (req.userPlan === 'free' && channels.length > 0) {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            await db.collection('free_tier_views').insertOne({
                user_id: userId,
                date: new Date(),
                count: channels.length
            });
        }
        
        res.json({
            channels,
            pagination: {
                currentPage: page,
                totalPages,
                totalChannels,
                hasNext: page < totalPages,
                hasPrev: page > 1,
                limit
            },
            userPlan: req.userPlan || null
        });
        
    } catch (error) {
        console.error('Error fetching pending channels:', error);
        res.status(500).json({ error: 'Database error', details: error.message });
    }
});

// Get trending channels (based on recent approvals from multiple users)
app.get('/api/channels/trending', authenticateToken, requireSubscription, async (req, res) => {
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

// Get stats - user-specific for regular users, global for admin
app.get('/api/stats', authenticateToken, async (req, res) => {
    try {
        const userId = new ObjectId(req.user.userId);
        const isAdmin = req.user.email === 'nwalikelv@gmail.com' || req.user.email === 'kevis@viewhunt.com';

        // Get pending count (same for everyone)
        const pending = await db.collection('channels').countDocuments({ status: 'pending' });

        let approved;
        if (isAdmin) {
            // Admin sees total approved channels by everyone
            approved = await db.collection('user_channel_actions').countDocuments({ action: 'approved' });
        } else {
            // Regular users see their own approved count
            approved = await db.collection('user_channel_actions').countDocuments({ 
                user_id: userId, 
                action: 'approved' 
            });
        }

        // Rejected count (global for now, can be made user-specific if needed)
        const rejected = await db.collection('channels').countDocuments({ status: 'rejected' });

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

// Kevis's Picks endpoint (requires subscription)
app.get('/api/kevis-picks', authenticateToken, requireSubscription, async (req, res) => {
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
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        version: '2.0.1',
        features: {
            inviteCodes: true,
            studentAccount: true,
            pagination: true,
            videoSearch: true
        }
    });
});

// INVITE CODE MANAGEMENT (Admin only)

// Generate new invite code
app.post('/api/admin/invite-codes', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.userId) });
        if (!user || user.email !== process.env.ADMIN_EMAIL?.toLowerCase()) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { 
            description, 
            max_uses = null, 
            expires_in_days = null,
            code_prefix = 'VH'
        } = req.body;

        // Generate unique invite code
        const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase();
        const inviteCode = `${code_prefix}-${randomPart}`;

        // Calculate expiration date if specified
        let expires_at = null;
        if (expires_in_days) {
            expires_at = new Date();
            expires_at.setDate(expires_at.getDate() + expires_in_days);
        }

        const inviteCodeDoc = {
            code: inviteCode,
            description: description || 'Community invite',
            created_by: req.user.userId,
            created_at: new Date(),
            expires_at: expires_at,
            max_uses: max_uses,
            used_count: 0,
            used_by: [],
            active: true
        };

        await db.collection('invite_codes').insertOne(inviteCodeDoc);

        res.json({
            success: true,
            invite_code: inviteCode,
            details: {
                description: inviteCodeDoc.description,
                max_uses: max_uses,
                expires_at: expires_at
            }
        });

    } catch (error) {
        console.error('Error creating invite code:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// List all invite codes (Admin only)
app.get('/api/admin/invite-codes', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.userId) });
        if (!user || user.email !== process.env.ADMIN_EMAIL?.toLowerCase()) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const inviteCodes = await db.collection('invite_codes')
            .find({})
            .sort({ created_at: -1 })
            .toArray();

        res.json({ invite_codes: inviteCodes });

    } catch (error) {
        console.error('Error fetching invite codes:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Deactivate invite code (Admin only)
app.patch('/api/admin/invite-codes/:code/deactivate', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.userId) });
        if (!user || user.email !== process.env.ADMIN_EMAIL?.toLowerCase()) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { code } = req.params;

        const result = await db.collection('invite_codes').updateOne(
            { code: code },
            { 
                $set: { 
                    active: false,
                    deactivated_at: new Date(),
                    deactivated_by: req.user.userId
                }
            }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Invite code not found' });
        }

        res.json({ success: true, message: 'Invite code deactivated' });

    } catch (error) {
        console.error('Error deactivating invite code:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Test endpoint to verify routing
app.get('/api/auth/test-invite', (req, res) => {
    res.json({ message: 'Invite endpoints are working!', timestamp: new Date() });
});

// Validate invite code (public endpoint for registration form)
app.post('/api/auth/validate-invite', async (req, res) => {
    try {
        const { invite_code } = req.body;

        if (!invite_code) {
            return res.status(400).json({ error: 'Invite code is required' });
        }

        const inviteCodeDoc = await db.collection('invite_codes').findOne({ 
            code: invite_code,
            active: true,
            $or: [
                { expires_at: { $exists: false } },
                { expires_at: null },
                { expires_at: { $gt: new Date() } }
            ]
        });

        if (!inviteCodeDoc) {
            return res.status(404).json({ 
                error: 'Invalid or expired invite code',
                valid: false 
            });
        }

        // Check usage limit
        if (inviteCodeDoc.max_uses && inviteCodeDoc.used_count >= inviteCodeDoc.max_uses) {
            return res.status(403).json({ 
                error: 'This invite code has reached its usage limit',
                valid: false 
            });
        }

        res.json({ 
            valid: true,
            description: inviteCodeDoc.description,
            remaining_uses: inviteCodeDoc.max_uses ? (inviteCodeDoc.max_uses - inviteCodeDoc.used_count) : null
        });

    } catch (error) {
        console.error('Error validating invite code:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Create student account (Admin only)
app.post('/api/admin/create-student-account', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.userId) });
        if (!user || user.email !== process.env.ADMIN_EMAIL?.toLowerCase()) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const STUDENT_EMAIL = 'students@viewhunt.com';
        const STUDENT_PASSWORD = 'ViewHunt2025!Students';
        const STUDENT_DISPLAY_NAME = 'ViewHunt_Students';

        // Check if student account already exists
        const existingStudent = await db.collection('users').findOne({ 
            email: STUDENT_EMAIL 
        });

        if (existingStudent) {
            // Check if password needs updating
            const isValidPassword = await bcrypt.compare(STUDENT_PASSWORD, existingStudent.password);
            
            if (!isValidPassword) {
                // Update password
                const hashedPassword = await bcrypt.hash(STUDENT_PASSWORD, 12);
                await db.collection('users').updateOne(
                    { _id: existingStudent._id },
                    { $set: { password: hashedPassword, updated_at: new Date() } }
                );
                
                return res.json({
                    success: true,
                    message: 'Student account already exists - password updated',
                    email: STUDENT_EMAIL,
                    userId: existingStudent._id
                });
            }
            
            return res.json({
                success: true,
                message: 'Student account already exists',
                email: STUDENT_EMAIL,
                userId: existingStudent._id
            });
        }

        // Create new student account
        const hashedPassword = await bcrypt.hash(STUDENT_PASSWORD, 12);
        
        const studentAccount = {
            email: STUDENT_EMAIL,
            password: hashedPassword,
            display_name: STUDENT_DISPLAY_NAME,
            created_at: new Date(),
            updated_at: new Date(),
            is_student_account: true,
            stats: {
                channels_approved: 0,
                channels_rejected: 0,
                total_reviews: 0
            }
        };

        const result = await db.collection('users').insertOne(studentAccount);

        res.json({
            success: true,
            message: 'Student account created successfully',
            email: STUDENT_EMAIL,
            password: STUDENT_PASSWORD,
            userId: result.insertedId
        });

    } catch (error) {
        console.error('Error creating student account:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Subscription Routes

// Create checkout session for Pro subscription
app.post('/api/subscription/create-checkout-session', authenticateToken, async (req, res) => {
    try {
        // Check if Stripe is configured
        if (!stripe) {
            return res.status(500).json({ 
                success: false, 
                error: 'Payment system not configured' 
            });
        }

        // Get full user data from database
        const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.userId) });
        
        if (!user) {
            return res.status(404).json({ 
                success: false, 
                error: 'User not found' 
            });
        }
        
        // Get or create Stripe customer
        let customerId = user.subscription?.stripeCustomerId;
        
        if (!customerId) {
            const customer = await stripe.customers.create({
                email: user.email,
                name: user.display_name,
                metadata: {
                    userId: user._id.toString()
                }
            });
            
            customerId = customer.id;
            
            // Save customer ID to user
            await db.collection('users').updateOne(
                { _id: user._id },
                { 
                    $set: { 
                        'subscription.stripeCustomerId': customerId 
                    } 
                }
            );
        }
        
        // Create checkout session
        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            line_items: [
                {
                    price: process.env.STRIPE_PRICE_PRO,
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: `${process.env.APP_URL}/subscription-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.APP_URL}/pricing`,
            metadata: {
                userId: user._id.toString(),
                plan: 'pro'
            },
            allow_promotion_codes: true,
            billing_address_collection: "auto"
        });
        
        res.json({ 
            success: true, 
            sessionId: session.id,
            url: session.url 
        });
        
    } catch (error) {
        console.error('Error creating checkout session:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to create checkout session' 
        });
    }
});

// Cancel subscription
app.post('/api/subscription/cancel', authenticateToken, async (req, res) => {
    try {
        // Check if Stripe is configured
        if (!stripe) {
            return res.status(500).json({ error: 'Payment system not configured' });
        }

        const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.userId) });
        
        if (!user || !user.subscription || !user.subscription.stripeSubscriptionId) {
            return res.status(400).json({ error: 'No active subscription found' });
        }

        // Cancel subscription at period end
        const subscription = await stripe.subscriptions.update(
            user.subscription.stripeSubscriptionId,
            { cancel_at_period_end: true }
        );

        // Update user record
        await db.collection('users').updateOne(
            { _id: new ObjectId(req.user.userId) },
            {
                $set: {
                    'subscription.cancel_at_period_end': true,
                    'subscription.canceled_at': new Date(),
                    updated_at: new Date()
                }
            }
        );

        res.json({
            message: 'Subscription will be canceled at the end of the current billing period',
            cancelAt: subscription.current_period_end
        });

    } catch (error) {
        console.error('Cancel subscription error:', error);
        res.status(500).json({ error: 'Failed to cancel subscription' });
    }
});

// Reactivate subscription
app.post('/api/subscription/reactivate', authenticateToken, async (req, res) => {
    try {
        // Check if Stripe is configured
        if (!stripe) {
            return res.status(500).json({ error: 'Payment system not configured' });
        }

        const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.userId) });
        
        if (!user || !user.subscription || !user.subscription.stripeSubscriptionId) {
            return res.status(400).json({ error: 'No subscription found' });
        }

        // Reactivate subscription
        const subscription = await stripe.subscriptions.update(
            user.subscription.stripeSubscriptionId,
            { cancel_at_period_end: false }
        );

        // Update user record
        await db.collection('users').updateOne(
            { _id: new ObjectId(req.user.userId) },
            {
                $set: {
                    'subscription.cancel_at_period_end': false,
                    updated_at: new Date()
                },
                $unset: {
                    'subscription.canceled_at': ''
                }
            }
        );

        res.json({
            message: 'Subscription reactivated successfully'
        });

    } catch (error) {
        console.error('Reactivate subscription error:', error);
        res.status(500).json({ error: 'Failed to reactivate subscription' });
    }
});

// Create checkout session for Studio plans (Starter/Creator/Studio)
app.post('/api/subscription/create-plan-checkout', authenticateToken, async (req, res) => {
    try {
        if (!stripe) return res.status(500).json({ error: 'Payment system not configured' });

        const { plan } = req.body;
        const validPlans = {
            starter: process.env.STRIPE_PRICE_STARTER,
            creator: process.env.STRIPE_PRICE_CREATOR,
            studio: process.env.STRIPE_PRICE_STUDIO
        };

        if (!plan || !validPlans[plan]) {
            return res.status(400).json({ error: 'Invalid plan. Choose starter, creator, or studio.' });
        }

        var priceId = validPlans[plan];
        if (!priceId) return res.status(500).json({ error: 'Plan pricing not configured in Stripe' });

        const user = await db.collection('users').findOne({ _id: new ObjectId(req.user.userId) });
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Get or create Stripe customer
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
            mode: 'subscription',
            success_url: (process.env.APP_URL || 'https://viewhunt.com') + '/subscription-success?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: (process.env.APP_URL || 'https://viewhunt.com') + '/pricing',
            metadata: { userId: user._id.toString(), plan: plan },
            allow_promotion_codes: true,
            billing_address_collection: 'auto'
        });

        // Update user's plan in DB
        await db.collection('users').updateOne(
            { _id: user._id },
            { $set: { 'subscription.plan': plan, updated_at: new Date() } }
        );

        res.json({ success: true, url: session.url, sessionId: session.id });
    } catch (error) {
        console.error('Plan checkout error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// Fix subscription for paid user (admin only)
app.post('/api/subscription/fix-user', authenticateToken, async (req, res) => {
    try {
        const { userEmail } = req.body;
        
        // Check if user is admin
        if (req.user.email !== process.env.ADMIN_EMAIL) {
            return res.status(403).json({ error: 'Admin access required' });
        }
        
        if (!userEmail) {
            return res.status(400).json({ error: 'User email required' });
        }
        
        // Find user
        const user = await db.collection('users').findOne({ email: userEmail });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Get their Stripe customer
        const customers = await stripe.customers.list({ email: userEmail, limit: 1 });
        
        if (customers.data.length === 0) {
            return res.status(404).json({ error: 'No Stripe customer found' });
        }
        
        const customer = customers.data[0];
        
        // Get their active subscriptions
        const subscriptions = await stripe.subscriptions.list({ 
            customer: customer.id, 
            status: 'active',
            limit: 1 
        });
        
        if (subscriptions.data.length === 0) {
            return res.status(404).json({ error: 'No active subscription found' });
        }
        
        const subscription = subscriptions.data[0];
        
        // Update user in database
        await db.collection('users').updateOne(
            { _id: user._id },
            {
                $set: {
                    'subscription.status': 'active',
                    'subscription.plan': 'pro',
                    'subscription.stripeSubscriptionId': subscription.id,
                    'subscription.stripeCustomerId': customer.id,
                    'subscription.startDate': new Date(subscription.current_period_start * 1000),
                    'subscription.endDate': new Date(subscription.current_period_end * 1000),
                    updated_at: new Date()
                }
            }
        );
        
        res.json({ 
            success: true, 
            message: 'User subscription fixed',
            user: userEmail,
            subscription: subscription.id
        });
        
    } catch (error) {
        console.error('Error fixing user subscription:', error);
        res.status(500).json({ error: 'Failed to fix subscription' });
    }
});

// Handle subscription success
app.get('/api/subscription/success', authenticateToken, async (req, res) => {
    try {
        const { session_id } = req.query;
        
        if (!session_id) {
            return res.redirect('/pricing?error=invalid_session');
        }
        
        // Retrieve the session from Stripe
        const session = await stripe.checkout.sessions.retrieve(session_id);
        
        if (session.payment_status === 'paid') {
            // Update user subscription status
            const subscription = await stripe.subscriptions.retrieve(session.subscription);
            
            await db.collection('users').updateOne(
                { _id: req.user._id },
                {
                    $set: {
                        'subscription.status': 'active',
                        'subscription.plan': 'pro',
                        'subscription.stripeSubscriptionId': subscription.id,
                        'subscription.startDate': new Date(subscription.current_period_start * 1000),
                        'subscription.endDate': new Date(subscription.current_period_end * 1000)
                    }
                }
            );
            
            res.redirect('/app?success=subscription_activated');
        } else {
            res.redirect('/pricing?error=payment_failed');
        }
        
    } catch (error) {
        console.error('Error handling subscription success:', error);
        res.redirect('/pricing?error=processing_failed');
    }
});

// Stripe webhook handler
app.post('/api/subscription/webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    const studioCredits = require('./studio/credits');
    
    // Handle the event
    switch (event.type) {
        case 'checkout.session.completed': {
            const session = event.data.object;
            const meta = session.metadata || {};
            
            // Handle credit top-up purchase
            if (meta.type === 'credit_topup' && meta.userId) {
                const topUpAmount = parseInt(meta.credits) || 100;
                await studioCredits.addTopUpCredits(meta.userId, topUpAmount, session.id);
                console.log('💳 Webhook: top-up ' + topUpAmount + ' credits for user ' + meta.userId);
            }
            
            // Handle new subscription — grant monthly credits
            if (meta.plan && meta.userId && session.mode === 'subscription') {
                await studioCredits.grantMonthlyCredits(meta.userId, meta.plan);
                console.log('💳 Webhook: granted monthly credits for ' + meta.plan + ' plan to user ' + meta.userId);
            }
            break;
        }
        
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
            const subscription = event.data.object;
            
            // Update user subscription status
            await db.collection('users').updateOne(
                { 'subscription.stripeSubscriptionId': subscription.id },
                {
                    $set: {
                        'subscription.status': subscription.status,
                        'subscription.endDate': new Date(subscription.current_period_end * 1000)
                    }
                }
            );
            break;
        }
        
        case 'invoice.paid': {
            // Renewal payment succeeded — grant monthly credits
            const invoice = event.data.object;
            if (invoice.billing_reason === 'subscription_cycle') {
                const user = await db.collection('users').findOne({
                    'subscription.stripeCustomerId': invoice.customer
                });
                if (user && user.subscription?.plan) {
                    var plan = user.subscription.plan;
                    // Map old 'pro' plan to 'starter' for credit purposes
                    if (plan === 'pro') plan = 'starter';
                    await studioCredits.grantMonthlyCredits(String(user._id), plan);
                    console.log('💳 Webhook: renewal credits for ' + plan + ' → user ' + user._id);
                }
            }
            break;
        }
            
        case 'invoice.payment_failed': {
            const invoice = event.data.object;
            
            // Update user subscription status to past_due
            await db.collection('users').updateOne(
                { 'subscription.stripeCustomerId': invoice.customer },
                {
                    $set: {
                        'subscription.status': 'past_due'
                    }
                }
            );
            break;
        }
            
        default:
            console.log(`Unhandled event type ${event.type}`);
    }
    
    res.json({ received: true });
});

// Start server
app.listen(PORT, async () => {
    console.log(`ViewHunt server running on port ${PORT}`);
    console.log(`Database: MongoDB Atlas - viewhuntv2`);
    
    // Initialize background task manager
    try {
        const taskManager = require('./studio/task-manager');
        await taskManager.ensureIndexes();
        await taskManager.recoverStaleTasks();
        // Clean up old completed tasks every 5 days
        setInterval(() => taskManager.cleanupOldTasks(5).catch(() => {}), 24 * 60 * 60 * 1000);
        console.log('📋 Background task manager initialized');
    } catch (e) {
        console.warn('Task manager init warning:', e.message);
    }
    
    // Clean up orphaned temp files every 30 minutes
    setInterval(() => {
        const tempDir = path.join(__dirname, 'public/studio/generated/temp');
        try {
            if (!fs.existsSync(tempDir)) return;
            const now = Date.now();
            const maxAge = 60 * 60 * 1000; // 1 hour
            const entries = fs.readdirSync(tempDir);
            let cleaned = 0;
            for (const entry of entries) {
                const entryPath = path.join(tempDir, entry);
                try {
                    const stat = fs.statSync(entryPath);
                    if (now - stat.mtimeMs > maxAge) {
                        if (stat.isDirectory()) {
                            fs.rmSync(entryPath, { recursive: true, force: true });
                        } else {
                            fs.unlinkSync(entryPath);
                        }
                        cleaned++;
                    }
                } catch (e) { /* skip */ }
            }
            if (cleaned > 0) console.log('🧹 Cleaned ' + cleaned + ' old temp files/dirs');
        } catch (e) { /* ignore */ }
    }, 30 * 60 * 1000);
    
    // Clean up old final assembled videos every 6 hours (delete files older than 5 days)
    setInterval(() => {
        const finalDir = path.join(__dirname, 'public/studio/generated/final');
        try {
            if (!fs.existsSync(finalDir)) return;
            const now = Date.now();
            const maxAge = 5 * 24 * 60 * 60 * 1000; // 5 days
            const entries = fs.readdirSync(finalDir);
            let cleaned = 0;
            for (const entry of entries) {
                const filePath = path.join(finalDir, entry);
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.isFile() && now - stat.mtimeMs > maxAge) {
                        fs.unlinkSync(filePath);
                        cleaned++;
                    }
                } catch (e) { /* skip */ }
            }
            if (cleaned > 0) console.log('🧹 Cleaned ' + cleaned + ' old final video(s) (>5 days)');
        } catch (e) { /* ignore */ }
    }, 6 * 60 * 60 * 1000);
    
    // Also run final video cleanup once on startup
    try {
        const finalDir = path.join(__dirname, 'public/studio/generated/final');
        if (fs.existsSync(finalDir)) {
            const now = Date.now();
            const maxAge = 5 * 24 * 60 * 60 * 1000;
            const entries = fs.readdirSync(finalDir);
            let cleaned = 0;
            for (const entry of entries) {
                const filePath = path.join(finalDir, entry);
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.isFile() && now - stat.mtimeMs > maxAge) {
                        fs.unlinkSync(filePath);
                        cleaned++;
                    }
                } catch (e) { /* skip */ }
            }
            if (cleaned > 0) console.log('🧹 Startup cleanup: removed ' + cleaned + ' old final video(s)');
        }
    } catch (e) { /* ignore */ }
    
    // Memory monitoring — log every 5 minutes, warn if high
    setInterval(() => {
        const mem = process.memoryUsage();
        const rss = (mem.rss / 1024 / 1024).toFixed(1);
        const heap = (mem.heapUsed / 1024 / 1024).toFixed(1);
        if (mem.rss > 200 * 1024 * 1024) {
            console.warn('⚠️  HIGH MEMORY: RSS=' + rss + 'MB, Heap=' + heap + 'MB');
        } else {
            console.log('📊 Memory: RSS=' + rss + 'MB, Heap=' + heap + 'MB');
        }
    }, 5 * 60 * 1000);
});

// Graceful shutdown — close DB pool
const { closePool } = require('./studio/db');
process.on('SIGINT', async () => {
    console.log('\nShutting down server...');
    await closePool();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    console.log('\nSIGTERM received, shutting down...');
    await closePool();
    process.exit(0);
});