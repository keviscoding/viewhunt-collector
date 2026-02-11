/**
 * Credits System — Manages studio credits for video generation.
 * 
 * Credit costs per action:
 *   - Script generation (Claude): 5 credits
 *   - Image generation (per scene): 3 credits
 *   - Video generation (per scene, Kling): 8 credits
 *   - Final assembly (TTS + Whisper + FFmpeg): 10 credits
 *   - Full video (~12 scenes): ~111 credits
 * 
 * Plans:
 *   - Starter ($29/mo): 200 credits/mo
 *   - Creator ($59/mo): 500 credits/mo
 *   - Studio ($119/mo): 1200 credits/mo
 * 
 * Credits reset monthly on billing date. No rollover.
 * Users can buy top-up packs at any time.
 */
const { MongoClient, ObjectId } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || process.env.V2_MONGO_URI || process.env.MONGO_URI;
const DB_NAME = 'viewhuntv2';
const COLLECTION = 'studio_credits';
const TRANSACTIONS = 'credit_transactions';

// Credit costs per action
const COSTS = {
    script_generation: 5,
    image_generation: 2,   // per scene
    video_generation: 5,   // per scene
    assembly: 5
};

// Plan credit allocations (monthly)
const PLAN_CREDITS = {
    starter: 300,
    creator: 600,
    studio: 1200
};

// Top-up packs { credits, stripeEnvVar }
const TOPUP_PACKS = {
    small:  { credits: 200,  envVar: 'STRIPE_PRICE_CREDITS_SM' },
    medium: { credits: 500,  envVar: 'STRIPE_PRICE_CREDITS_ME' },
    large:  { credits: 1200, envVar: 'STRIPE_PRICE_CREDITS_LA' }
};

/**
 * Get a user's current credit balance.
 * Creates a record if none exists.
 */
async function getBalance(userId) {
    var client = new MongoClient(MONGODB_URI);
    try {
        await client.connect();
        var db = client.db(DB_NAME);
        var doc = await db.collection(COLLECTION).findOne({ userId: String(userId) });

        if (!doc) {
            return { balance: 0, plan: null, resetDate: null };
        }

        return {
            balance: doc.balance || 0,
            plan: doc.plan || null,
            resetDate: doc.resetDate || null,
            totalUsed: doc.totalUsed || 0,
            topUpBalance: doc.topUpBalance || 0
        };
    } finally {
        await client.close();
    }
}

/**
 * Check if user has enough credits for an action.
 * Returns { allowed, balance, cost, shortfall }
 */
async function checkCredits(userId, action, quantity) {
    quantity = quantity || 1;
    var cost = (COSTS[action] || 0) * quantity;
    var bal = await getBalance(userId);
    var total = bal.balance + (bal.topUpBalance || 0);

    return {
        allowed: total >= cost,
        balance: bal.balance,
        topUpBalance: bal.topUpBalance || 0,
        totalAvailable: total,
        cost: cost,
        shortfall: Math.max(0, cost - total),
        plan: bal.plan
    };
}

/**
 * Deduct credits for an action.
 * Deducts from monthly balance first, then top-up balance.
 * Returns { success, newBalance, cost } or throws if insufficient.
 */
async function deductCredits(userId, action, quantity, description) {
    quantity = quantity || 1;
    var cost = (COSTS[action] || 0) * quantity;
    if (cost === 0) return { success: true, newBalance: 0, cost: 0 };

    var client = new MongoClient(MONGODB_URI);
    try {
        await client.connect();
        var db = client.db(DB_NAME);

        var doc = await db.collection(COLLECTION).findOne({ userId: String(userId) });
        if (!doc) throw new Error('No credit account found');

        var monthly = doc.balance || 0;
        var topUp = doc.topUpBalance || 0;
        var total = monthly + topUp;

        if (total < cost) {
            throw new Error('Insufficient credits: need ' + cost + ', have ' + total);
        }

        // Deduct from monthly first, then top-up
        var fromMonthly = Math.min(monthly, cost);
        var fromTopUp = cost - fromMonthly;

        var update = {
            $inc: {
                balance: -fromMonthly,
                topUpBalance: -fromTopUp,
                totalUsed: cost
            }
        };

        await db.collection(COLLECTION).updateOne(
            { userId: String(userId) },
            update
        );

        // Log transaction
        await db.collection(TRANSACTIONS).insertOne({
            userId: String(userId),
            type: 'deduct',
            action: action,
            quantity: quantity,
            cost: cost,
            fromMonthly: fromMonthly,
            fromTopUp: fromTopUp,
            description: description || (action + ' x' + quantity),
            balanceAfter: monthly - fromMonthly,
            topUpAfter: topUp - fromTopUp,
            createdAt: new Date()
        });

        var newTotal = (monthly - fromMonthly) + (topUp - fromTopUp);
        console.log('💳 Credits: -' + cost + ' (' + action + ' x' + quantity + ') → ' + newTotal + ' remaining');

        return {
            success: true,
            newBalance: monthly - fromMonthly,
            newTopUp: topUp - fromTopUp,
            totalRemaining: newTotal,
            cost: cost
        };
    } finally {
        await client.close();
    }
}

/**
 * Refund credits (e.g., if generation fails).
 * Refunds to monthly balance.
 */
async function refundCredits(userId, action, quantity, reason) {
    quantity = quantity || 1;
    var amount = (COSTS[action] || 0) * quantity;
    if (amount === 0) return;

    var client = new MongoClient(MONGODB_URI);
    try {
        await client.connect();
        var db = client.db(DB_NAME);

        await db.collection(COLLECTION).updateOne(
            { userId: String(userId) },
            {
                $inc: { balance: amount, totalUsed: -amount }
            }
        );

        await db.collection(TRANSACTIONS).insertOne({
            userId: String(userId),
            type: 'refund',
            action: action,
            quantity: quantity,
            amount: amount,
            reason: reason || 'Generation failed',
            createdAt: new Date()
        });

        console.log('💳 Credits: +' + amount + ' refund (' + reason + ')');
    } finally {
        await client.close();
    }
}

/**
 * Grant monthly credits when a subscription starts or renews.
 * Called from Stripe webhook.
 */
async function grantMonthlyCredits(userId, plan) {
    var amount = PLAN_CREDITS[plan];
    if (!amount) {
        console.warn('Unknown plan: ' + plan);
        return;
    }

    var client = new MongoClient(MONGODB_URI);
    try {
        await client.connect();
        var db = client.db(DB_NAME);

        var now = new Date();
        var resetDate = new Date(now);
        resetDate.setMonth(resetDate.getMonth() + 1);

        // Reset monthly balance (don't touch top-up balance)
        await db.collection(COLLECTION).updateOne(
            { userId: String(userId) },
            {
                $set: {
                    balance: amount,
                    plan: plan,
                    resetDate: resetDate,
                    lastGrantedAt: now
                },
                $setOnInsert: {
                    userId: String(userId),
                    topUpBalance: 0,
                    totalUsed: 0,
                    createdAt: now
                }
            },
            { upsert: true }
        );

        await db.collection(TRANSACTIONS).insertOne({
            userId: String(userId),
            type: 'grant',
            action: 'monthly_reset',
            amount: amount,
            plan: plan,
            description: plan + ' plan: ' + amount + ' credits',
            createdAt: now
        });

        console.log('💳 Credits: granted ' + amount + ' monthly credits (' + plan + ') to user ' + userId);
    } finally {
        await client.close();
    }
}

/**
 * Add top-up credits (purchased separately).
 * These don't expire on monthly reset.
 */
async function addTopUpCredits(userId, amount, stripeSessionId) {
    var client = new MongoClient(MONGODB_URI);
    try {
        await client.connect();
        var db = client.db(DB_NAME);

        await db.collection(COLLECTION).updateOne(
            { userId: String(userId) },
            {
                $inc: { topUpBalance: amount },
                $setOnInsert: {
                    userId: String(userId),
                    balance: 0,
                    plan: null,
                    totalUsed: 0,
                    createdAt: new Date()
                }
            },
            { upsert: true }
        );

        await db.collection(TRANSACTIONS).insertOne({
            userId: String(userId),
            type: 'topup',
            action: 'credit_purchase',
            amount: amount,
            stripeSessionId: stripeSessionId,
            description: 'Purchased ' + amount + ' credits',
            createdAt: new Date()
        });

        console.log('💳 Credits: +' + amount + ' top-up credits for user ' + userId);
    } finally {
        await client.close();
    }
}

/**
 * Get credit transaction history for a user.
 */
async function getTransactions(userId, limit) {
    limit = limit || 50;
    var client = new MongoClient(MONGODB_URI);
    try {
        await client.connect();
        var db = client.db(DB_NAME);
        return await db.collection(TRANSACTIONS)
            .find({ userId: String(userId) })
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();
    } finally {
        await client.close();
    }
}

/**
 * Admin: manually set credits for a user.
 */
async function adminSetCredits(userId, balance, plan) {
    var client = new MongoClient(MONGODB_URI);
    try {
        await client.connect();
        var db = client.db(DB_NAME);

        await db.collection(COLLECTION).updateOne(
            { userId: String(userId) },
            {
                $set: {
                    balance: balance,
                    plan: plan || 'admin',
                    lastGrantedAt: new Date()
                },
                $setOnInsert: {
                    userId: String(userId),
                    topUpBalance: 0,
                    totalUsed: 0,
                    createdAt: new Date()
                }
            },
            { upsert: true }
        );

        console.log('💳 Admin: set ' + balance + ' credits for user ' + userId);
    } finally {
        await client.close();
    }
}

module.exports = {
    COSTS,
    PLAN_CREDITS,
    TOPUP_PACKS,
    getBalance,
    checkCredits,
    deductCredits,
    refundCredits,
    grantMonthlyCredits,
    addTopUpCredits,
    getTransactions,
    adminSetCredits
};
