/**
 * Fly Machine Puppeteer scraper — ports Chrome extension Start loop.
 *
 * Env: RUN_ID, APP_URL, MONGODB_URI, WORKER_SECRET, YOUTUBE_API_KEY
 */
const path = require('path');
const fs = require('fs');
const { MongoClient, ObjectId } = require('mongodb');
const puppeteer = require('puppeteer');

const RUN_ID = process.env.RUN_ID;
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const APP_INTERNAL_URL = (process.env.APP_INTERNAL_URL || '').replace(/\/$/, '');
const MONGODB_URI = process.env.MONGODB_URI || process.env.V2_MONGO_URI || process.env.MONGO_URI;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY || '';
const SCROLL_COUNT = parseInt(process.env.SCRAPE_SCROLL_COUNT || '25', 10);
const MAX_CHANNELS_PER_KEYWORD = parseInt(process.env.SCRAPE_MAX_CHANNELS || '40', 10);

function delay(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

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

    // Click Shorts chip
    await page.evaluate(function() {
        var chipCloud = document.querySelector('yt-chip-cloud-renderer');
        if (!chipCloud) return;
        var chips = chipCloud.querySelectorAll('yt-chip-cloud-chip-renderer');
        for (var i = 0; i < chips.length; i++) {
            var text = (chips[i].textContent || '').trim().toLowerCase();
            if (text === 'shorts') {
                var btn = chips[i].querySelector('button, a, #chip-shape, .ytChipShapeButtonReset') || chips[i];
                btn.click();
                return;
            }
        }
    });
    await delay(2000);

    // Scroll
    for (var s = 0; s < SCROLL_COUNT; s++) {
        await page.evaluate(function() { window.scrollTo(0, document.documentElement.scrollHeight); });
        await delay(1200);
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
            if (out.length >= channelLimit) break;
            var video = items[i];
            try {
                var titleEl = video.querySelector('a#video-title') ||
                    video.querySelector('a[title]') ||
                    video.querySelector('h3 a') ||
                    video.querySelector('.reel-item-endpoint');
                var channelEl = video.querySelector('ytd-channel-name a') ||
                    video.querySelector('a[href*="/@"]') ||
                    video.querySelector('a[href*="/channel/"]');
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
                var img = video.querySelector('img[src*="ytimg"]');
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

async function enrichWithApi(channels, scrapeRunId) {
    // Keep scraped fields; bulk API accepts snake_case + camelCase
    return channels.map(function(ch) {
        return {
            channel_name: ch.channel_name,
            channel_url: ch.channel_url,
            channelName: ch.channel_name,
            channelUrl: ch.channel_url,
            video_title: ch.video_title,
            videoTitle: ch.video_title,
            view_count: ch.view_count || 0,
            viewCount: ch.view_count || 0,
            subscriber_count: 0,
            view_to_sub_ratio: 0,
            avatar_url: ch.thumbnail_url || null,
            avatarUrl: ch.thumbnail_url || null,
            thumbnail_url: ch.thumbnail_url || null,
            thumbnailUrl: ch.thumbnail_url || null,
            video_url: ch.video_url || null,
            videoUrl: ch.video_url || null,
            total_views: 0,
            video_count: 0,
            average_views: ch.view_count || 0,
            enhanced: false,
            status: 'pending',
            niche_keyword: ch.niche_keyword || null,
            scrape_run_id: scrapeRunId || null,
            scrapeRunId: scrapeRunId || null,
            created_at: new Date(),
            updated_at: new Date(),
            source: 'fly-scraper'
        };
    });
}

function summarizeChannels(channels) {
    var byKeyword = {};
    var samples = [];
    for (var i = 0; i < channels.length; i++) {
        var ch = channels[i];
        var kw = ch.niche_keyword || 'unknown';
        byKeyword[kw] = (byKeyword[kw] || 0) + 1;
        if (samples.length < 250) {
            samples.push({
                channel_name: ch.channel_name,
                channel_url: ch.channel_url,
                niche_keyword: kw,
                view_count: ch.view_count || 0,
                video_title: ch.video_title || '',
                thumbnail_url: ch.thumbnail_url || null
            });
        }
    }
    return { byKeyword: byKeyword, samples: samples };
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
    const db = client.db();

    const run = await db.collection('scrape_runs').findOne({ _id: new ObjectId(RUN_ID) });
    if (!run) throw new Error('scrape_runs not found: ' + RUN_ID);

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

    const enriched = await enrichWithApi(unique, String(run._id));
    const summary = summarizeChannels(unique);

    // Prefer bulk API; also upsert directly as backup
    let upserted = 0;
    try {
        const bulk = await postBulk(enriched);
        upserted = (bulk && (bulk.inserted || bulk.added || bulk.count)) || enriched.length;
    } catch (bulkErr) {
        console.warn('Bulk API failed, writing directly:', bulkErr.message);
        for (let i = 0; i < enriched.length; i++) {
            const ch = enriched[i];
            const existing = await db.collection('channels').findOne({ channel_url: ch.channel_url });
            if (!existing) {
                await db.collection('channels').insertOne(ch);
                upserted++;
            } else {
                await db.collection('channels').updateOne(
                    { _id: existing._id },
                    {
                        $set: {
                            scrape_run_id: String(run._id),
                            niche_keyword: ch.niche_keyword || existing.niche_keyword,
                            source: 'fly-scraper',
                            updated_at: new Date()
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

    await db.collection('scrape_runs').updateOne(
        { _id: run._id },
        {
            $set: {
                status: 'complete',
                finishedAt: new Date(),
                channelsFound: unique.length,
                channelsUpserted: upserted,
                byKeyword: summary.byKeyword,
                channelSamples: summary.samples
            }
        }
    );

    console.log('Scrape complete:', unique.length, 'found,', upserted, 'upserted');
    await client.close();
}

main().catch(async function(err) {
    console.error('Scraper failed:', err);
    try {
        if (MONGODB_URI && RUN_ID) {
            const client = new MongoClient(MONGODB_URI);
            await client.connect();
            await client.db().collection('scrape_runs').updateOne(
                { _id: new ObjectId(RUN_ID) },
                { $set: { status: 'failed', error: err.message, finishedAt: new Date() } }
            );
            await client.close();
        }
    } catch (e) { /* ignore */ }
    process.exit(1);
});
