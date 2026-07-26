/**
 * Admin analytics — Stripe + Cloudflare + Mongo product trials.
 * Cached 5 minutes. Never call from hot request paths.
 */
const trialHelper = require('../studio/trial');

const CACHE_TTL_MS = 5 * 60 * 1000;
const memoryCache = new Map();

const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

function parseRange(range) {
    const days = RANGE_DAYS[range] || RANGE_DAYS['30d'];
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    return { range: RANGE_DAYS[range] ? range : '30d', days, start, end };
}

function moneyFromCents(cents, currency) {
    const amount = (Number(cents) || 0) / 100;
    return {
        cents: Number(cents) || 0,
        amount: amount,
        currency: (currency || 'usd').toLowerCase(),
        formatted: formatMoney(amount, currency)
    };
}

function formatMoney(amount, currency) {
    const cur = (currency || 'usd').toUpperCase();
    try {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(amount);
    } catch (e) {
        return cur + ' ' + amount.toFixed(2);
    }
}

async function listAll(stripe, method, params) {
    const out = [];
    let startingAfter = undefined;
    for (let i = 0; i < 50; i++) {
        const page = await stripe[method].list(Object.assign({}, params, {
            limit: 100,
            starting_after: startingAfter
        }));
        out.push.apply(out, page.data || []);
        if (!page.has_more || !page.data || !page.data.length) break;
        startingAfter = page.data[page.data.length - 1].id;
    }
    return out;
}

async function fetchStripeMetrics(stripe, rangeInfo) {
    if (!stripe) {
        return {
            source: 'Stripe',
            configured: false,
            error: 'STRIPE_SECRET_KEY not configured',
            stripeTrialsNow: null,
            activePaidNow: null,
            canceledNow: null,
            grossSales: null,
            paidInvoices: null,
            newPaidCustomers: null,
            trialsStartedInRange: null,
            conversionsInRange: null,
            conversionRate: null,
            mrrEstimate: null,
            byPlan: null
        };
    }

    const startUnix = Math.floor(rangeInfo.start.getTime() / 1000);
    const endUnix = Math.floor(rangeInfo.end.getTime() / 1000);

    const priceMap = {};
    if (process.env.STRIPE_PRICE_STARTER) priceMap[process.env.STRIPE_PRICE_STARTER] = 'starter';
    if (process.env.STRIPE_PRICE_CREATOR) priceMap[process.env.STRIPE_PRICE_CREATOR] = 'creator';
    if (process.env.STRIPE_PRICE_STUDIO) priceMap[process.env.STRIPE_PRICE_STUDIO] = 'studio';

    const [trialing, active, pastDue, paidInvoices, createdInRange] = await Promise.all([
        listAll(stripe, 'subscriptions', { status: 'trialing' }),
        listAll(stripe, 'subscriptions', { status: 'active' }),
        listAll(stripe, 'subscriptions', { status: 'past_due' }),
        listAll(stripe, 'invoices', {
            status: 'paid',
            created: { gte: startUnix, lte: endUnix }
        }),
        listAll(stripe, 'subscriptions', {
            status: 'all',
            created: { gte: startUnix, lte: endUnix }
        })
    ]);

    let grossCents = 0;
    let refundCents = 0;
    let currency = 'usd';
    const byPlan = { starter: 0, creator: 0, studio: 0, other: 0 };
    const newPaidCustomerIds = new Set();

    paidInvoices.forEach(function(inv) {
        const paid = Number(inv.amount_paid) || 0;
        const refunded = Number(inv.amount_refunded) || 0;
        grossCents += paid;
        refundCents += refunded;
        if (inv.currency) currency = inv.currency;

        let planKey = 'other';
        const lines = (inv.lines && inv.lines.data) || [];
        for (let i = 0; i < lines.length; i++) {
            const priceId = lines[i].price && lines[i].price.id;
            if (priceId && priceMap[priceId]) {
                planKey = priceMap[priceId];
                break;
            }
        }
        if (planKey === 'other' && inv.subscription_details && inv.subscription_details.metadata) {
            const metaPlan = inv.subscription_details.metadata.plan;
            if (metaPlan && byPlan[metaPlan] != null) planKey = metaPlan;
        }
        byPlan[planKey] = (byPlan[planKey] || 0) + (paid - refunded);

        // First subscription invoice ≈ new paid customer in this range
        if (inv.billing_reason === 'subscription_create' && inv.customer) {
            newPaidCustomerIds.add(String(inv.customer));
        }
    });

    // Trials that started in range (Stripe trial_start on subs created in range)
    let trialsStartedInRange = 0;
    createdInRange.forEach(function(sub) {
        if (sub.trial_start && sub.trial_start >= startUnix && sub.trial_start <= endUnix) {
            trialsStartedInRange += 1;
        }
    });

    // Conversions: active/past_due subs whose Stripe trial_end fell in range
    // (avoids listing every canceled sub; numbers match Stripe "left trial → paying")
    let conversionsInRange = 0;
    active.concat(pastDue).forEach(function(sub) {
        if (!sub.trial_end) return;
        if (sub.trial_end >= startUnix && sub.trial_end <= endUnix) {
            conversionsInRange += 1;
        }
    });

    // MRR estimate from active recurring items (clearly labeled estimate)
    let mrrCents = 0;
    active.forEach(function(sub) {
        const items = (sub.items && sub.items.data) || [];
        items.forEach(function(item) {
            const price = item.price;
            if (!price || price.type !== 'recurring') return;
            const unit = Number(price.unit_amount) || 0;
            const qty = Number(item.quantity) || 1;
            const interval = price.recurring && price.recurring.interval;
            const count = (price.recurring && price.recurring.interval_count) || 1;
            let monthly = unit * qty;
            if (interval === 'year') monthly = monthly / (12 * count);
            else if (interval === 'week') monthly = (monthly * 52) / (12 * count);
            else if (interval === 'day') monthly = (monthly * 30) / count;
            else monthly = monthly / count; // month
            mrrCents += monthly;
        });
    });

    const netCents = grossCents - refundCents;
    const conversionRate = trialsStartedInRange > 0
        ? Math.round((conversionsInRange / trialsStartedInRange) * 1000) / 10
        : null;

    return {
        source: 'Stripe',
        configured: true,
        error: null,
        stripeTrialsNow: trialing.length,
        activePaidNow: active.length,
        canceledNow: null,
        grossSales: moneyFromCents(grossCents, currency),
        netSales: moneyFromCents(netCents, currency),
        refunds: moneyFromCents(refundCents, currency),
        paidInvoices: paidInvoices.length,
        newPaidCustomers: newPaidCustomerIds.size,
        trialsStartedInRange: trialsStartedInRange,
        conversionsInRange: conversionsInRange,
        conversionRate: conversionRate,
        conversionRateNote: trialsStartedInRange > 0
            ? 'active/past_due with trial_end in range ÷ trials with trial_start in range'
            : 'No Stripe trials started in this range — rate not computed',
        mrrEstimate: moneyFromCents(Math.round(mrrCents), currency),
        mrrNote: 'Estimate from active subscription recurring items (normalized to monthly)',
        byPlan: {
            starter: moneyFromCents(byPlan.starter, currency),
            creator: moneyFromCents(byPlan.creator, currency),
            studio: moneyFromCents(byPlan.studio, currency),
            other: moneyFromCents(byPlan.other, currency)
        }
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
            uniqueVisitors: null,
            series: []
        };
    }

    // Cloudflare GraphQL expects date strings YYYY-MM-DD (UTC)
    function ymd(d) {
        return d.toISOString().slice(0, 10);
    }
    const startDate = ymd(rangeInfo.start);
    const endDate = ymd(new Date(rangeInfo.end.getTime() + 24 * 60 * 60 * 1000)); // exclusive end+1d

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
            uniqueVisitors: null,
            series: []
        };
    }

    const groups = ((((body.data || {}).viewer || {}).zones || [])[0] || {}).httpRequests1dGroups || [];
    let pageViews = 0;
    let requests = 0;
    let uniqueVisitors = 0;
    const series = groups.map(function(g) {
        const pv = (g.sum && g.sum.pageViews) || 0;
        const req = (g.sum && g.sum.requests) || 0;
        const u = (g.uniq && g.uniq.uniques) || 0;
        pageViews += pv;
        requests += req;
        uniqueVisitors += u;
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
        // Sum of daily uniques (not a true period unique — labeled on UI)
        uniqueVisitors: uniqueVisitors,
        uniqueVisitorsNote: 'Sum of daily unique visitors from Cloudflare (not a deduped period unique)',
        series: series,
        zoneId: zoneId
    };
}

async function fetchProductTrialMetrics(db) {
    if (!db) {
        return {
            source: 'Mongo',
            configured: false,
            error: 'Database unavailable',
            productTrialsActive: null,
            productTrialsConverted: null,
            productTrialsExhausted: null
        };
    }

    const cursor = db.collection('users').find(
        { trial: { $exists: true } },
        { projection: { trial: 1, email: 1 } }
    ).limit(20000);

    let active = 0;
    let converted = 0;
    let exhausted = 0;
    let expired = 0;
    let totalWithTrial = 0;

    while (await cursor.hasNext()) {
        const user = await cursor.next();
        totalWithTrial += 1;
        const status = trialHelper.getTrialStatus(user);
        if (!status) continue;
        if (status.active) active += 1;
        else if (status.reason === 'converted' || status.status === 'converted') converted += 1;
        else if (status.reason === 'videos_exhausted' || status.reason === 'exhausted') exhausted += 1;
        else if (status.reason === 'expired') expired += 1;
    }

    return {
        source: 'Mongo',
        configured: true,
        error: null,
        productTrialsActive: active,
        productTrialsConverted: converted,
        productTrialsExhausted: exhausted,
        productTrialsExpired: expired,
        usersWithTrialField: totalWithTrial,
        note: 'Product free trial = 7 days OR 3 ranking videos (not Stripe card trial)'
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

/**
 * @param {object} opts
 * @param {import('mongodb').Db} opts.db
 * @param {import('stripe').Stripe|null} opts.stripe
 * @param {string} opts.range
 * @param {boolean} [opts.refresh]
 */
async function getAdminAnalytics(opts) {
    const rangeInfo = parseRange(opts.range);
    const cacheKey = 'analytics:' + rangeInfo.range;

    if (!opts.refresh) {
        const cached = await readCache(opts.db, cacheKey);
        if (cached) {
            return Object.assign({}, cached, { cached: true });
        }
    }

    const [stripeMetrics, visits, productTrials] = await Promise.all([
        fetchStripeMetrics(opts.stripe, rangeInfo).catch(function(err) {
            console.error('Stripe analytics error:', err);
            return {
                source: 'Stripe',
                configured: !!opts.stripe,
                error: err.message || String(err),
                stripeTrialsNow: null,
                activePaidNow: null,
                grossSales: null,
                paidInvoices: null,
                newPaidCustomers: null,
                trialsStartedInRange: null,
                conversionsInRange: null,
                conversionRate: null,
                mrrEstimate: null,
                byPlan: null
            };
        }),
        fetchCloudflareVisits(rangeInfo).catch(function(err) {
            console.error('Cloudflare analytics error:', err);
            return {
                source: 'Cloudflare',
                configured: !!(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ZONE_ID),
                error: err.message || String(err),
                pageViews: null,
                requests: null,
                uniqueVisitors: null,
                series: []
            };
        }),
        fetchProductTrialMetrics(opts.db).catch(function(err) {
            console.error('Mongo trial analytics error:', err);
            return {
                source: 'Mongo',
                configured: true,
                error: err.message || String(err),
                productTrialsActive: null,
                productTrialsConverted: null,
                productTrialsExhausted: null
            };
        })
    ]);

    const payload = {
        asOf: new Date().toISOString(),
        range: rangeInfo.range,
        rangeStart: rangeInfo.start.toISOString(),
        rangeEnd: rangeInfo.end.toISOString(),
        cached: false,
        cacheTtlSeconds: Math.floor(CACHE_TTL_MS / 1000),
        visits: visits,
        stripe: stripeMetrics,
        productTrials: productTrials
    };

    await writeCache(opts.db, cacheKey, payload);
    return payload;
}

module.exports = {
    getAdminAnalytics,
    parseRange,
    CACHE_TTL_MS
};
