/**
 * Admin analytics — funnel KPIs for ads/product decisions.
 * Sources: Mongo analytics_events + users (attribution, trials, cooks).
 * No revenue soup. Cached 5 minutes.
 */
const trialHelper = require('../studio/trial');

const CACHE_TTL_MS = 5 * 60 * 1000;
const memoryCache = new Map();
const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

function getPartnerStartDate() {
    const raw = (process.env.ANALYTICS_PARTNER_START_DATE || '2026-07-26').trim();
    const d = new Date(raw + (raw.length === 10 ? 'T00:00:00.000Z' : ''));
    if (isNaN(d.getTime())) {
        return new Date('2026-07-26T00:00:00.000Z');
    }
    return d;
}

function parseRange(range) {
    const days = RANGE_DAYS[range] || RANGE_DAYS['30d'];
    const end = new Date();
    let start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    const partnerStart = getPartnerStartDate();
    if (start < partnerStart) start = new Date(partnerStart.getTime());
    if (start > end) start = new Date(end.getTime());
    return {
        range: RANGE_DAYS[range] ? range : '30d',
        days: days,
        start: start,
        end: end,
        partnerStart: partnerStart,
        clampedToPartnerStart: start.getTime() === partnerStart.getTime()
    };
}

async function countEvents(db, event, rangeInfo) {
    return db.collection('analytics_events').countDocuments({
        event: event,
        createdAt: { $gte: rangeInfo.start, $lte: rangeInfo.end }
    });
}

async function uniqueEventUsers(db, event, rangeInfo) {
    const rows = await db.collection('analytics_events').aggregate([
        {
            $match: {
                event: event,
                createdAt: { $gte: rangeInfo.start, $lte: rangeInfo.end },
                userId: { $ne: null }
            }
        },
        { $group: { _id: '$userId' } },
        { $count: 'n' }
    ]).toArray();
    return (rows[0] && rows[0].n) || 0;
}

async function uniqueVisitors(db, rangeInfo) {
    const rows = await db.collection('analytics_events').aggregate([
        {
            $match: {
                event: 'landing_viewed',
                createdAt: { $gte: rangeInfo.start, $lte: rangeInfo.end }
            }
        },
        {
            $group: {
                _id: {
                    $ifNull: ['$distinctId', '$userId']
                }
            }
        },
        { $count: 'n' }
    ]).toArray();
    return (rows[0] && rows[0].n) || 0;
}

async function fetchFunnelMetrics(db, rangeInfo) {
    if (!db) {
        return { configured: false, error: 'Database unavailable' };
    }

    const [
        landingViews,
        visitsUnique,
        signups,
        checkoutStarted,
        trialsStarted,
        assembleStarted,
        assembleSucceededUsers,
        paidConversions,
        cancels
    ] = await Promise.all([
        countEvents(db, 'landing_viewed', rangeInfo),
        uniqueVisitors(db, rangeInfo),
        countEvents(db, 'signup_completed', rangeInfo),
        countEvents(db, 'checkout_started', rangeInfo),
        countEvents(db, 'trial_started', rangeInfo),
        countEvents(db, 'ranking_assemble_started', rangeInfo),
        uniqueEventUsers(db, 'ranking_assemble_succeeded', rangeInfo),
        countEvents(db, 'subscription_activated', rangeInfo),
        countEvents(db, 'subscription_canceled', rangeInfo)
    ]);

    // Snapshot: currently active trials / cooks
    const cursor = db.collection('users').find(
        {
            $or: [
                { trial: { $exists: true } },
                { 'subscription.status': 'trialing' },
                { attribution: { $exists: true } }
            ]
        },
        {
            projection: {
                trial: 1,
                subscription: 1,
                attribution: 1,
                created_at: 1
            }
        }
    ).limit(50000);

    let appTrialActiveNow = 0;
    let stripeCardTrialNow = 0;
    let cooks2PlusNow = 0;
    let signupsFromUsersInRange = 0;
    const bySource = {};

    const rangeStartMs = rangeInfo.start.getTime();
    const rangeEndMs = rangeInfo.end.getTime();

    while (await cursor.hasNext()) {
        const user = await cursor.next();
        const createdMs = user.created_at ? new Date(user.created_at).getTime() : 0;
        if (createdMs >= rangeStartMs && createdMs <= rangeEndMs) {
            signupsFromUsersInRange += 1;
        }

        const isStripeTrialing = user.subscription && user.subscription.status === 'trialing';
        if (isStripeTrialing) stripeCardTrialNow += 1;

        const status = trialHelper.getTrialStatus(user);
        if (status && status.active) appTrialActiveNow += 1;

        const used = (user.trial && user.trial.rankingVideosUsed) || 0;
        if (used >= 2) cooks2PlusNow += 1;

        const src = (user.attribution &&
            ((user.attribution.firstTouch && user.attribution.firstTouch.utm_source) ||
                (user.attribution.lastTouch && user.attribution.lastTouch.utm_source))) || 'direct/unknown';
        if (createdMs >= rangeStartMs && createdMs <= rangeEndMs) {
            if (!bySource[src]) {
                bySource[src] = { source: src, signups: 0, trials: 0, paid: 0 };
            }
            bySource[src].signups += 1;
        }
    }

    // Attribution breakdown for trial/paid events in range
    const attrAgg = await db.collection('analytics_events').aggregate([
        {
            $match: {
                event: { $in: ['trial_started', 'subscription_activated'] },
                createdAt: { $gte: rangeInfo.start, $lte: rangeInfo.end }
            }
        },
        {
            $group: {
                _id: {
                    source: { $ifNull: ['$attribution.utm_source', '$properties.utm_source'] },
                    event: '$event'
                },
                n: { $sum: 1 }
            }
        }
    ]).toArray();

    attrAgg.forEach(function(row) {
        const src = (row._id && row._id.source) || 'direct/unknown';
        if (!bySource[src]) bySource[src] = { source: src, signups: 0, trials: 0, paid: 0 };
        if (row._id.event === 'trial_started') bySource[src].trials += row.n;
        if (row._id.event === 'subscription_activated') bySource[src].paid += row.n;
    });

    const signupCount = Math.max(signups, signupsFromUsersInRange);

    function rate(num, den) {
        if (!den) return null;
        // Cap at 100% — visit beacons can undercount vs signups (ad blockers, /app deep links)
        var pct = Math.round((num / den) * 1000) / 10;
        return Math.min(100, pct);
    }

    const bySourceList = Object.keys(bySource)
        .map(function(k) { return bySource[k]; })
        .sort(function(a, b) {
            return (b.signups + b.trials + b.paid) - (a.signups + a.trials + a.paid);
        })
        .slice(0, 20);

    return {
        configured: true,
        error: null,
        landingViews: landingViews,
        visitsUnique: visitsUnique,
        signups: signupCount,
        checkoutStarted: checkoutStarted,
        trialsStarted: trialsStarted,
        assembleStarted: assembleStarted,
        firstCookUsers: assembleSucceededUsers,
        cooks2PlusNow: cooks2PlusNow,
        paidConversions: paidConversions,
        cancels: cancels,
        appTrialActiveNow: appTrialActiveNow,
        stripeCardTrialNow: stripeCardTrialNow,
        rates: {
            visitToSignup: rate(signupCount, visitsUnique || landingViews),
            signupToTrial: rate(trialsStarted, signupCount),
            trialToFirstCook: rate(assembleSucceededUsers, trialsStarted),
            trialToPaid: rate(paidConversions, trialsStarted),
            firstCookToPaid: rate(paidConversions, assembleSucceededUsers)
        },
        bySource: bySourceList,
        definitions: {
            visitsUnique: 'Unique distinct_ids that fired landing_viewed in range (PostHog/Mongo)',
            trialsStarted: 'Stripe card trial started (primary ad conversion)',
            paidConversions: 'First paid / subscription activated (secondary ad conversion)',
            firstCookUsers: 'Unique users with a successful ranking assemble in range'
        }
    };
}

async function readCache(db, key) {
    const mem = memoryCache.get(key);
    if (mem && mem.expiresAt > Date.now()) return mem.payload;
    if (db) {
        try {
            const doc = await db.collection('admin_analytics_cache').findOne({ _id: key });
            if (doc && doc.expiresAt && new Date(doc.expiresAt).getTime() > Date.now()) {
                memoryCache.set(key, { expiresAt: new Date(doc.expiresAt).getTime(), payload: doc.payload });
                return doc.payload;
            }
        } catch (e) {
            console.warn('admin analytics cache read:', e.message);
        }
    }
    return null;
}

async function writeCache(db, key, payload) {
    const expiresAt = new Date(Date.now() + CACHE_TTL_MS);
    memoryCache.set(key, { expiresAt: expiresAt.getTime(), payload: payload });
    if (db) {
        try {
            await db.collection('admin_analytics_cache').updateOne(
                { _id: key },
                { $set: { payload: payload, expiresAt: expiresAt, updatedAt: new Date() } },
                { upsert: true }
            );
        } catch (e) {
            console.warn('admin analytics cache write:', e.message);
        }
    }
}

async function getAdminAnalytics(opts) {
    const rangeInfo = parseRange(opts.range);
    const cacheKey = 'analytics:v3:funnel:' + rangeInfo.range + ':' +
        rangeInfo.partnerStart.toISOString().slice(0, 10);

    if (!opts.refresh) {
        const cached = await readCache(opts.db, cacheKey);
        if (cached) return Object.assign({}, cached, { cached: true });
    }

    const funnel = await fetchFunnelMetrics(opts.db, rangeInfo).catch(function(err) {
        console.error('Funnel analytics error:', err);
        return { configured: true, error: err.message || String(err) };
    });

    const payload = {
        asOf: new Date().toISOString(),
        range: rangeInfo.range,
        rangeStart: rangeInfo.start.toISOString(),
        rangeEnd: rangeInfo.end.toISOString(),
        partnerStart: rangeInfo.partnerStart.toISOString(),
        clampedToPartnerStart: rangeInfo.clampedToPartnerStart,
        cached: false,
        cacheTtlSeconds: Math.floor(CACHE_TTL_MS / 1000),
        focus: 'funnel_kpis',
        funnel: funnel,
        telemetry: {
            posthogConfigured: !!process.env.POSTHOG_KEY,
            metaConfigured: !!(process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN),
            googleConfigured: !!(process.env.GOOGLE_ADS_ID && process.env.GOOGLE_ADS_LABEL_TRIAL)
        }
    };

    await writeCache(opts.db, cacheKey, payload);
    return payload;
}

module.exports = {
    getAdminAnalytics,
    parseRange,
    getPartnerStartDate,
    CACHE_TTL_MS
};
