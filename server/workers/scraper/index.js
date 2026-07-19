/**
 * Fly Machine Puppeteer scraper — ports Chrome extension Start loop.
 *
 * Env: RUN_ID, APP_URL, MONGODB_URI, WORKER_SECRET, YOUTUBE_API_KEY
 */
const path = require('path');
const fs = require('fs');
const { MongoClient, ObjectId } = require('mongodb');
const puppeteer = require('puppeteer');
const { enrichChannelsFull } = require('./enrich');

const RUN_ID = process.env.RUN_ID;
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const APP_INTERNAL_URL = (process.env.APP_INTERNAL_URL || '').replace(/\/$/, '');
const MONGODB_URI = process.env.MONGODB_URI || process.env.V2_MONGO_URI || process.env.MONGO_URI;
// Must match DO server.js: v2Client.db('viewhuntv2')
const MONGODB_DB = process.env.MONGODB_DB || process.env.MONGO_DB_NAME || 'viewhuntv2';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY || '';
// Scroll until results dry up (3 stale scrolls) or hit this safety ceiling
const SCROLL_COUNT = parseInt(process.env.SCRAPE_SCROLL_COUNT || '200', 10);
// 0 / unset = no per-keyword channel cap (extension-style: take everything scrolled)
const _maxChRaw = process.env.SCRAPE_MAX_CHANNELS;
const MAX_CHANNELS_PER_KEYWORD = (_maxChRaw === undefined || _maxChRaw === '' || _maxChRaw === '0')
    ? 0
    : parseInt(_maxChRaw, 10);

function delay(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

/**
 * Mirrors Chrome extension Start loop (background.js + content.js):
 * asterisk search → Shorts filter chip → scroll → extract unique channels.
 */
async function scrapeKeyword(page, keyword) {
    const searchKeyword = '*' + keyword + '*';
    const searchUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(searchKeyword);
    console.log('Scraping', searchKeyword);

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(2500);

    // Dismiss consent if present
    try {
        const consent = await page.$('button[aria-label*="Accept"], button[aria-label*="Agree"], form[action*="consent"] button');
        if (consent) await consent.click();
        await delay(1000);
    } catch (e) { /* ignore */ }

    // Click Shorts chip — same strategies as content.js
    const shortsApplied = await page.evaluate(function() {
        function clickEl(el) {
            if (!el) return false;
            try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
            el.click();
            try {
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            } catch (e2) { /* ignore */ }
            return true;
        }

        var chipCloud = document.querySelector('yt-chip-cloud-renderer');
        if (chipCloud) {
            var chips = chipCloud.querySelectorAll('yt-chip-cloud-chip-renderer');
            for (var i = 0; i < chips.length; i++) {
                var text = (chips[i].textContent || '').trim().toLowerCase();
                if (text === 'shorts') {
                    var btn = chips[i].querySelector('a') ||
                        chips[i].querySelector('button') ||
                        chips[i].querySelector('[role="tab"]') ||
                        chips[i].querySelector('.yt-spec-button-shape-next') ||
                        chips[i].querySelector('#chip-shape, .ytChipShapeButtonReset') ||
                        chips[i];
                    return clickEl(btn);
                }
            }
        }

        // Extension method 2: Shorts filter param
        var shortsLinks = document.querySelectorAll('a[href*="sp=EgIYAQ"]');
        for (var j = 0; j < shortsLinks.length; j++) {
            var linkText = (shortsLinks[j].textContent || '').trim().toLowerCase();
            if (linkText === 'shorts') return clickEl(shortsLinks[j]);
        }

        var headerArea = document.querySelector('ytd-search-header-renderer') ||
            document.querySelector('#header') ||
            document.querySelector('[role="tablist"]');
        if (headerArea) {
            var allLinks = headerArea.querySelectorAll('a');
            for (var k = 0; k < allLinks.length; k++) {
                var t = (allLinks[k].textContent || '').trim().toLowerCase();
                if (t === 'shorts' && (allLinks[k].href || '').indexOf('youtube.com/results') >= 0) {
                    return clickEl(allLinks[k]);
                }
            }
        }
        return false;
    });
    console.log('Shorts filter applied:', shortsApplied);
    await delay(shortsApplied ? 3000 : 1500);

    // Scroll like extension: stop after 3 scrolls with no new videos, or SCROLL_COUNT
    var lastCount = 0;
    var stale = 0;
    for (var s = 0; s < SCROLL_COUNT; s++) {
        await page.evaluate(function() { window.scrollTo(0, document.documentElement.scrollHeight); });
        await delay(1500);
        var count = await page.evaluate(function() {
            return document.querySelectorAll('ytd-video-renderer, ytd-reel-item-renderer').length;
        });
        if (count === lastCount) {
            stale++;
            if (stale >= 3) {
                console.log('Reached end of results after', s + 1, 'scrolls,', count, 'items');
                break;
            }
        } else {
            stale = 0;
            lastCount = count;
        }
    }

    const results = await page.evaluate(function(channelLimit) {
        function parseViews(viewStr) {
            if (!viewStr) return 0;
            var text = String(viewStr).toLowerCase().replace(/views|,/g, '').trim();
            var num = parseFloat(text);
            if (isNaN(num)) return 0;
            if (text.indexOf('k') >= 0) return Math.round(num * 1000);
            if (text.indexOf('m') >= 0) return Math.round(num * 1000000);
            if (text.indexOf('b') >= 0) return Math.round(num * 1000000000);
            return Math.round(num);
        }

        function extractVideoId(url) {
            if (!url) return null;
            var m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
            return m ? m[1] : null;
        }

        var out = [];
        var seen = {};
        var items = document.querySelectorAll('ytd-video-renderer, ytd-reel-item-renderer');

        for (var i = 0; i < items.length; i++) {
            if (channelLimit > 0 && out.length >= channelLimit) break;
            var video = items[i];
            try {
                var titleEl = video.querySelector('a#video-title') ||
                    video.querySelector('a[title]') ||
                    video.querySelector('h3 a') ||
                    video.querySelector('span#video-title') ||
                    video.querySelector('.reel-item-endpoint');
                var channelEl = video.querySelector('ytd-channel-name a') ||
                    video.querySelector('a[href*="/channel/"]') ||
                    video.querySelector('a[href*="/@"]') ||
                    video.querySelector('.yt-simple-endpoint[href*="/channel/"]') ||
                    video.querySelector('.yt-simple-endpoint[href*="/@"]');
                var viewsEl = video.querySelector('#metadata-line span') ||
                    video.querySelector('span.inline-metadata-item') ||
                    video.querySelector('.yt-content-metadata-view-model__metadata-text');

                var channelName = channelEl ? (channelEl.textContent || '').trim() : null;
                var channelUrl = channelEl ? channelEl.href : null;
                var videoTitle = titleEl ? (titleEl.getAttribute('title') || titleEl.textContent || '').trim() : null;
                var videoUrl = titleEl ? titleEl.href : null;
                var views = parseViews(viewsEl ? viewsEl.textContent : '0');

                if (!channelName || !channelUrl || seen[channelUrl]) continue;
                seen[channelUrl] = true;

                var thumb = null;
                var img = video.querySelector('img[src*="ytimg"]') ||
                    video.querySelector('img[src*="yt3.ggpht.com"]') ||
                    video.querySelector('img');
                if (img && img.src) thumb = img.src;
                else {
                    var vid = extractVideoId(videoUrl);
                    if (vid) thumb = 'https://img.youtube.com/vi/' + vid + '/hqdefault.jpg';
                }

                out.push({
                    channel_name: channelName,
                    channel_url: channelUrl,
                    video_title: videoTitle || '',
                    view_count: views,
                    thumbnail_url: thumb,
                    video_url: videoUrl || null
                });
            } catch (e) { /* skip item */ }
        }
        return out;
    }, MAX_CHANNELS_PER_KEYWORD);

    return results;
}

function summarizeChannels(channels) {
    var byKeyword = {};
    var samples = [];
    for (var i = 0; i < channels.length; i++) {
        var ch = channels[i];
        var kw = ch.niche_keyword || 'unknown';
        byKeyword[kw] = (byKeyword[kw] || 0) + 1;
        if (samples.length < 500) {
            samples.push({
                channel_name: ch.channel_name || ch.channelName,
                channel_url: ch.channel_url || ch.channelUrl,
                niche_keyword: kw,
                view_count: ch.view_count || ch.viewCount || 0,
                video_title: ch.video_title || ch.videoTitle || '',
                thumbnail_url: ch.thumbnail_url || ch.thumbnailUrl || ch.avatar_url || ch.avatarUrl || null,
                subscriber_count: ch.subscriber_count || ch.subscriberCount || 0,
                average_views: ch.average_views || ch.averageViews || 0,
                recent_average: ch.recent_average != null ? ch.recent_average : (ch.recentAverage != null ? ch.recentAverage : null),
                video_count: ch.video_count || ch.videoCount || 0,
                view_to_sub_ratio: ch.view_to_sub_ratio || ch.viewToSubRatio || 0,
                enhanced: !!ch.enhanced,
                recent_shorts_count: (ch.recent_shorts || ch.recentShorts || []).length
            });
        }
    }
    return { byKeyword: byKeyword, samples: samples };
}

async function postBulkChunked(channels) {
    var chunkSize = 40;
    var inserted = 0;
    for (var i = 0; i < channels.length; i += chunkSize) {
        var chunk = channels.slice(i, i + chunkSize);
        var bulk = await postBulk(chunk);
        inserted += (bulk && (bulk.inserted || bulk.added || bulk.count)) || chunk.length;
        await delay(300);
    }
    return { inserted: inserted };
}

function appBases() {
    var bases = [];
    if (APP_INTERNAL_URL) bases.push(APP_INTERNAL_URL);
    if (APP_URL && APP_URL !== APP_INTERNAL_URL) bases.push(APP_URL);
    return bases;
}

async function postBulk(channels) {
    var bases = appBases();
    if (!bases.length || !channels.length) return { inserted: 0 };
    var lastErr = null;
    for (var b = 0; b < bases.length; b++) {
        try {
            const res = await fetch(bases[b] + '/api/channels/bulk', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Worker-Secret': process.env.WORKER_SECRET || ''
                },
                body: JSON.stringify({ channels: channels })
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error('bulk upload failed: ' + res.status + ' ' + text);
            }
            return res.json();
        } catch (e) {
            lastErr = e;
            console.warn('Bulk via', bases[b], 'failed:', e.message);
        }
    }
    throw lastErr || new Error('bulk upload failed');
}

async function upsertNewNichesFeed(db, keywords) {
    var collection = await db.collection('collections').findOne({ name: 'New Niches', system: true });
    if (!collection) {
        var inserted = await db.collection('collections').insertOne({
            name: 'New Niches',
            description: 'Auto-rotated niches from the 3-day scraper',
            system: true,
            created_at: new Date(),
            updated_at: new Date()
        });
        collection = { _id: inserted.insertedId };
    }
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

async function main() {
    if (!RUN_ID) throw new Error('RUN_ID required');
    if (!MONGODB_URI) throw new Error('MONGODB_URI required');

    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(MONGODB_DB);
    console.log('Connected Mongo db:', MONGODB_DB, 'run:', RUN_ID);

    const run = await db.collection('scrape_runs').findOne({ _id: new ObjectId(RUN_ID) });
    if (!run) throw new Error('scrape_runs not found in ' + MONGODB_DB + ': ' + RUN_ID);

    await db.collection('scrape_runs').updateOne(
        { _id: run._id },
        { $set: { status: 'processing', worker: 'fly-puppeteer', startedAt: new Date() } }
    );

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });

    let all = [];
    const keywords = run.keywords || [];
    const screenshotDir = '/tmp/scrape-screens';
    fs.mkdirSync(screenshotDir, { recursive: true });

    try {
        for (let i = 0; i < keywords.length; i++) {
            const kw = keywords[i];
            try {
                const batch = await scrapeKeyword(page, kw);
                console.log('Keyword', kw, '→', batch.length, 'channels');
                all = all.concat(batch.map(function(c) {
                    return Object.assign({}, c, { niche_keyword: kw });
                }));
            } catch (kwErr) {
                console.error('Keyword failed', kw, kwErr.message);
                try {
                    await page.screenshot({ path: path.join(screenshotDir, 'fail-' + kw + '.png'), fullPage: true });
                } catch (e) { /* ignore */ }
            }
            await delay(1500);
        }
    } finally {
        await browser.close();
    }

    // Dedupe by channel_url
    const seen = {};
    const unique = [];
    for (let i = 0; i < all.length; i++) {
        const url = all[i].channel_url;
        if (!url || seen[url]) continue;
        seen[url] = true;
        unique.push(all[i]);
    }

    if (!YOUTUBE_API_KEY) {
        throw new Error('YOUTUBE_API_KEY missing — cannot enrich channels (subs/ratio/enhanced)');
    }

    const minViewThreshold = parseInt(process.env.SCRAPE_MIN_VIEW_THRESHOLD || '0', 10) || 0;
    const enhancedAnalysis = process.env.SCRAPE_ENHANCED_ANALYSIS !== '0';
    // Default OFF so Niche Finder Enhanced / Recent Avg / Active Recently have data
    const enhancedStrict = process.env.SCRAPE_ENHANCED_STRICT === '1';

    await db.collection('scrape_runs').updateOne(
        { _id: run._id },
        {
            $set: {
                enrichPhase: 'subscribers',
                channelsScraped: unique.length,
                minViewThreshold: minViewThreshold,
                enhancedAnalysis: enhancedAnalysis,
                enhancedStrict: enhancedStrict
            }
        }
    );

    // Full extension pipeline: subs → enhanced (recent_average + recent_shorts) → filter → bulk
    const enriched = await enrichChannelsFull(unique, {
        apiKey: YOUTUBE_API_KEY,
        minViewThreshold: minViewThreshold,
        enhancedAnalysis: enhancedAnalysis,
        enhancedStrict: enhancedStrict,
        scrapeRunId: String(run._id),
        onProgress: async function(p) {
            try {
                await db.collection('scrape_runs').updateOne(
                    { _id: run._id },
                    {
                        $set: {
                            enrichPhase: p.phase,
                            enrichProgress: p.done + '/' + p.total
                        }
                    }
                );
            } catch (e) { /* ignore */ }
        }
    });

    const summary = summarizeChannels(enriched);

    let upserted = 0;
    try {
        const bulk = await postBulkChunked(enriched);
        upserted = (bulk && bulk.inserted) || enriched.length;
    } catch (bulkErr) {
        console.warn('Bulk API failed, writing directly:', bulkErr.message);
        for (let i = 0; i < enriched.length; i++) {
            const ch = enriched[i];
            const url = ch.channel_url || ch.channelUrl;
            const existing = await db.collection('channels').findOne({ channel_url: url });
            if (!existing) {
                await db.collection('channels').insertOne({
                    channel_name: ch.channel_name || ch.channelName,
                    channel_url: url,
                    video_title: ch.video_title || ch.videoTitle || '',
                    view_count: ch.view_count || ch.viewCount || 0,
                    subscriber_count: ch.subscriber_count || ch.subscriberCount || 0,
                    view_to_sub_ratio: ch.view_to_sub_ratio || ch.viewToSubRatio || 0,
                    avatar_url: ch.avatar_url || ch.avatarUrl || null,
                    thumbnail_url: ch.thumbnail_url || ch.thumbnailUrl || null,
                    video_url: ch.video_url || ch.videoUrl || null,
                    total_views: ch.total_views || ch.totalViews || 0,
                    video_count: ch.video_count || ch.videoCount || 0,
                    average_views: ch.average_views || ch.averageViews || 0,
                    enhanced: !!ch.enhanced,
                    recent_average: ch.recent_average || ch.recentAverage || null,
                    videos_analyzed: ch.videos_analyzed || ch.videosAnalyzed || null,
                    recent_shorts: ch.recent_shorts || ch.recentShorts || null,
                    last_enhanced_update: ch.last_enhanced_update || ch.lastUpdated || null,
                    niche_keyword: ch.niche_keyword || null,
                    scrape_run_id: String(run._id),
                    source: 'fly-scraper',
                    status: 'pending',
                    created_at: new Date(),
                    updated_at: new Date()
                });
                upserted++;
            } else {
                var preserveStatus = existing.status === 'approved' || existing.status === 'rejected';
                await db.collection('channels').updateOne(
                    { _id: existing._id },
                    {
                        $set: {
                            channel_name: ch.channel_name || ch.channelName || existing.channel_name,
                            video_title: ch.video_title || ch.videoTitle || existing.video_title,
                            view_count: ch.view_count || ch.viewCount || 0,
                            subscriber_count: ch.subscriber_count || ch.subscriberCount || 0,
                            view_to_sub_ratio: ch.view_to_sub_ratio || ch.viewToSubRatio || 0,
                            avatar_url: ch.avatar_url || ch.avatarUrl || existing.avatar_url,
                            thumbnail_url: ch.thumbnail_url || ch.thumbnailUrl || existing.thumbnail_url,
                            total_views: ch.total_views || ch.totalViews || 0,
                            video_count: ch.video_count || ch.videoCount || 0,
                            average_views: ch.average_views || ch.averageViews || 0,
                            enhanced: !!ch.enhanced,
                            recent_average: ch.recent_average || ch.recentAverage || null,
                            videos_analyzed: ch.videos_analyzed || ch.videosAnalyzed || null,
                            recent_shorts: ch.recent_shorts || ch.recentShorts || null,
                            last_enhanced_update: ch.last_enhanced_update || ch.lastUpdated || null,
                            niche_keyword: ch.niche_keyword || existing.niche_keyword,
                            scrape_run_id: String(run._id),
                            source: 'fly-scraper',
                            updated_at: new Date(),
                            ...(preserveStatus ? {} : { status: 'pending' })
                        }
                    }
                );
                upserted++;
            }
        }
    }

    await db.collection('niche_rotations').insertOne({
        keywords: keywords,
        scrapeRunId: run._id,
        createdAt: new Date(),
        channelsFound: unique.length,
        channelsUpserted: upserted,
        byKeyword: summary.byKeyword
    });

    try {
        await upsertNewNichesFeed(db, keywords);
    } catch (feedErr) {
        console.warn('New Niches feed update failed:', feedErr.message);
    }

    const enhancedSaved = enriched.filter(function(ch) {
        return ch.enhanced && (ch.recent_average != null || ch.recentAverage != null);
    }).length;

    await db.collection('scrape_runs').updateOne(
        { _id: run._id },
        {
            $set: {
                status: 'complete',
                finishedAt: new Date(),
                enrichPhase: 'done',
                channelsFound: unique.length,
                channelsQualified: enriched.length,
                channelsEnhanced: enhancedSaved,
                channelsUpserted: upserted,
                byKeyword: summary.byKeyword,
                channelSamples: summary.samples
            }
        }
    );

    console.log(
        'Scrape complete:', unique.length, 'scraped →',
        enriched.length, 'qualified →', enhancedSaved, 'enhanced →',
        upserted, 'upserted'
    );
    await client.close();
}

main().catch(async function(err) {
    console.error('Scraper failed:', err);
    try {
        if (MONGODB_URI && RUN_ID) {
            const client = new MongoClient(MONGODB_URI);
            await client.connect();
            await client.db(MONGODB_DB).collection('scrape_runs').updateOne(
                { _id: new ObjectId(RUN_ID) },
                { $set: { status: 'failed', error: err.message, finishedAt: new Date() } }
            );
            await client.close();
        }
    } catch (e) { /* ignore */ }
    process.exit(1);
});
