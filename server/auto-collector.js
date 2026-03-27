/**
 * Auto Channel Collector — runs daily at 6 AM UTC
 * Searches YouTube for Shorts channels using randomized keywords,
 * fetches channel stats, and inserts them into the database.
 */

const axios = require('axios');

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

// Word pool — common short words that appear in Shorts titles
const WORD_POOL = [
    // Prepositions & connectors
    'in', 'on', 'at', 'by', 'for', 'with', 'from', 'of', 'to', 'into',
    'onto', 'over', 'under', 'about', 'after', 'before', 'between',
    // Action words
    'go', 'why', 'how', 'she', 'did', 'her', 'make', 'get', 'can', 'will',
    'try', 'use', 'put', 'run', 'see', 'let', 'say', 'ask', 'give', 'take',
    // Descriptors
    'new', 'best', 'top', 'easy', 'quick', 'simple', 'big', 'fast', 'real',
    'free', 'full', 'hard', 'long', 'old', 'hot', 'cool', 'dark', 'wild',
    // Viral bait
    'never', 'always', 'only', 'just', 'most', 'every', 'first', 'last',
    'secret', 'hidden', 'crazy', 'insane', 'epic', 'worst', 'rare',
    // Niches
    'food', 'life', 'work', 'home', 'body', 'money', 'game', 'world',
    'day', 'night', 'time', 'way', 'part', 'side', 'end', 'back'
];

function pickDailyKeywords(count) {
    // Always start with 'ranking'
    var keywords = ['ranking'];
    // Shuffle pool and pick (count - 1) more
    var pool = WORD_POOL.slice();
    for (var i = pool.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    for (var k = 0; k < Math.min(count - 1, pool.length); k++) {
        keywords.push(pool[k]);
    }
    return keywords;
}

function parseDuration(duration) {
    if (!duration) return 0;
    var match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;
    return (parseInt(match[1] || 0) * 3600) + (parseInt(match[2] || 0) * 60) + parseInt(match[3] || 0);
}

// Quality thresholds — matching the extension's filtering logic
var MIN_AVERAGE_VIEWS = 10000;   // Channel must have 10K+ average views
var MIN_VIDEO_VIEW_COUNT = 5000; // The representative video must have 5K+ views
var MAX_SHORT_DURATION = 60;     // True Shorts are ≤ 60 seconds

/**
 * Check if a channel qualifies based on the extension's tiered filtering.
 * Small channels (<100K subs) need ratio ≥ 1.0
 * Medium channels (100K-1M subs) need ratio ≥ 0.5
 * Large channels (1M+ subs) need ratio ≥ 0.1
 */
function isQualifiedChannel(channel) {
    var avgViews = channel.average_views || 0;
    var subs = channel.subscriber_count || 0;
    var ratio = channel.view_to_sub_ratio || 0;
    var videoViews = channel.view_count || 0;

    // Must meet minimum average views
    if (avgViews < MIN_AVERAGE_VIEWS) return false;

    // Must have a decent representative video
    if (videoViews < MIN_VIDEO_VIEW_COUNT) return false;

    // Tiered ratio check
    if (subs < 100000) return ratio >= 1.0;
    if (subs < 1000000) return ratio >= 0.5;
    return ratio >= 0.1;
}

/**
 * Search YouTube for Shorts videos by keyword, extract unique channels,
 * fetch their stats, and return channel docs ready for DB insertion.
 */
async function searchAndCollect(keyword, apiKey, maxResults) {
    maxResults = maxResults || 50;
    var searchQuery = '*' + keyword + '*'; // asterisk wrapping like the extension
    var channels = new Map(); // channelId -> channel data

    try {
        // Step 1: Search for short videos
        var searchParams = {
            part: 'snippet',
            q: searchQuery,
            type: 'video',
            videoDuration: 'short', // Only Shorts (<4 min, mostly <60s)
            order: 'viewCount',
            maxResults: maxResults,
            key: apiKey
        };
        var searchRes = await axios.get(YOUTUBE_API_BASE + '/search', { params: searchParams, timeout: 15000 });
        var items = searchRes.data.items || [];
        if (items.length === 0) return [];

        // Collect unique channel IDs and video IDs
        var videoIds = [];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            var chId = item.snippet.channelId;
            var vidId = item.id.videoId;
            videoIds.push(vidId);
            if (!channels.has(chId)) {
                channels.set(chId, {
                    channelId: chId,
                    channelName: item.snippet.channelTitle,
                    channelUrl: 'https://www.youtube.com/channel/' + chId,
                    videos: []
                });
            }
            channels.get(chId).videos.push({
                videoId: vidId,
                title: item.snippet.title,
                viewCount: 0 // filled in step 2
            });
        }

        // Step 2: Get video details (views + duration) to confirm they're actual Shorts
        var vidBatches = [];
        var allVidIds = videoIds;
        for (var b = 0; b < allVidIds.length; b += 50) {
            vidBatches.push(allVidIds.slice(b, b + 50));
        }
        var videoStats = {};
        for (var vb = 0; vb < vidBatches.length; vb++) {
            try {
                var vRes = await axios.get(YOUTUBE_API_BASE + '/videos', {
                    params: { part: 'statistics,contentDetails', id: vidBatches[vb].join(','), key: apiKey },
                    timeout: 15000
                });
                var vItems = vRes.data.items || [];
                for (var vi = 0; vi < vItems.length; vi++) {
                    var v = vItems[vi];
                    var dur = parseDuration(v.contentDetails.duration);
                    videoStats[v.id] = {
                        viewCount: parseInt(v.statistics.viewCount || 0),
                        duration: dur,
                        isShort: dur <= MAX_SHORT_DURATION // True Shorts: ≤ 60 seconds
                    };
                }
            } catch (e) {
                console.warn('Auto-collector: video stats batch error:', e.message);
            }
        }

        // Update channel video data with actual stats, filter non-shorts
        for (var [chId, chData] of channels) {
            chData.videos = chData.videos.filter(function(vid) {
                var stats = videoStats[vid.videoId];
                if (stats && stats.isShort) {
                    vid.viewCount = stats.viewCount;
                    return true;
                }
                return false;
            });
            // Remove channels with no qualifying shorts
            if (chData.videos.length === 0) channels.delete(chId);
        }

        // Step 3: Get channel statistics (subscribers, total views, video count)
        var chIds = Array.from(channels.keys());
        for (var cb = 0; cb < chIds.length; cb += 50) {
            var chBatch = chIds.slice(cb, cb + 50);
            try {
                var chRes = await axios.get(YOUTUBE_API_BASE + '/channels', {
                    params: { part: 'statistics,snippet', id: chBatch.join(','), key: apiKey },
                    timeout: 15000
                });
                var chItems = chRes.data.items || [];
                for (var ci = 0; ci < chItems.length; ci++) {
                    var ch = chItems[ci];
                    var chInfo = channels.get(ch.id);
                    if (chInfo) {
                        chInfo.subscriberCount = parseInt(ch.statistics.subscriberCount || 0);
                        chInfo.totalViews = parseInt(ch.statistics.viewCount || 0);
                        chInfo.videoCount = parseInt(ch.statistics.videoCount || 0);
                        chInfo.averageViews = chInfo.videoCount > 0 ? Math.round(chInfo.totalViews / chInfo.videoCount) : 0;
                        chInfo.avatarUrl = ch.snippet.thumbnails?.default?.url || null;
                    }
                }
            } catch (e) {
                console.warn('Auto-collector: channel stats batch error:', e.message);
            }
        }

        // Step 4: Build channel docs for DB insertion
        var results = [];
        for (var [chId, chData] of channels) {
            // Pick the highest-viewed video as the representative
            var bestVideo = chData.videos.sort(function(a, b) { return b.viewCount - a.viewCount; })[0];
            var subCount = chData.subscriberCount || 0;
            var ratio = subCount > 0 ? bestVideo.viewCount / subCount : 0;

            results.push({
                channel_name: chData.channelName,
                channel_url: chData.channelUrl,
                video_title: bestVideo.title,
                view_count: bestVideo.viewCount,
                subscriber_count: subCount,
                view_to_sub_ratio: Math.round(ratio * 100) / 100,
                avatar_url: chData.avatarUrl || null,
                total_views: chData.totalViews || 0,
                video_count: chData.videoCount || 0,
                average_views: chData.averageViews || 0,
                enhanced: false,
                status: 'pending',
                created_at: new Date(),
                updated_at: new Date(),
                source: 'auto-collector'
            });
        }

        return results;
    } catch (err) {
        console.error('Auto-collector: search error for "' + keyword + '":', err.message);
        return [];
    }
}

/**
 * Main daily collection run.
 * Picks 30 keywords, searches each, deduplicates, inserts into DB.
 */
async function runDailyCollection(db) {
    var apiKey = process.env.YOUTUBE_API_KEY || 'AIzaSyBOJg1zOs4STy1MJdqdiFKnKzAUyNa-LdU';
    var keywords = pickDailyKeywords(30);
    var startTime = Date.now();

    console.log('🤖 Auto-collector: Starting daily run with ' + keywords.length + ' keywords');
    console.log('🤖 Keywords: ' + keywords.join(', '));

    var allChannels = [];
    var seenUrls = new Set();
    var keywordsDone = 0;

    for (var i = 0; i < keywords.length; i++) {
        var keyword = keywords[i];
        console.log('🤖 [' + (i + 1) + '/' + keywords.length + '] Searching: *' + keyword + '*');

        try {
            var results = await searchAndCollect(keyword, apiKey, 50);
            var newCount = 0;
            for (var r = 0; r < results.length; r++) {
                if (!seenUrls.has(results[r].channel_url)) {
                    seenUrls.add(results[r].channel_url);
                    allChannels.push(results[r]);
                    newCount++;
                }
            }
            keywordsDone++;
            console.log('🤖   Found ' + results.length + ' channels, ' + newCount + ' new (total: ' + allChannels.length + ')');
        } catch (err) {
            console.error('🤖   Error on keyword "' + keyword + '":', err.message);
        }

        // Small delay between keywords to respect API rate limits
        if (i < keywords.length - 1) {
            await new Promise(function(resolve) { setTimeout(resolve, 1500); });
        }
    }

    // Quality filter — match the extension's standards
    var qualified = allChannels.filter(isQualifiedChannel);
    var filtered = allChannels.length - qualified.length;
    console.log('🤖 Auto-collector: Quality filter — ' + qualified.length + ' qualified, ' + filtered + ' filtered out (need ' + (MIN_AVERAGE_VIEWS/1000) + 'K+ avg views + ratio check)');

    // Insert qualified channels into database
    var inserted = 0;
    var skipped = 0;
    for (var c = 0; c < qualified.length; c++) {
        try {
            await db.collection('channels').replaceOne(
                { channel_url: qualified[c].channel_url },
                qualified[c],
                { upsert: true }
            );
            inserted++;
        } catch (err) {
            skipped++;
        }
    }

    var duration = Math.round((Date.now() - startTime) / 1000 / 60);
    console.log('🤖 Auto-collector: DONE in ' + duration + 'min — ' + allChannels.length + ' found, ' + qualified.length + ' qualified, ' + inserted + ' saved, ' + skipped + ' errors, ' + keywordsDone + '/' + keywords.length + ' keywords');

    return { found: allChannels.length, qualified: qualified.length, inserted: inserted, skipped: skipped, keywords: keywordsDone, duration: duration };
}

/**
 * Schedule daily run. Call this once from server.js after DB is connected.
 * Runs at 6:00 AM UTC every day.
 */
function scheduleDailyCollection(db) {
    function msUntilNext6AM() {
        var now = new Date();
        var next = new Date(now);
        next.setUTCHours(6, 0, 0, 0);
        if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
        return next.getTime() - now.getTime();
    }

    function scheduleNext() {
        var ms = msUntilNext6AM();
        var hours = Math.round(ms / 1000 / 60 / 60 * 10) / 10;
        console.log('🤖 Auto-collector: Next run in ' + hours + ' hours');
        setTimeout(function() {
            runDailyCollection(db).catch(function(err) {
                console.error('🤖 Auto-collector: Daily run failed:', err.message);
            }).finally(function() {
                scheduleNext();
            });
        }, ms);
    }

    console.log('🤖 Auto-collector: Scheduler initialized (daily at 6:00 AM UTC)');
    scheduleNext();
}

module.exports = { runDailyCollection, scheduleDailyCollection };
