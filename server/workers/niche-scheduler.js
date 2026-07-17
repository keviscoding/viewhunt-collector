/**
 * Niche keyword rotation + scrape run scheduler (every 3 days).
 * Each run picks a spontaneous random set of very common everyday keywords.
 * Starts a Fly scraper Machine when configured; otherwise runs API fallback.
 */
const { ObjectId } = require('mongodb');
const { startScraperMachine } = require('./fly-machines');

/**
 * Large pool of short, everyday words that show up constantly in Shorts titles.
 * Selection is fully shuffled each run — not a fixed rotation order.
 */
const COMMON_WORD_POOL = [
    // Tiny connectors / function words (huge Shorts coverage)
    'a', 'the', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'of', 'to', 'into',
    'onto', 'over', 'under', 'about', 'after', 'before', 'between', 'without',
    'my', 'your', 'his', 'her', 'our', 'their', 'this', 'that', 'these', 'those',
    // Pronouns / people
    'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'us', 'them', 'who', 'what',
    'guy', 'girl', 'boy', 'man', 'woman', 'kid', 'baby', 'mom', 'dad', 'bro', 'sis',
    // Everyday verbs
    'go', 'do', 'did', 'does', 'make', 'get', 'got', 'can', 'will', 'try', 'use',
    'put', 'run', 'see', 'let', 'say', 'ask', 'give', 'take', 'find', 'want', 'need',
    'know', 'think', 'look', 'come', 'keep', 'help', 'show', 'start', 'stop', 'watch',
    'eat', 'drink', 'sleep', 'walk', 'drive', 'buy', 'sell', 'play', 'work', 'learn',
    'teach', 'build', 'break', 'fix', 'clean', 'cook', 'bake', 'open', 'close',
    // Question / hook words
    'how', 'why', 'when', 'where', 'which', 'if', 'vs', 'or', 'and', 'but', 'not',
    // Common descriptors
    'new', 'old', 'best', 'worst', 'top', 'easy', 'hard', 'quick', 'simple', 'big',
    'small', 'fast', 'slow', 'real', 'fake', 'free', 'full', 'long', 'short', 'hot',
    'cold', 'cool', 'dark', 'wild', 'crazy', 'insane', 'epic', 'funny', 'weird',
    'true', 'wrong', 'right', 'good', 'bad', 'next', 'last', 'first', 'only', 'just',
    'most', 'every', 'never', 'always', 'still', 'again', 'more', 'less', 'same',
    // Everyday nouns / life
    'life', 'day', 'night', 'time', 'way', 'home', 'house', 'room', 'door', 'car',
    'food', 'water', 'money', 'job', 'school', 'work', 'world', 'city', 'street',
    'friend', 'love', 'hate', 'story', 'secret', 'trick', 'hack', 'tip', 'facts',
    'body', 'face', 'hair', 'skin', 'hand', 'eye', 'mouth', 'teeth', 'phone',
    'game', 'video', 'movie', 'song', 'music', 'book', 'test', 'exam', 'class',
    'dog', 'cat', 'pet', 'animal', 'fish', 'bird', 'plant', 'tree', 'sun', 'rain',
    // Places / things people search constantly
    'store', 'mall', 'park', 'beach', 'gym', 'kitchen', 'bathroom', 'bed', 'office',
    'hotel', 'plane', 'train', 'bus', 'bike', 'road', 'bridge', 'building', 'farm',
    // Soft niches that still feel common
    'food', 'recipe', 'snack', 'cake', 'coffee', 'tea', 'pizza', 'burger', 'fruit',
    'fitness', 'workout', 'run', 'walk', 'sleep', 'morning', 'evening', 'weekend',
    'travel', 'trip', 'vacation', 'airport', 'ticket', 'map', 'camera', 'photo',
    'style', 'fashion', 'outfit', 'shoes', 'shirt', 'dress', 'makeup', 'nails',
    'tech', 'app', 'ai', 'laptop', 'wifi', 'battery', 'charge', 'update', 'hack',
    'sport', 'ball', 'team', 'win', 'lose', 'score', 'race', 'fight', 'match',
    // Ranking / list bait (common Shorts formats)
    'ranking', 'ranked', 'list', 'top', 'vs', 'versus', 'tier', 'number', 'part',
    'side', 'end', 'back', 'front', 'middle', 'inside', 'outside'
];

// Alias for smoke tests / older imports
const DEFAULT_WORD_POOL = COMMON_WORD_POOL;

const KEYWORDS_PER_RUN_MIN = 12;
const KEYWORDS_PER_RUN_MAX = 18;
const KEYWORDS_PER_RUN = 15;
const INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const RECENT_RUNS_TO_AVOID = 2; // don't immediately reuse words from last N runs when possible

function shuffleInPlace(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
    return arr;
}

function uniquePool() {
    var seen = {};
    var out = [];
    for (var i = 0; i < COMMON_WORD_POOL.length; i++) {
        var w = String(COMMON_WORD_POOL[i]).toLowerCase().trim();
        if (!w || seen[w]) continue;
        seen[w] = true;
        out.push(w);
    }
    return out;
}

/**
 * Spontaneous keyword set for one scrape run.
 * - Random count between min/max
 * - Full shuffle of common words
 * - Prefer words not used in the last few runs (still random among the rest)
 */
function generateSpontaneousKeywords(recentWords, limit) {
    var pool = uniquePool();
    shuffleInPlace(pool);

    var avoid = {};
    if (recentWords && recentWords.length) {
        for (var i = 0; i < recentWords.length; i++) {
            avoid[String(recentWords[i]).toLowerCase()] = true;
        }
    }

    var fresh = [];
    var fallback = [];
    for (var p = 0; p < pool.length; p++) {
        if (avoid[pool[p]]) fallback.push(pool[p]);
        else fresh.push(pool[p]);
    }

    // Re-shuffle both buckets so order is never predictable
    shuffleInPlace(fresh);
    shuffleInPlace(fallback);

    var count = limit;
    if (!count) {
        count = KEYWORDS_PER_RUN_MIN + Math.floor(
            Math.random() * (KEYWORDS_PER_RUN_MAX - KEYWORDS_PER_RUN_MIN + 1)
        );
    }

    var picked = fresh.slice(0, count);
    if (picked.length < count) {
        picked = picked.concat(fallback.slice(0, count - picked.length));
    }

    // Final shuffle so the scrape order itself is spontaneous
    return shuffleInPlace(picked);
}

async function ensureNicheIndexes(db) {
    await db.collection('niche_keywords').createIndex({ word: 1 }, { unique: true });
    await db.collection('niche_keywords').createIndex({ lastUsedAt: 1 });
    await db.collection('niche_keywords').createIndex({ active: 1 });
    await db.collection('scrape_runs').createIndex({ status: 1, createdAt: -1 });
    await db.collection('scrape_runs').createIndex({ scheduledFor: 1 });
}

/** Keep a history table, but do not drive selection order from it. */
async function seedNicheKeywords(db) {
    const count = await db.collection('niche_keywords').countDocuments();
    if (count > 0) return count;

    const docs = uniquePool().map(function(word) {
        return {
            word: word,
            active: true,
            lastUsedAt: null,
            timesUsed: 0,
            source: 'common-pool',
            createdAt: new Date()
        };
    });
    await db.collection('niche_keywords').insertMany(docs);
    console.log('🌱 Seeded ' + docs.length + ' common niche_keywords (history only)');
    return docs.length;
}

async function getRecentKeywords(db, runCount) {
    runCount = runCount || RECENT_RUNS_TO_AVOID;
    const runs = await db.collection('scrape_runs')
        .find({ status: { $in: ['complete', 'processing', 'queued'] } })
        .sort({ createdAt: -1 })
        .limit(runCount)
        .toArray();
    const words = [];
    for (var i = 0; i < runs.length; i++) {
        var kws = runs[i].keywords || [];
        for (var j = 0; j < kws.length; j++) words.push(kws[j]);
    }
    return words;
}

/**
 * Pick a spontaneous keyword set and upsert history docs.
 * Returns array of { word, _id? } for createScrapeRun compatibility.
 */
async function pickKeywords(db, limit) {
    const recent = await getRecentKeywords(db);
    const words = generateSpontaneousKeywords(recent, limit);
    const docs = [];

    for (var i = 0; i < words.length; i++) {
        const word = words[i];
        const result = await db.collection('niche_keywords').findOneAndUpdate(
            { word: word },
            {
                $setOnInsert: {
                    word: word,
                    active: true,
                    source: 'common-pool',
                    createdAt: new Date(),
                    timesUsed: 0
                },
                $set: { lastPickedAt: new Date() }
            },
            { upsert: true, returnDocument: 'after' }
        );
        const doc = result && result.value
            ? result.value
            : await db.collection('niche_keywords').findOne({ word: word });
        docs.push(doc || { word: word });
    }

    console.log('🌱 Spontaneous keywords (' + docs.length + '): ' + words.join(', '));
    return docs;
}

async function createScrapeRun(db, keywords, trigger) {
    const words = keywords.map(function(k) { return k.word || k; });
    const doc = {
        status: 'queued',
        keywords: words,
        keywordIds: keywords.map(function(k) { return k._id; }).filter(Boolean),
        trigger: trigger || 'schedule',
        spontaneous: true,
        createdAt: new Date(),
        startedAt: null,
        finishedAt: null,
        channelsFound: 0,
        channelsUpserted: 0,
        error: null,
        worker: null
    };
    const result = await db.collection('scrape_runs').insertOne(doc);
    return { ...doc, _id: result.insertedId };
}

async function markKeywordsUsed(db, keywordIds) {
    if (!keywordIds || !keywordIds.length) return;
    await db.collection('niche_keywords').updateMany(
        { _id: { $in: keywordIds } },
        {
            $set: { lastUsedAt: new Date() },
            $inc: { timesUsed: 1 }
        }
    );
}

/**
 * Start a scrape run: prefer Fly Puppeteer Machine, else YouTube API auto-collector for those keywords.
 */
async function startScrapeRun(db, options) {
    options = options || {};
    await ensureNicheIndexes(db);
    await seedNicheKeywords(db);

    let keywords;
    if (options.keywords && options.keywords.length) {
        // Explicit admin override still allowed; normalize to docs
        keywords = options.keywords.map(function(w) { return { word: String(w).toLowerCase().trim() }; });
        shuffleInPlace(keywords);
    } else {
        keywords = await pickKeywords(db, options.limit || null);
    }

    if (!keywords.length) {
        throw new Error('No niche keywords available');
    }

    const run = await createScrapeRun(db, keywords, options.trigger || 'schedule');

    let flyStarted = false;
    try {
        flyStarted = await startScraperMachine(String(run._id));
    } catch (err) {
        console.warn('Fly scraper start failed:', err.message);
    }

    if (flyStarted) {
        await db.collection('scrape_runs').updateOne(
            { _id: run._id },
            { $set: { status: 'processing', worker: 'fly', startedAt: new Date() } }
        );
        await markKeywordsUsed(db, keywords.map(function(k) { return k._id; }).filter(Boolean));
        return { runId: String(run._id), worker: 'fly', keywords: run.keywords };
    }

    // Fallback: YouTube Data API path (auto-collector style) for the selected keywords
    await db.collection('scrape_runs').updateOne(
        { _id: run._id },
        { $set: { status: 'processing', worker: 'api-fallback', startedAt: new Date() } }
    );
    await markKeywordsUsed(db, keywords.map(function(k) { return k._id; }).filter(Boolean));

    const auto = require('../auto-collector');
    setImmediate(async function() {
        try {
            const apiKey = process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY;
            let upserted = 0;
            let found = 0;
            for (let i = 0; i < run.keywords.length; i++) {
                const kw = run.keywords[i];
                const results = await auto.searchAndCollect(kw, apiKey, 50);
                found += results.length;
                const qualified = results.filter(auto.isQualifiedChannel);
                for (let c = 0; c < qualified.length; c++) {
                    const ch = qualified[c];
                    ch.source = 'scrape-scheduler';
                    ch.niche_keyword = kw;
                    const existing = await db.collection('channels').findOne({ channel_url: ch.channel_url });
                    if (!existing) {
                        await db.collection('channels').insertOne(ch);
                        upserted++;
                    }
                }
                await new Promise(function(r) { setTimeout(r, 1000); });
            }

            await upsertNewNichesFeed(db, run.keywords);

            await db.collection('scrape_runs').updateOne(
                { _id: run._id },
                {
                    $set: {
                        status: 'complete',
                        finishedAt: new Date(),
                        channelsFound: found,
                        channelsUpserted: upserted
                    }
                }
            );
            console.log('🌱 Scrape run (API fallback) complete:', String(run._id), upserted, 'new channels');
        } catch (err) {
            console.error('Scrape run fallback failed:', err.message);
            await db.collection('scrape_runs').updateOne(
                { _id: run._id },
                { $set: { status: 'failed', error: err.message, finishedAt: new Date() } }
            );
        }
    });

    return { runId: String(run._id), worker: 'api-fallback', keywords: run.keywords };
}

async function upsertNewNichesFeed(db, keywords) {
    let collection = await db.collection('collections').findOne({ name: 'New Niches', system: true });
    if (!collection) {
        const inserted = await db.collection('collections').insertOne({
            name: 'New Niches',
            description: 'Auto-rotated niches from the 3-day scraper',
            system: true,
            created_at: new Date(),
            updated_at: new Date()
        });
        collection = { _id: inserted.insertedId };
    }

    await db.collection('niche_rotations').insertOne({
        keywords: keywords,
        collectionId: collection._id,
        createdAt: new Date()
    });

    await db.collection('collections').updateOne(
        { _id: collection._id },
        {
            $set: {
                updated_at: new Date(),
                last_keywords: keywords,
                last_rotation_at: new Date()
            }
        }
    );
}

function scheduleNicheRotation(db) {
    async function tick() {
        try {
            const last = await db.collection('scrape_runs')
                .find({ trigger: 'schedule' })
                .sort({ createdAt: -1 })
                .limit(1)
                .toArray();

            const lastAt = last[0] && last[0].createdAt ? new Date(last[0].createdAt).getTime() : 0;
            const due = !lastAt || (Date.now() - lastAt) >= INTERVAL_MS;

            if (due) {
                console.log('🌱 Niche rotation due — starting spontaneous scrape run');
                await startScrapeRun(db, { trigger: 'schedule' });
            } else {
                const nextIn = INTERVAL_MS - (Date.now() - lastAt);
                console.log('🌱 Next niche rotation in ' + Math.round(nextIn / 3600000) + 'h');
            }
        } catch (err) {
            console.error('Niche rotation tick error:', err.message);
        }
    }

    setTimeout(tick, 15000);
    setInterval(tick, 6 * 60 * 60 * 1000);
}

module.exports = {
    COMMON_WORD_POOL,
    DEFAULT_WORD_POOL,
    KEYWORDS_PER_RUN,
    KEYWORDS_PER_RUN_MIN,
    KEYWORDS_PER_RUN_MAX,
    INTERVAL_MS,
    generateSpontaneousKeywords,
    ensureNicheIndexes,
    seedNicheKeywords,
    pickKeywords,
    startScrapeRun,
    scheduleNicheRotation,
    upsertNewNichesFeed
};
