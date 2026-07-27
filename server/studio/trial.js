/**
 * Free trial: 7 days OR 3 completed ranking videos, whichever comes first.
 * Other Studio formats continue to use the credit wallet.
 * Paid plan checkouts (Starter/Creator/Studio) also use a 7-day Stripe trial.
 */
const { ObjectId } = require('mongodb');

const TRIAL_DAYS = 7;
const TRIAL_RANKING_LIMIT = 3;
const STRIPE_TRIAL_DAYS = 7;

function createTrialFields(now) {
    const startedAt = now || new Date();
    return {
        startedAt,
        endsAt: new Date(startedAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
        rankingVideosUsed: 0,
        rankingVideosLimit: TRIAL_RANKING_LIMIT,
        status: 'active'
    };
}

function hasRemainingRankingAllotment(trial, at) {
    if (!trial) return false;
    const videosUsed = trial.rankingVideosUsed || 0;
    const videosLimit = trial.rankingVideosLimit || TRIAL_RANKING_LIMIT;
    const endsAt = trial.endsAt ? new Date(trial.endsAt) : null;
    if (videosUsed >= videosLimit) return false;
    if (endsAt && at > endsAt) return false;
    return true;
}

/**
 * Normalize trial state for a user document.
 * Returns null if the user has no trial object.
 *
 * Note: Stripe card-collect used to set trial.status=converted immediately.
 * While Stripe is still trialing and the 3-video / 7-day allotment remains,
 * treat the app trial as active so they can cook.
 */
function getTrialStatus(user, now) {
    if (!user || !user.trial) return null;

    const trial = user.trial;
    const at = now || new Date();
    const endsAt = trial.endsAt ? new Date(trial.endsAt) : null;
    const videosUsed = trial.rankingVideosUsed || 0;
    const videosLimit = trial.rankingVideosLimit || TRIAL_RANKING_LIMIT;
    const rankingVideosLeft = Math.max(0, videosLimit - videosUsed);
    const daysLeft = endsAt
        ? Math.max(0, Math.ceil((endsAt.getTime() - at.getTime()) / (24 * 60 * 60 * 1000)))
        : 0;
    const subStatus = user.subscription && user.subscription.status;

    const base = {
        startedAt: trial.startedAt,
        endsAt: trial.endsAt,
        rankingVideosUsed: videosUsed,
        rankingVideosLimit: videosLimit,
        rankingVideosLeft,
        daysLeft,
        status: trial.status || 'active'
    };

    if (trial.status === 'converted') {
        // Legacy: converted on card collect. Keep free ranking cooks during Stripe trial.
        if (subStatus === 'trialing' && hasRemainingRankingAllotment(trial, at)) {
            return {
                ...base,
                active: true,
                status: 'active',
                reason: 'active',
                rankingVideosLeft,
                healedFromConverted: true
            };
        }
        return { ...base, active: false, reason: 'converted' };
    }

    if (trial.status === 'exhausted') {
        return { ...base, active: false, reason: 'exhausted' };
    }

    if (endsAt && at > endsAt) {
        return { ...base, active: false, daysLeft: 0, reason: 'expired' };
    }

    if (videosUsed >= videosLimit) {
        return { ...base, active: false, rankingVideosLeft: 0, reason: 'videos_exhausted' };
    }

    return { ...base, active: true, reason: 'active' };
}

/**
 * Persist reopen when card-collect wrongly marked trial converted during Stripe trial.
 */
async function reopenTrialIfNeeded(db, user) {
    if (!user || !user._id || !user.trial) return user;
    const status = getTrialStatus(user);
    if (!(status && status.healedFromConverted) || user.trial.status !== 'converted') {
        return user;
    }
    await db.collection('users').updateOne(
        { _id: user._id },
        { $set: { 'trial.status': 'active', updated_at: new Date() } }
    );
    user.trial.status = 'active';
    return user;
}

function isTrialActive(user, now) {
    const status = getTrialStatus(user, now);
    return !!(status && status.active);
}

async function convertTrial(db, userId) {
    const id = typeof userId === 'string' ? new ObjectId(userId) : userId;
    await db.collection('users').updateOne(
        { _id: id, 'trial.status': { $in: ['active', 'exhausted'] } },
        { $set: { 'trial.status': 'converted', updated_at: new Date() } }
    );
}

/**
 * Increment ranking video usage after a successful ranking assemble.
 * Marks trial exhausted when the video limit is hit.
 */
async function recordRankingVideoComplete(db, userId) {
    const id = typeof userId === 'string' ? new ObjectId(userId) : userId;
    const user = await db.collection('users').findOne(
        { _id: id },
        { projection: { trial: 1, subscription: 1 } }
    );
    if (!user || !user.trial) {
        return getTrialStatus(user);
    }

    // Skip only when truly converted (paid). During Stripe trial, still count free cooks.
    const live = getTrialStatus(user);
    if (user.trial.status === 'converted' && !(live && live.active)) {
        return live;
    }

    const used = (user.trial.rankingVideosUsed || 0) + 1;
    const limit = user.trial.rankingVideosLimit || TRIAL_RANKING_LIMIT;
    const update = {
        'trial.rankingVideosUsed': used,
        'trial.status': 'active',
        updated_at: new Date()
    };

    if (used >= limit) {
        update['trial.status'] = 'exhausted';
    }

    // Also expire by time if already past endsAt
    if (user.trial.endsAt && new Date() > new Date(user.trial.endsAt)) {
        update['trial.status'] = 'exhausted';
    }

    await db.collection('users').updateOne({ _id: id }, { $set: update });
    const refreshed = await db.collection('users').findOne(
        { _id: id },
        { projection: { trial: 1, subscription: 1 } }
    );
    return getTrialStatus(refreshed);
}

/**
 * Can this user start a ranking assemble under trial (no credit charge)?
 */
function canUseRankingTrial(user, now) {
    return isTrialActive(user, now);
}

module.exports = {
    TRIAL_DAYS,
    TRIAL_RANKING_LIMIT,
    STRIPE_TRIAL_DAYS,
    createTrialFields,
    getTrialStatus,
    isTrialActive,
    canUseRankingTrial,
    convertTrial,
    reopenTrialIfNeeded,
    recordRankingVideoComplete
};
