/**
 * Offline smoke tests for trial helper + niche scheduler exports.
 * Run: node workers/smoke-test.js
 */
const assert = require('assert');
const trial = require('../studio/trial');
const niche = require('./niche-scheduler');

function testTrial() {
    const fields = trial.createTrialFields(new Date('2026-07-17T12:00:00Z'));
    assert.strictEqual(fields.status, 'active');
    assert.strictEqual(fields.rankingVideosLimit, 3);
    assert.ok(fields.endsAt > fields.startedAt);

    const user = { trial: fields };
    const active = trial.getTrialStatus(user, new Date('2026-07-18T12:00:00Z'));
    assert.strictEqual(active.active, true);
    assert.strictEqual(active.rankingVideosLeft, 3);
    assert.ok(active.daysLeft >= 1 && active.daysLeft <= 3);

    const expired = trial.getTrialStatus(user, new Date('2026-07-22T12:00:00Z'));
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

    console.log('✓ trial helper');
}

function testNicheExports() {
    assert.ok(Array.isArray(niche.DEFAULT_WORD_POOL));
    assert.ok(niche.DEFAULT_WORD_POOL.length > 100);
    assert.strictEqual(niche.INTERVAL_MS, 3 * 24 * 60 * 60 * 1000);
    assert.strictEqual(typeof niche.startScrapeRun, 'function');
    assert.strictEqual(typeof niche.scheduleNicheRotation, 'function');
    assert.strictEqual(typeof niche.generateSpontaneousKeywords, 'function');

    var a = niche.generateSpontaneousKeywords([], 15);
    var b = niche.generateSpontaneousKeywords([], 15);
    assert.strictEqual(a.length, 15);
    assert.strictEqual(b.length, 15);
    // Extremely unlikely two full shuffles match exactly; soft-check variety
    var same = a.join(',') === b.join(',');
    assert.ok(!same || a.length < 5, 'spontaneous picks should usually differ between runs');

    var avoided = niche.generateSpontaneousKeywords(a, 12);
    assert.strictEqual(avoided.length, 12);
    var overlap = avoided.filter(function(w) { return a.indexOf(w) >= 0; });
    // With a large pool, overlap with the avoided set should be low
    assert.ok(overlap.length <= 3, 'should prefer unused common words when possible');

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

testTrial();
testNicheExports();
testFlyMachinesExports();
testStorageExports();
console.log('\nAll smoke tests passed.');
