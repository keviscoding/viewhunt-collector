/**
 * Niche keyword rotation + scrape run scheduler (every 3 days).
 * Each run picks a spontaneous random set of ultra-common title words
 * (prepositions, auxiliaries, pronouns — the ChatGPT "batch" style).
 * Fly Puppeteer only — never YouTube Data API (quality is too poor).
 */
const { ObjectId } = require('mongodb');
const { startScraperMachine } = require('./fly-machines');

/**
 * Ultra-common Shorts-title building blocks.
 * Spontaneous shuffle each run — NOT niche nouns (fashion/fitness/etc).
 * Inspired by the manual "Batch 70/71" common-word lists.
 */
const COMMON_WORD_POOL = [
    // Articles / determiners
    'a', 'an', 'the', 'this', 'that', 'these', 'those', 'some', 'any', 'every',
    'all', 'each', 'both', 'either', 'neither', 'other', 'another', 'such', 'own',
    // Prepositions / particles (Batch 71 style)
    'in', 'on', 'at', 'by', 'for', 'with', 'from', 'of', 'to', 'into', 'onto',
    'over', 'under', 'above', 'below', 'across', 'through', 'about', 'after',
    'before', 'between', 'without', 'against', 'during', 'until', 'since',
    'among', 'around', 'behind', 'beside', 'beyond', 'toward', 'upon', 'within',
    'along', 'near', 'off', 'out', 'up', 'down', 'away', 'back', 'inside', 'outside',
    // Pronouns
    'i', 'you', 'he', 'she', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
    'my', 'your', 'his', 'our', 'their', 'mine', 'yours', 'hers', 'ours', 'theirs',
    'who', 'what', 'which', 'whose', 'whom', 'someone', 'anyone', 'everyone',
    'nobody', 'somebody', 'everybody', 'something', 'anything', 'everything', 'nothing',
    // Auxiliaries / modals (Batch 70 style)
    'be', 'am', 'is', 'are', 'was', 'were', 'been', 'being',
    'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing', 'done',
    'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
    // Ultra-common verbs / -ing forms in sentence titles
    'go', 'going', 'went', 'gone', 'get', 'getting', 'got', 'make', 'making', 'made',
    'see', 'seeing', 'saw', 'seen', 'look', 'looking', 'keep', 'keeping', 'kept',
    'start', 'starting', 'started', 'stop', 'stopped', 'try', 'trying', 'tried',
    'say', 'saying', 'said', 'tell', 'telling', 'told', 'ask', 'asking', 'asked',
    'know', 'knowing', 'knew', 'think', 'thinking', 'thought', 'want', 'wanted',
    'need', 'needed', 'find', 'finding', 'found', 'take', 'taking', 'took', 'taken',
    'give', 'giving', 'gave', 'given', 'let', 'put', 'putting', 'come', 'coming', 'came',
    'leave', 'leaving', 'left', 'call', 'called', 'feel', 'feeling', 'felt',
    'seem', 'become', 'became', 'wait', 'waiting', 'cry', 'crying', 'run', 'running',
    'walk', 'walking', 'talk', 'talking', 'show', 'showing', 'showed', 'use', 'used',
    'help', 'helping', 'work', 'working', 'play', 'playing', 'watch', 'watching',
    'hear', 'heard', 'listen', 'turn', 'turned', 'open', 'opened', 'close', 'closed',
    'break', 'broke', 'broken', 'fix', 'fixed', 'happen', 'happened', 'happen',
    'realize', 'realized', 'decide', 'decided', 'choose', 'chose', 'chosen',
    'forget', 'forgot', 'remember', 'change', 'changed', 'move', 'moved',
    // Connectors / fillers that dominate titles
    'and', 'but', 'or', 'so', 'if', 'when', 'while', 'because', 'then', 'than',
    'as', 'like', 'just', 'only', 'even', 'still', 'also', 'too', 'not', 'no',
    'yes', 'never', 'always', 'really', 'very', 'already', 'almost', 'enough',
    'again', 'once', 'twice', 'more', 'most', 'much', 'many', 'little', 'few',
    'same', 'next', 'last', 'first', 'one', 'two', 'three', 'now', 'here', 'there',
    'why', 'how', 'where', 'why', 'how', 'where', 'yet', 'though', 'although',
    'unless', 'whether', 'until', 'since', 'after', 'before',
    // Bare ultra-common nouns that still appear in nearly every sentence title
    'way', 'day', 'time', 'life', 'thing', 'things', 'one', 'man', 'woman', 'guy',
    'girl', 'boy', 'kid', 'baby', 'mom', 'dad', 'friend', 'home', 'house', 'room',
    'door', 'car', 'phone', 'school', 'work', 'job', 'money', 'world', 'place',
    'night', 'morning', 'end', 'start', 'part', 'side', 'right', 'wrong', 'true',
    'real', 'fake', 'good', 'bad', 'best', 'worst', 'new', 'old', 'big', 'small'
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
 * Start a scrape run on Fly Puppeteer. Fails the run if Fly is not configured / cannot start.
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
    let flyError = null;
    try {
        flyStarted = await startScraperMachine(String(run._id));
    } catch (err) {
        flyError = err.message;
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

    const errMsg = flyError
        || 'Fly scraper unavailable (set FLY_API_TOKEN, FLY_SCRAPER_APP, FLY_SCRAPER_IMAGE). YouTube API fallback is disabled.';
    await db.collection('scrape_runs').updateOne(
        { _id: run._id },
        {
            $set: {
                status: 'failed',
                worker: null,
                error: errMsg,
                finishedAt: new Date()
            }
        }
    );
    throw new Error(errMsg);
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
