/**
 * Offline smoke tests for trial helper + niche scheduler exports.
 * Run: node workers/smoke-test.js
 */
const assert = require('assert');
const trial = require('../studio/trial');
const niche = require('./niche-scheduler');

function testTrial() {
    assert.strictEqual(trial.TRIAL_DAYS, 7);
    assert.strictEqual(trial.TRIAL_RANKING_LIMIT, 3);
    assert.strictEqual(trial.STRIPE_TRIAL_DAYS, 7);

    const fields = trial.createTrialFields(new Date('2026-07-17T12:00:00Z'));
    assert.strictEqual(fields.status, 'active');
    assert.strictEqual(fields.rankingVideosLimit, 3);
    assert.ok(fields.endsAt > fields.startedAt);
    // 7-day window
    assert.strictEqual(
        Math.round((fields.endsAt - fields.startedAt) / (24 * 60 * 60 * 1000)),
        7
    );

    const user = { trial: fields };
    const active = trial.getTrialStatus(user, new Date('2026-07-18T12:00:00Z'));
    assert.strictEqual(active.active, true);
    assert.strictEqual(active.rankingVideosLeft, 3);
    assert.ok(active.daysLeft >= 1 && active.daysLeft <= 7);

    const expired = trial.getTrialStatus(user, new Date('2026-07-25T12:00:00Z'));
    assert.strictEqual(expired.active, false);
    assert.strictEqual(expired.reason, 'expired');

    const usedUp = trial.getTrialStatus({
        trial: { ...fields, rankingVideosUsed: 3, status: 'active' }
    }, new Date('2026-07-18T12:00:00Z'));
    assert.strictEqual(usedUp.active, false);
    assert.strictEqual(usedUp.reason, 'videos_exhausted');

    const converted = trial.getTrialStatus({
        trial: { ...fields, status: 'converted' }
    });
    assert.strictEqual(converted.active, false);
    assert.strictEqual(converted.reason, 'converted');

    // Card-collect used to set converted while Stripe was still trialing —
    // free ranking allotment must remain usable
    const convertedButStripeTrialing = trial.getTrialStatus({
        trial: { ...fields, status: 'converted', rankingVideosUsed: 0 },
        subscription: { status: 'trialing' }
    }, new Date('2026-07-18T12:00:00Z'));
    assert.strictEqual(convertedButStripeTrialing.active, true);
    assert.strictEqual(convertedButStripeTrialing.rankingVideosLeft, 3);
    assert.strictEqual(convertedButStripeTrialing.healedFromConverted, true);

    const convertedPaid = trial.getTrialStatus({
        trial: { ...fields, status: 'converted' },
        subscription: { status: 'active' }
    });
    assert.strictEqual(convertedPaid.active, false);
    assert.strictEqual(convertedPaid.reason, 'converted');

    console.log('✓ trial helper (7 days / 3 videos)');
}

function testNicheExports() {
    assert.ok(Array.isArray(niche.DEFAULT_WORD_POOL));
    assert.ok(niche.DEFAULT_WORD_POOL.length > 100);
    assert.strictEqual(niche.INTERVAL_MS, 24 * 60 * 60 * 1000);
    assert.strictEqual(typeof niche.startScrapeRun, 'function');
    assert.strictEqual(typeof niche.scheduleNicheRotation, 'function');
    console.log('✓ niche scheduler exports + spontaneous keywords');
}

function testFlyMachinesExports() {
    const fly = require('./fly-machines');
    assert.strictEqual(typeof fly.startAssemblyMachine, 'function');
    assert.strictEqual(typeof fly.startScraperMachine, 'function');
    assert.strictEqual(typeof fly.drainFlyAssemblyQueue, 'function');
    assert.strictEqual(typeof fly.assemblyMaxConcurrent, 'function');
    console.log('✓ fly-machines exports');
}

function testStorageExports() {
    const storage = require('./storage');
    assert.strictEqual(typeof storage.uploadFile, 'function');
    assert.strictEqual(typeof storage.isConfigured, 'function');
    assert.strictEqual(storage.isConfigured(), false);
    console.log('✓ storage exports (unconfigured)');
}

function testTelemetry() {
    const tel = require('../lib/telemetry');
    assert.strictEqual(typeof tel.track, 'function');
    assert.strictEqual(typeof tel.getPublicConfig, 'function');
    const attr = tel.normalizeAttribution({
        utm_source: 'meta',
        utm_campaign: 'spring',
        gclid: 'g123',
        junk: 'nope'
    });
    assert.strictEqual(attr.utm_source, 'meta');
    assert.strictEqual(attr.utm_campaign, 'spring');
    assert.strictEqual(attr.gclid, 'g123');
    assert.strictEqual(attr.junk, undefined);
    assert.ok(tel.sha256Email('Test@ViewHunt.app'));
    assert.strictEqual(tel.sha256Email('Test@ViewHunt.app'), tel.sha256Email('test@viewhunt.app'));
    const cfg = tel.getPublicConfig();
    assert.ok('posthogKey' in cfg && 'metaPixelId' in cfg && 'googleAdsId' in cfg);
    console.log('✓ telemetry (attribution + config)');
}

testTrial();
testNicheExports();
testFlyMachinesExports();
testStorageExports();
testTelemetry();
console.log('\nAll smoke tests passed.');
