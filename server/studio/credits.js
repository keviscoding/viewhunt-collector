/**
 * Credits System — Manages studio credits for video generation.
 * 
 * Credit costs per action:
 *   - Script generation (Claude): 5 credits
 *   - Image generation (per scene): 0.5 credits
 *   - Video generation (per scene): 5 credits
 *   - Final assembly (TTS + Whisper + FFmpeg): 2 credits
 * 
 * Plans:
 *   - Starter ($29/mo): 300 credits/mo
 *   - Creator ($59/mo): 600 credits/mo
 *   - Studio ($119/mo): 1,200 credits/mo
 * 
 * Credits reset monthly on billing date. No rollover.
 * Top-up credits persist (never expire).
 * 
 * Uses shared connection pool (db.js) instead of per-call connections.
 * Deductions use findOneAndUpdate for atomic check-and-deduct.
 */
const { getDb } = require('./db');

const COLLECTION = 'studio_credits';
const TRANSACTIONS = 'credit_transactions';

// Credit costs per action
const COSTS = {
    script_generation: 5,
    image_generation: 0.5,   // per scene (was 2, reduced — nano-banana is cheap)
    video_generation: 5,   // per scene
    assembly: 2            // was 5, reduced
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
 */
async function getBalance(userId) {
    var db = await getDb();
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
 * Deduct credits for an action — ATOMIC.
 * Uses findOneAndUpdate with a $where-style filter to prevent overdraw.
 * Deducts from monthly balance first, then top-up balance.
 */
async function deductCredits(userId, action, quantity, description) {
    quantity = quantity || 1;
    var cost = (COSTS[action] || 0) * quantity;
    if (cost === 0) return { success: true, newBalance: 0, cost: 0 };

    var db = await getDb();

    // Read current balances to calculate split
    var doc = await db.collection(COLLECTION).findOne({ userId: String(userId) });
    if (!doc) throw new Error('No credit account found');

    var monthly = doc.balance || 0;
    var topUp = doc.topUpBalance || 0;

    // Calculate how to split the deduction
    var fromMonthly = Math.min(monthly, cost);
    var fromTopUp = cost - fromMonthly;

    // Atomic update: only succeeds if balances haven't changed (prevents race condition)
    // The filter ensures the document still has enough credits at the moment of update
    var result = await db.collection(COLLECTION).findOneAndUpdate(
        {
            userId: String(userId),
            $expr: {
                $gte: [
                    { $add: [{ $ifNull: ['$balance', 0] }, { $ifNull: ['$topUpBalance', 0] }] },
                    cost
                ]
            }
        },
        {
            $inc: {
                balance: -fromMonthly,
                topUpBalance: -fromTopUp,
                totalUsed: cost
            }
        },
        { returnDocument: 'after' }
    );

    if (!result) {
        // Re-read to get actual balance for error message
        var fresh = await db.collection(COLLECTION).findOne({ userId: String(userId) });
        var actual = (fresh ? (fresh.balance || 0) + (fresh.topUpBalance || 0) : 0);
        throw new Error('Insufficient credits: need ' + cost + ', have ' + actual);
    }

    var updated = result;

    // Log transaction (non-blocking, don't fail the deduction if logging fails)
    db.collection(TRANSACTIONS).insertOne({
        userId: String(userId),
        type: 'deduct',
        action: action,
        quantity: quantity,
        cost: cost,
        fromMonthly: fromMonthly,
        fromTopUp: fromTopUp,
        description: description || (action + ' x' + quantity),
        balanceAfter: updated.balance,
        topUpAfter: updated.topUpBalance,
        createdAt: new Date()
    }).catch(function(err) { console.error('Transaction log failed:', err.message); });

    var newTotal = (updated.balance || 0) + (updated.topUpBalance || 0);
    console.log('💳 Credits: -' + cost + ' (' + action + ' x' + quantity + ') → ' + newTotal + ' remaining');

    return {
        success: true,
        newBalance: updated.balance || 0,
        newTopUp: updated.topUpBalance || 0,
        totalRemaining: newTotal,
        cost: cost
    };
}

/**
 * Refund credits (e.g., if generation fails).
 * Refunds to monthly balance.
 */
async function refundCredits(userId, action, quantity, reason) {
    quantity = quantity || 1;
    var amount = (COSTS[action] || 0) * quantity;
    if (amount === 0) return;

    var db = await getDb();

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

    var db = await getDb();

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
}

/**
 * Add top-up credits (purchased separately).
 * These don't expire on monthly reset.
 */
async function addTopUpCredits(userId, amount, stripeSessionId) {
    var db = await getDb();

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
}

/**
 * Get credit transaction history for a user.
 */
async function getTransactions(userId, limit) {
    limit = limit || 50;
    var db = await getDb();
    return await db.collection(TRANSACTIONS)
        .find({ userId: String(userId) })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();
}

/**
 * Admin: manually set credits for a user.
 */
async function adminSetCredits(userId, balance, plan) {
    var db = await getDb();

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