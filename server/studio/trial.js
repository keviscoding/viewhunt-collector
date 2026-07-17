/**
 * Free trial: 3 days OR 3 completed ranking videos, whichever comes first.
 * Other Studio formats continue to use the credit wallet.
 */
const { ObjectId } = require('mongodb');

const TRIAL_DAYS = 3;
const TRIAL_RANKING_LIMIT = 3;

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

/**
 * Normalize trial state for a user document.
 * Returns null if the user has no trial object.
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
    const user = await db.collection('users').findOne({ _id: id }, { projection: { trial: 1 } });
    if (!user || !user.trial || user.trial.status === 'converted') {
        return getTrialStatus(user);
    }

    const used = (user.trial.rankingVideosUsed || 0) + 1;
    const limit = user.trial.rankingVideosLimit || TRIAL_RANKING_LIMIT;
    const update = {
        'trial.rankingVideosUsed': used,
        updated_at: new Date()
    };

    if (used >= limit && user.trial.status === 'active') {
        update['trial.status'] = 'exhausted';
    }

    // Also expire by time if already past endsAt
    if (user.trial.endsAt && new Date() > new Date(user.trial.endsAt) && user.trial.status === 'active') {
        update['trial.status'] = 'exhausted';
    }

    await db.collection('users').updateOne({ _id: id }, { $set: update });
    const refreshed = await db.collection('users').findOne({ _id: id }, { projection: { trial: 1 } });
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
    createTrialFields,
    getTrialStatus,
    isTrialActive,
    canUseRankingTrial,
    convertTrial,
    recordRankingVideoComplete
};
