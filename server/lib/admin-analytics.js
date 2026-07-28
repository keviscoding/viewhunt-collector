/**
 * Admin analytics — site visits + trial context only.
 *
 * Sources:
 * - Cloudflare GraphQL Analytics (page views / requests for viewhunt.app)
 * - Mongo users (app free challenge + Stripe subscription.status=trialing)
 *
 * No revenue / invoice / MRR metrics. Cached 5 minutes.
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
    // Visits + trial "started in range" never include pre-partnership history
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

async function fetchCloudflareVisits(rangeInfo) {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const zoneId = process.env.CLOUDFLARE_ZONE_ID;
    if (!token || !zoneId) {
        return {
            source: 'Cloudflare',
            configured: false,
            error: 'Configure CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID on DigitalOcean',
            pageViews: null,
            requests: null,
            uniqueVisitorsSum: null,
            series: []
        };
    }

    function ymd(d) {
        return d.toISOString().slice(0, 10);
    }
    const startDate = ymd(rangeInfo.start);
    // Cloudflare date_lt is exclusive — include today
    const endDate = ymd(new Date(rangeInfo.end.getTime() + 24 * 60 * 60 * 1000));

    const query = `
      query ($zoneTag: string!, $start: Date!, $end: Date!) {
        viewer {
          zones(filter: { zoneTag: $zoneTag }) {
            httpRequests1dGroups(
              limit: 100
              filter: { date_geq: $start, date_lt: $end }
              orderBy: [date_ASC]
            ) {
              dimensions { date }
              sum { requests pageViews }
              uniq { uniques }
            }
          }
        }
      }
    `;

    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            query: query,
            variables: { zoneTag: zoneId, start: startDate, end: endDate }
        })
    });

    const body = await res.json().catch(function() { return {}; });
    if (!res.ok || (body.errors && body.errors.length)) {
        const msg = (body.errors && body.errors[0] && body.errors[0].message) ||
            ('Cloudflare HTTP ' + res.status);
        return {
            source: 'Cloudflare',
            configured: true,
            error: msg,
            pageViews: null,
            requests: null,
            uniqueVisitorsSum: null,
            series: []
        };
    }

    const groups = ((((body.data || {}).viewer || {}).zones || [])[0] || {}).httpRequests1dGroups || [];
    let pageViews = 0;
    let requests = 0;
    let uniqueVisitorsSum = 0;
    const series = groups.map(function(g) {
        const pv = (g.sum && g.sum.pageViews) || 0;
        const req = (g.sum && g.sum.requests) || 0;
        const u = (g.uniq && g.uniq.uniques) || 0;
        pageViews += pv;
        requests += req;
        uniqueVisitorsSum += u;
        return {
            date: g.dimensions && g.dimensions.date,
            pageViews: pv,
            requests: req,
            uniqueVisitors: u
        };
    });

    return {
        source: 'Cloudflare',
        configured: true,
        error: null,
        pageViews: pageViews,
        requests: requests,
        // Cloudflare only exposes daily uniques — summing days double-counts return visitors
        uniqueVisitorsSum: uniqueVisitorsSum,
        uniqueVisitorsNote: 'Sum of daily Cloudflare uniques (return visitors counted each day). Use page views for trend.',
        series: series,
        zoneId: zoneId
    };
}

/**
 * Trial context from ViewHunt users collection.
 * - App free challenge: trial.active (7 days OR 3 ranking videos)
 * - Stripe card trial: subscription.status === trialing
 */
async function fetchTrialMetrics(db, rangeInfo) {
    if (!db) {
        return {
            source: 'Mongo',
            configured: false,
            error: 'Database unavailable'
        };
    }

    const cursor = db.collection('users').find(
        {
            $or: [
                { trial: { $exists: true } },
                { 'subscription.status': 'trialing' }
            ]
        },
        {
            projection: {
                trial: 1,
                subscription: 1,
                email: 1,
                created_at: 1
            }
        }
    ).limit(50000);

    let appTrialActive = 0;
    let stripeTrialing = 0;
    let bothActive = 0;
    let appStartedInRange = 0;
    let stripeTrialStartedInRange = 0;
    let converted = 0;
    let exhausted = 0;
    let expired = 0;
    let rankingVideosLeftBuckets = { '3': 0, '2': 0, '1': 0, '0': 0 };
    let usersScanned = 0;

    const rangeStartMs = rangeInfo.start.getTime();
    const rangeEndMs = rangeInfo.end.getTime();

    while (await cursor.hasNext()) {
        const user = await cursor.next();
        usersScanned += 1;

        const subStatus = user.subscription && user.subscription.status;
        const isStripeTrialing = subStatus === 'trialing';
        if (isStripeTrialing) {
            stripeTrialing += 1;
            const trialEnd = user.subscription && user.subscription.trialEnd
                ? new Date(user.subscription.trialEnd).getTime()
                : null;
            const startDate = user.subscription && user.subscription.startDate
                ? new Date(user.subscription.startDate).getTime()
                : (user.trial && user.trial.startedAt ? new Date(user.trial.startedAt).getTime() : null);
            // Approximate "started Stripe trial in range" from subscription.startDate
            if (startDate != null && startDate >= rangeStartMs && startDate <= rangeEndMs) {
                stripeTrialStartedInRange += 1;
            }
            void trialEnd;
        }

        const status = trialHelper.getTrialStatus(user);
        if (status) {
            if (user.trial && user.trial.startedAt) {
                const startedMs = new Date(user.trial.startedAt).getTime();
                if (startedMs >= rangeStartMs && startedMs <= rangeEndMs) {
                    appStartedInRange += 1;
                }
            }

            if (status.active) {
                appTrialActive += 1;
                if (isStripeTrialing) bothActive += 1;
                const left = String(Math.min(3, Math.max(0, status.rankingVideosLeft || 0)));
                if (rankingVideosLeftBuckets[left] != null) rankingVideosLeftBuckets[left] += 1;
            } else if (status.reason === 'converted' || status.status === 'converted') {
                converted += 1;
            } else if (status.reason === 'videos_exhausted' || status.reason === 'exhausted') {
                exhausted += 1;
            } else if (status.reason === 'expired') {
                expired += 1;
            }
        }
    }

    return {
        source: 'Mongo',
        configured: true,
        error: null,
        usersScanned: usersScanned,
        // Snapshot (right now)
        appTrialActiveNow: appTrialActive,
        stripeCardTrialNow: stripeTrialing,
        bothNow: bothActive,
        rankingVideosLeftAmongActive: rankingVideosLeftBuckets,
        // Ended states (lifetime on user docs)
        appTrialConverted: converted,
        appTrialExhausted: exhausted,
        appTrialExpired: expired,
        // In selected range
        appTrialsStartedInRange: appStartedInRange,
        stripeCardTrialsStartedInRange: stripeTrialStartedInRange,
        definitions: {
            appTrialActiveNow: 'Users who can still cook free ranking videos (7 days OR 3 videos left)',
            stripeCardTrialNow: 'Users with Stripe subscription.status = trialing (card on file, not billed yet)',
            bothNow: 'Has Stripe card trial AND still has free ranking allotment',
            appTrialsStartedInRange: 'Users whose app trial.startedAt falls in the selected range',
            pageViews: 'Cloudflare page views for viewhunt.app in range'
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
    // v2 cache key — do not reuse old revenue payloads
    const cacheKey = 'analytics:v2:visits-trials:' + rangeInfo.range + ':' +
        rangeInfo.partnerStart.toISOString().slice(0, 10);

    if (!opts.refresh) {
        const cached = await readCache(opts.db, cacheKey);
        if (cached) {
            return Object.assign({}, cached, { cached: true });
        }
    }

    const [visits, trials] = await Promise.all([
        fetchCloudflareVisits(rangeInfo).catch(function(err) {
            console.error('Cloudflare analytics error:', err);
            return {
                source: 'Cloudflare',
                configured: !!(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ZONE_ID),
                error: err.message || String(err),
                pageViews: null,
                requests: null,
                uniqueVisitorsSum: null,
                series: []
            };
        }),
        fetchTrialMetrics(opts.db, rangeInfo).catch(function(err) {
            console.error('Trial analytics error:', err);
            return {
                source: 'Mongo',
                configured: true,
                error: err.message || String(err)
            };
        })
    ]);

    const payload = {
        asOf: new Date().toISOString(),
        range: rangeInfo.range,
        rangeStart: rangeInfo.start.toISOString(),
        rangeEnd: rangeInfo.end.toISOString(),
        partnerStart: rangeInfo.partnerStart.toISOString(),
        clampedToPartnerStart: rangeInfo.clampedToPartnerStart,
        cached: false,
        cacheTtlSeconds: Math.floor(CACHE_TTL_MS / 1000),
        focus: 'visits_and_trials',
        visits: visits,
        trials: trials
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
