/**
 * Admin analytics — ViewHunt-only Stripe + Cloudflare + Mongo product trials.
 *
 * Partner-safe rules:
 * - Only ViewHunt price/product IDs (excludes Channel Recipe)
 * - Window starts at ANALYTICS_PARTNER_START_DATE (no pre-partnership revenue)
 * - Primary money metric = net cash (paid − refunds) on ViewHunt invoices
 * - Cancellations are counted separately (do not reduce already-collected cash)
 *
 * Cached 5 minutes. Never call from hot request paths.
 */
const trialHelper = require('../studio/trial');

const CACHE_TTL_MS = 5 * 60 * 1000;
const memoryCache = new Map();
const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

/** Default ViewHunt Stripe catalog (override with env). */
const DEFAULT_VH_PRICES = {
    starter: 'price_1Szdm8GphjFbfwFXzPRyaWZh',
    creator: 'price_1Szdo9GphjFbfwFXJgRiuK9J',
    credits_200: 'price_1Sze6EGphjFbfwFXvRXmeaVm',
    credits_500: 'price_1Sze9BGphjFbfwFXZs9Es5Gp',
    credits_1200: 'price_1SzeAWGphjFbfwFXHse4ozDj'
};

const DEFAULT_VH_PRODUCTS = {
    starter: 'prod_TxYtQnPnJtu4jx',
    creator: 'prod_TxYwRJjGDlhbU2',
    credits_200: 'prod_TxZEiXMtiSj9h4',
    credits_500: 'prod_TxZHzra36nqr8P',
    credits_1200: 'prod_TxZJ6aumDUcFG8'
};

function getViewHuntCatalog() {
    const prices = {
        starter: process.env.STRIPE_PRICE_STARTER || DEFAULT_VH_PRICES.starter,
        creator: process.env.STRIPE_PRICE_CREATOR || DEFAULT_VH_PRICES.creator,
        studio: process.env.STRIPE_PRICE_STUDIO || null,
        credits_200: process.env.STRIPE_PRICE_CREDITS_200 || DEFAULT_VH_PRICES.credits_200,
        credits_500: process.env.STRIPE_PRICE_CREDITS_500 || DEFAULT_VH_PRICES.credits_500,
        credits_1200: process.env.STRIPE_PRICE_CREDITS_1200 || DEFAULT_VH_PRICES.credits_1200
    };
    const products = {
        starter: process.env.STRIPE_PRODUCT_STARTER || DEFAULT_VH_PRODUCTS.starter,
        creator: process.env.STRIPE_PRODUCT_CREATOR || DEFAULT_VH_PRODUCTS.creator,
        studio: process.env.STRIPE_PRODUCT_STUDIO || null,
        credits_200: process.env.STRIPE_PRODUCT_CREDITS_200 || DEFAULT_VH_PRODUCTS.credits_200,
        credits_500: process.env.STRIPE_PRODUCT_CREDITS_500 || DEFAULT_VH_PRODUCTS.credits_500,
        credits_1200: process.env.STRIPE_PRODUCT_CREDITS_1200 || DEFAULT_VH_PRODUCTS.credits_1200
    };

    const priceToKey = {};
    const productToKey = {};
    const priceIds = new Set();
    const productIds = new Set();

    Object.keys(prices).forEach(function(key) {
        if (prices[key]) {
            priceToKey[prices[key]] = key;
            priceIds.add(prices[key]);
        }
    });
    Object.keys(products).forEach(function(key) {
        if (products[key]) {
            productToKey[products[key]] = key;
            productIds.add(products[key]);
        }
    });

    return { prices: prices, products: products, priceToKey: priceToKey, productToKey: productToKey, priceIds: priceIds, productIds: productIds };
}

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
    for (let i = 0; i < 80; i++) {
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

function linePriceId(line) {
    if (!line) return null;
    if (line.price && line.price.id) return line.price.id;
    if (typeof line.price === 'string') return line.price;
    if (line.pricing && line.pricing.price_details && line.pricing.price_details.price) {
        return line.pricing.price_details.price;
    }
    return null;
}

function lineProductId(line) {
    if (!line) return null;
    if (line.price && line.price.product) {
        return typeof line.price.product === 'string' ? line.price.product : line.price.product.id;
    }
    if (line.plan && line.plan.product) {
        return typeof line.plan.product === 'string' ? line.plan.product : line.plan.product.id;
    }
    return null;
}

function classifyViewHuntLine(line, catalog) {
    const priceId = linePriceId(line);
    if (priceId && catalog.priceToKey[priceId]) return catalog.priceToKey[priceId];
    const productId = lineProductId(line);
    if (productId && catalog.productToKey[productId]) return catalog.productToKey[productId];
    return null;
}

function invoiceIsViewHunt(inv, catalog) {
    const lines = (inv.lines && inv.lines.data) || [];
    for (let i = 0; i < lines.length; i++) {
        if (classifyViewHuntLine(lines[i], catalog)) return true;
    }
    return false;
}

function invoicePrimaryKey(inv, catalog) {
    const lines = (inv.lines && inv.lines.data) || [];
    let first = null;
    for (let i = 0; i < lines.length; i++) {
        const key = classifyViewHuntLine(lines[i], catalog);
        if (!key) continue;
        if (!first) first = key;
        if (key === 'starter' || key === 'creator' || key === 'studio') return key;
    }
    return first || 'other_viewhunt';
}

function subscriptionIsViewHunt(sub, catalog) {
    const items = (sub.items && sub.items.data) || [];
    for (let i = 0; i < items.length; i++) {
        const price = items[i].price;
        if (!price) continue;
        if (price.id && catalog.priceIds.has(price.id)) return true;
        const productId = typeof price.product === 'string' ? price.product : (price.product && price.product.id);
        if (productId && catalog.productIds.has(productId)) return true;
    }
    return false;
}

function subscriptionPlanKey(sub, catalog) {
    const items = (sub.items && sub.items.data) || [];
    for (let i = 0; i < items.length; i++) {
        const price = items[i].price;
        if (!price) continue;
        if (price.id && catalog.priceToKey[price.id]) return catalog.priceToKey[price.id];
        const productId = typeof price.product === 'string' ? price.product : (price.product && price.product.id);
        if (productId && catalog.productToKey[productId]) return catalog.productToKey[productId];
    }
    return null;
}

async function expandInvoiceLines(stripe, inv) {
    if (inv.lines && inv.lines.data && inv.lines.data.length && !inv.lines.has_more) {
        return inv;
    }
    try {
        const full = await stripe.invoices.retrieve(inv.id, { expand: ['lines.data.price'] });
        return full;
    } catch (e) {
        return inv;
    }
}

async function fetchStripeMetrics(stripe, rangeInfo) {
    const catalog = getViewHuntCatalog();
    if (!stripe) {
        return {
            scope: 'viewhunt_only',
            source: 'Stripe',
            configured: false,
            error: 'STRIPE_SECRET_KEY not configured',
            partnerStart: rangeInfo.partnerStart.toISOString(),
            catalogPriceIds: Array.from(catalog.priceIds)
        };
    }

    const startUnix = Math.floor(rangeInfo.start.getTime() / 1000);
    const endUnix = Math.floor(rangeInfo.end.getTime() / 1000);
    const partnerUnix = Math.floor(rangeInfo.partnerStart.getTime() / 1000);

    const [trialingAll, activeAll, pastDueAll, canceledRecent, paidInvoicesRaw, createdInRangeAll] = await Promise.all([
        listAll(stripe, 'subscriptions', { status: 'trialing' }),
        listAll(stripe, 'subscriptions', { status: 'active' }),
        listAll(stripe, 'subscriptions', { status: 'past_due' }),
        listAll(stripe, 'subscriptions', {
            status: 'canceled',
            created: { gte: partnerUnix }
        }),
        listAll(stripe, 'invoices', {
            status: 'paid',
            created: { gte: startUnix, lte: endUnix },
            expand: ['data.lines.data.price']
        }),
        listAll(stripe, 'subscriptions', {
            status: 'all',
            created: { gte: startUnix, lte: endUnix }
        })
    ]);

    const trialing = trialingAll.filter(function(s) { return subscriptionIsViewHunt(s, catalog); });
    const active = activeAll.filter(function(s) { return subscriptionIsViewHunt(s, catalog); });
    const pastDue = pastDueAll.filter(function(s) { return subscriptionIsViewHunt(s, catalog); });
    const createdInRange = createdInRangeAll.filter(function(s) { return subscriptionIsViewHunt(s, catalog); });

    // Expand lines when needed, then keep ViewHunt invoices only
    const expanded = [];
    for (let i = 0; i < paidInvoicesRaw.length; i++) {
        expanded.push(await expandInvoiceLines(stripe, paidInvoicesRaw[i]));
    }
    const vhInvoices = expanded.filter(function(inv) { return invoiceIsViewHunt(inv, catalog); });

    let grossCents = 0;
    let refundCents = 0;
    let currency = 'usd';
    const byPlan = {
        starter: 0,
        creator: 0,
        studio: 0,
        credits_200: 0,
        credits_500: 0,
        credits_1200: 0,
        other_viewhunt: 0
    };
    let paidInvoiceCount = 0;
    let zeroDollarInvoiceCount = 0;
    const firstPaidCustomers = new Set();

    vhInvoices.forEach(function(inv) {
        const paid = Number(inv.amount_paid) || 0;
        const refunded = Number(inv.amount_refunded) || 0;
        if (inv.currency) currency = inv.currency;

        if (paid <= 0) {
            zeroDollarInvoiceCount += 1;
            return; // ignore $0 trial invoices for partner money metrics
        }

        paidInvoiceCount += 1;
        grossCents += paid;
        refundCents += refunded;

        const key = invoicePrimaryKey(inv, catalog);
        byPlan[key] = (byPlan[key] || 0) + (paid - refunded);

        if (inv.billing_reason === 'subscription_create' && inv.customer) {
            firstPaidCustomers.add(String(inv.customer));
        }
    });

    let trialsStartedInRange = 0;
    createdInRange.forEach(function(sub) {
        if (sub.trial_start && sub.trial_start >= startUnix && sub.trial_start <= endUnix) {
            trialsStartedInRange += 1;
        }
    });

    // Conversion = left Stripe trial and is now paying (active/past_due), trial_end in window
    let conversionsInRange = 0;
    active.concat(pastDue).forEach(function(sub) {
        if (!sub.trial_end) return;
        if (sub.trial_end >= startUnix && sub.trial_end <= endUnix) conversionsInRange += 1;
    });

    // Cancellations in window (ViewHunt only). Does NOT reduce collected cash.
    let canceledInRange = 0;
    let cancelAtPeriodEndNow = 0;
    active.forEach(function(sub) {
        if (sub.cancel_at_period_end) cancelAtPeriodEndNow += 1;
    });
    canceledRecent.forEach(function(sub) {
        if (!subscriptionIsViewHunt(sub, catalog)) return;
        const canceledAt = sub.canceled_at || sub.ended_at;
        if (canceledAt && canceledAt >= startUnix && canceledAt <= endUnix) {
            canceledInRange += 1;
        }
    });

    // Partner MRR: only ViewHunt active subs that started on/after partner start
    // (avoids paying partner on legacy Channel Recipe / pre-deal ViewHunt base)
    let mrrCents = 0;
    let activePaidPartnerWindow = 0;
    active.forEach(function(sub) {
        const started = sub.start_date || sub.created;
        if (!started || started < partnerUnix) return;
        activePaidPartnerWindow += 1;
        const items = (sub.items && sub.items.data) || [];
        items.forEach(function(item) {
            const price = item.price;
            if (!price || !catalog.priceIds.has(price.id)) return;
            if (price.type !== 'recurring') return;
            const unit = Number(price.unit_amount) || 0;
            const qty = Number(item.quantity) || 1;
            const interval = price.recurring && price.recurring.interval;
            const count = (price.recurring && price.recurring.interval_count) || 1;
            let monthly = unit * qty;
            if (interval === 'year') monthly = monthly / (12 * count);
            else if (interval === 'week') monthly = (monthly * 52) / (12 * count);
            else if (interval === 'day') monthly = (monthly * 30) / count;
            else monthly = monthly / count;
            mrrCents += monthly;
        });
    });

    const netCents = grossCents - refundCents;
    const conversionRate = trialsStartedInRange > 0
        ? Math.round((conversionsInRange / trialsStartedInRange) * 1000) / 10
        : null;

    return {
        scope: 'viewhunt_only',
        source: 'Stripe',
        configured: true,
        error: null,
        partnerStart: rangeInfo.partnerStart.toISOString(),
        partnerNote: 'All money metrics exclude Channel Recipe and anything before ANALYTICS_PARTNER_START_DATE. Primary payout figure is netSales (gross − refunds). Cancellations are informational only.',
        catalogPriceIds: Array.from(catalog.priceIds),
        stripeTrialsNow: trialing.length,
        activePaidNow: active.length,
        activePaidSincePartnerStart: activePaidPartnerWindow,
        cancelAtPeriodEndNow: cancelAtPeriodEndNow,
        canceledInRange: canceledInRange,
        grossSales: moneyFromCents(grossCents, currency),
        netSales: moneyFromCents(netCents, currency),
        refunds: moneyFromCents(refundCents, currency),
        paidInvoices: paidInvoiceCount,
        zeroDollarInvoicesIgnored: zeroDollarInvoiceCount,
        newPaidCustomers: firstPaidCustomers.size,
        newPaidCustomersNote: 'Customers with a ViewHunt subscription_create invoice amount_paid > 0 in range',
        trialsStartedInRange: trialsStartedInRange,
        conversionsInRange: conversionsInRange,
        conversionRate: conversionRate,
        conversionRateNote: trialsStartedInRange > 0
            ? 'ViewHunt active/past_due with trial_end in range ÷ ViewHunt trials started in range'
            : 'No ViewHunt Stripe trials started in this range',
        mrrEstimate: moneyFromCents(Math.round(mrrCents), currency),
        mrrNote: 'ViewHunt recurring items on active subs that started on/after partner start only',
        byPlan: {
            starter: moneyFromCents(byPlan.starter, currency),
            creator: moneyFromCents(byPlan.creator, currency),
            studio: moneyFromCents(byPlan.studio, currency),
            credits_200: moneyFromCents(byPlan.credits_200, currency),
            credits_500: moneyFromCents(byPlan.credits_500, currency),
            credits_1200: moneyFromCents(byPlan.credits_1200, currency),
            other_viewhunt: moneyFromCents(byPlan.other_viewhunt, currency)
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

    function ymd(d) {
        return d.toISOString().slice(0, 10);
    }
    const startDate = ymd(rangeInfo.start);
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
        note: 'Product free trial = 7 days OR 3 ranking videos (ViewHunt app only — not Stripe, not Channel Recipe)'
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
    const cacheKey = 'analytics:vh:' + rangeInfo.range + ':' + rangeInfo.partnerStart.toISOString().slice(0, 10);

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
                scope: 'viewhunt_only',
                source: 'Stripe',
                configured: !!opts.stripe,
                error: err.message || String(err),
                partnerStart: rangeInfo.partnerStart.toISOString()
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
    getViewHuntCatalog,
    getPartnerStartDate,
    CACHE_TTL_MS
};
