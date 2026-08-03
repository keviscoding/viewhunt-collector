/**
 * ViewHunt telemetry — PostHog + Meta CAPI + Mongo event log for funnel KPIs.
 * Never throw to callers; all network failures are logged and swallowed.
 */
const crypto = require('crypto');
const { ObjectId } = require('mongodb');

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
const CLICK_KEYS = ['gclid', 'fbclid', 'fbp', 'fbc'];

function getPublicConfig() {
    return {
        posthogKey: process.env.POSTHOG_KEY || '',
        posthogHost: (process.env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/$/, ''),
        metaPixelId: process.env.META_PIXEL_ID || '',
        googleAdsId: process.env.GOOGLE_ADS_ID || '',
        googleAdsLabelTrial: process.env.GOOGLE_ADS_LABEL_TRIAL || '',
        googleAdsLabelPaid: process.env.GOOGLE_ADS_LABEL_PAID || '',
        enabled: !!(process.env.POSTHOG_KEY || process.env.META_PIXEL_ID || process.env.GOOGLE_ADS_ID)
    };
}

function normalizeAttribution(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    UTM_KEYS.concat(CLICK_KEYS).forEach(function(k) {
        if (raw[k] != null && String(raw[k]).trim()) {
            out[k] = String(raw[k]).trim().slice(0, 256);
        }
    });
    if (raw.landing_page) out.landing_page = String(raw.landing_page).slice(0, 500);
    if (raw.referrer) out.referrer = String(raw.referrer).slice(0, 500);
    return Object.keys(out).length ? out : null;
}

function sha256Email(email) {
    if (!email || typeof email !== 'string') return null;
    const normalized = email.trim().toLowerCase();
    if (!normalized) return null;
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

function makeEventId(prefix, userId) {
    return (prefix || 'evt') + '_' + String(userId || 'anon') + '_' + Date.now() + '_' +
        crypto.randomBytes(4).toString('hex');
}

async function persistAttribution(db, userId, attribution) {
    if (!db || !userId) return null;
    const attr = normalizeAttribution(attribution);
    if (!attr) return null;
    const id = typeof userId === 'string' ? new ObjectId(userId) : userId;
    const now = new Date();
    const user = await db.collection('users').findOne(
        { _id: id },
        { projection: { attribution: 1 } }
    );
    const update = {
        'attribution.lastTouch': attr,
        'attribution.updatedAt': now,
        updated_at: now
    };
    if (!user || !user.attribution || !user.attribution.firstTouch) {
        update['attribution.firstTouch'] = Object.assign({}, attr, { capturedAt: now });
    }
    await db.collection('users').updateOne({ _id: id }, { $set: update });
    return attr;
}

async function logEvent(db, opts) {
    if (!db) return;
    try {
        const doc = {
            event: opts.event,
            userId: opts.userId ? String(opts.userId) : null,
            distinctId: opts.distinctId || (opts.userId ? String(opts.userId) : null),
            properties: opts.properties || {},
            attribution: opts.attribution || null,
            eventId: opts.eventId || makeEventId(opts.event, opts.userId),
            createdAt: new Date()
        };
        await db.collection('analytics_events').insertOne(doc);
        return doc.eventId;
    } catch (e) {
        console.warn('telemetry logEvent:', e.message);
        return null;
    }
}

async function posthogCapture(opts) {
    const key = process.env.POSTHOG_KEY;
    if (!key) return;
    const host = (process.env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/$/, '');
    const distinctId = opts.distinctId || (opts.userId ? String(opts.userId) : 'anonymous');
    try {
        await fetch(host + '/capture/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: key,
                event: opts.event,
                distinct_id: distinctId,
                properties: Object.assign({
                    $lib: 'viewhunt-server',
                    userId: opts.userId ? String(opts.userId) : undefined
                }, opts.properties || {}),
                timestamp: new Date().toISOString()
            })
        });
    } catch (e) {
        console.warn('PostHog capture failed:', e.message);
    }
}

async function posthogIdentify(userId, traits) {
    const key = process.env.POSTHOG_KEY;
    if (!key || !userId) return;
    const host = (process.env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/$/, '');
    try {
        await fetch(host + '/capture/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: key,
                event: '$identify',
                distinct_id: String(userId),
                properties: {
                    $set: traits || {}
                }
            })
        });
    } catch (e) {
        console.warn('PostHog identify failed:', e.message);
    }
}

async function metaCapi(opts) {
    const pixelId = process.env.META_PIXEL_ID;
    const token = process.env.META_CAPI_TOKEN;
    if (!pixelId || !token) return;

    const eventName = opts.eventName; // CompleteRegistration | StartTrial | Purchase | Subscribe
    const eventId = opts.eventId || makeEventId(eventName, opts.userId);
    const userData = {};
    const emailHash = sha256Email(opts.email);
    if (emailHash) userData.em = [emailHash];
    if (opts.userId) userData.external_id = [String(opts.userId)];
    if (opts.fbp) userData.fbp = opts.fbp;
    if (opts.fbc) userData.fbc = opts.fbc;
    if (opts.clientIp) userData.client_ip_address = opts.clientIp;
    if (opts.userAgent) userData.client_user_agent = opts.userAgent;

    const customData = Object.assign({}, opts.customData || {});
    if (opts.value != null) {
        customData.value = opts.value;
        customData.currency = (opts.currency || 'USD').toUpperCase();
    }

    const payload = {
        data: [{
            event_name: eventName,
            event_time: Math.floor(Date.now() / 1000),
            event_id: eventId,
            event_source_url: opts.eventSourceUrl || (process.env.APP_URL || 'https://viewhunt.app'),
            action_source: 'website',
            user_data: userData,
            custom_data: Object.keys(customData).length ? customData : undefined
        }],
        access_token: token
    };
    if (process.env.META_CAPI_TEST_CODE) {
        payload.test_event_code = process.env.META_CAPI_TEST_CODE;
    }

    try {
        const url = 'https://graph.facebook.com/v19.0/' + pixelId + '/events';
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) {
            const body = await res.text().catch(function() { return ''; });
            console.warn('Meta CAPI HTTP', res.status, body.slice(0, 300));
        }
    } catch (e) {
        console.warn('Meta CAPI failed:', e.message);
    }
    return eventId;
}

/**
 * Fire a canonical funnel event everywhere (Mongo + PostHog + optional Meta).
 */
async function track(db, opts) {
    const event = opts.event;
    const userId = opts.userId ? String(opts.userId) : null;
    const attribution = normalizeAttribution(opts.attribution) || null;
    const properties = Object.assign({}, opts.properties || {}, attribution || {});
    const eventId = opts.eventId || makeEventId(event, userId);

    await logEvent(db, {
        event: event,
        userId: userId,
        distinctId: opts.distinctId || userId,
        properties: properties,
        attribution: attribution,
        eventId: eventId
    });

    await posthogCapture({
        event: event,
        userId: userId,
        distinctId: opts.distinctId || userId || 'anonymous',
        properties: Object.assign({}, properties, { event_id: eventId })
    });

    // Meta CAPI mapping for key conversions
    if (event === 'signup_completed') {
        await metaCapi({
            eventName: 'CompleteRegistration',
            eventId: eventId,
            userId: userId,
            email: opts.email,
            fbp: attribution && attribution.fbp,
            fbc: attribution && attribution.fbc,
            clientIp: opts.clientIp,
            userAgent: opts.userAgent,
            eventSourceUrl: opts.eventSourceUrl
        });
    } else if (event === 'trial_started') {
        await metaCapi({
            eventName: 'StartTrial',
            eventId: eventId,
            userId: userId,
            email: opts.email,
            fbp: attribution && attribution.fbp,
            fbc: attribution && attribution.fbc,
            clientIp: opts.clientIp,
            userAgent: opts.userAgent,
            eventSourceUrl: opts.eventSourceUrl,
            customData: { content_name: (opts.properties && opts.properties.plan) || 'trial' }
        });
    } else if (event === 'subscription_activated') {
        await metaCapi({
            eventName: 'Purchase',
            eventId: eventId,
            userId: userId,
            email: opts.email,
            fbp: attribution && attribution.fbp,
            fbc: attribution && attribution.fbc,
            clientIp: opts.clientIp,
            userAgent: opts.userAgent,
            eventSourceUrl: opts.eventSourceUrl,
            value: opts.value,
            currency: opts.currency || 'usd',
            customData: {
                content_name: (opts.properties && opts.properties.plan) || 'subscription'
            }
        });
    }

    return eventId;
}

function clientIpFromReq(req) {
    if (!req) return null;
    const xf = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
    if (xf) return String(xf).split(',')[0].trim();
    return req.ip || null;
}

module.exports = {
    getPublicConfig,
    normalizeAttribution,
    persistAttribution,
    track,
    logEvent,
    posthogCapture,
    posthogIdentify,
    metaCapi,
    makeEventId,
    sha256Email,
    clientIpFromReq,
    UTM_KEYS,
    CLICK_KEYS
};
