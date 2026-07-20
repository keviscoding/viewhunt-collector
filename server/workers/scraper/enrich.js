/**
 * Full post-scrape enrichment — mirrors Chrome extension background.js:
 * 1) Resolve channel IDs (zero-quota handle scrape)
 * 2) YouTube Data API: subscribers, totals, average views, avatar, view/sub ratio
 * 3) Enhanced analysis: recent Shorts + calculateEnhancedMetrics (viral/trimmed mean)
 * 4) Min average-views threshold filter
 */
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
// Docker image copies this next to enrich.js; local/dev uses server/lib/
var calculateEnhancedMetrics;
try {
    calculateEnhancedMetrics = require('./calculate-enhanced-metrics').calculateEnhancedMetrics;
} catch (e) {
    calculateEnhancedMetrics = require('../../lib/calculate-enhanced-metrics').calculateEnhancedMetrics;
}

function delay(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function parseDuration(duration) {
    if (!duration) return 0;
    var match = String(duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;
    return (parseInt(match[1] || 0, 10) * 3600) +
        (parseInt(match[2] || 0, 10) * 60) +
        parseInt(match[3] || 0, 10);
}

async function getChannelIdFromHandle(handleUrl, apiKey) {
    // Prefer YouTube forHandle (low memory) over downloading full channel HTML
    try {
        var handleMatch = String(handleUrl).match(/\/@([^/?#]+)/);
        if (handleMatch && apiKey) {
            var handle = decodeURIComponent(handleMatch[1]);
            var apiRes = await fetch(
                YOUTUBE_API_BASE + '/channels?part=id&forHandle=' + encodeURIComponent(handle) + '&key=' + apiKey
            );
            if (apiRes.ok) {
                var apiData = await apiRes.json();
                if (apiData.items && apiData.items[0] && apiData.items[0].id) {
                    return apiData.items[0].id;
                }
            }
        }
    } catch (e) {
        console.warn('forHandle resolve failed:', e.message);
    }

    try {
        const response = await fetch(handleUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            }
        });
        if (!response.ok) return null;
        const html = await response.text();

        var match = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[^"]+)"/);
        if (match) return match[1];

        match = html.match(/"@type":"Person"[^}]*"identifier":"(UC[^"]+)"/);
        if (match) return match[1];

        match = html.match(/ytInitialData[^{]*{[^}]*"channelId":"(UC[^"]+)"/);
        if (match) return match[1];

        match = html.match(/<meta property="og:url" content="https:\/\/www\.youtube\.com\/channel\/(UC[^"]+)"/);
        if (match) return match[1];

        match = html.match(/"channelId":"(UC[^"]+)"/);
        if (match) return match[1];

        return null;
    } catch (e) {
        console.warn('Handle resolve failed:', handleUrl, e.message);
        return null;
    }
}

async function resolveChannelId(channelUrl, apiKey) {
    if (!channelUrl) return null;
    if (channelUrl.indexOf('/channel/UC') >= 0) {
        return channelUrl.split('/channel/')[1].split('/')[0].split('?')[0];
    }
    if (channelUrl.indexOf('/@') >= 0) {
        return getChannelIdFromHandle(channelUrl, apiKey);
    }
    return null;
}

async function processBatchStats(channels, apiKey) {
    for (var i = 0; i < channels.length; i++) {
        var ch = channels[i];
        if (ch.channelUrl && ch.channelUrl.indexOf('/@') >= 0) {
            ch.realChannelId = await getChannelIdFromHandle(ch.channelUrl, apiKey);
        } else if (ch.channelUrl && ch.channelUrl.indexOf('/channel/UC') >= 0) {
            var id = ch.channelUrl.split('/channel/')[1].split('/')[0].split('?')[0];
            if (id && id.indexOf('UC') === 0) ch.realChannelId = id;
        }
        await delay(50);
    }

    var withIds = channels.filter(function(c) { return c.realChannelId; });
    if (!withIds.length || !apiKey) {
        channels.forEach(function(c) {
            if (c.subscriberCount === undefined) {
                c.subscriberCount = 0;
                c.totalViews = 0;
                c.videoCount = 0;
                c.averageViews = 0;
            }
        });
        return;
    }

    // YouTube allows up to 50 ids per channels.list call
    for (var b = 0; b < withIds.length; b += 50) {
        var slice = withIds.slice(b, b + 50);
        var ids = slice.map(function(c) { return c.realChannelId; }).join(',');
        try {
            var res = await fetch(
                YOUTUBE_API_BASE + '/channels?part=statistics,snippet&id=' + ids + '&key=' + apiKey
            );
            if (!res.ok) {
                var errBody = await res.text();
                console.error('channels.list failed:', res.status, errBody.slice(0, 300));
            } else {
                var data = await res.json();
                (data.items || []).forEach(function(item) {
                    var subscriberCount = parseInt(item.statistics.subscriberCount || 0, 10);
                    var totalViews = parseInt(item.statistics.viewCount || 0, 10);
                    var videoCount = parseInt(item.statistics.videoCount || 0, 10);
                    var averageViews = videoCount > 0 ? Math.round(totalViews / videoCount) : 0;
                    var thumbs = item.snippet && item.snippet.thumbnails;
                    var avatarUrl = (thumbs && (thumbs.medium || thumbs.high || thumbs.default || {}).url) || null;
                    var info = slice.find(function(c) { return c.realChannelId === item.id; });
                    if (info) {
                        info.subscriberCount = subscriberCount;
                        info.totalViews = totalViews;
                        info.videoCount = videoCount;
                        info.averageViews = averageViews;
                        info.avatarUrl = avatarUrl;
                    }
                });
            }
        } catch (e) {
            console.error('channels.list error:', e.message);
        }
        await delay(300);
    }

    channels.forEach(function(c) {
        if (c.subscriberCount === undefined) {
            c.subscriberCount = 0;
            c.totalViews = 0;
            c.videoCount = 0;
            c.averageViews = 0;
        }
    });
}

/**
 * Enrich scraped video→channel rows with subscriber stats (extension processSubscriberData).
 * Input: [{ channel_name, channel_url, video_title, view_count, thumbnail_url, niche_keyword }]
 * Processes the full set passed in — callers batch for memory; we never drop channels here.
 */
async function enrichSubscriberData(scraped, apiKey, onProgress) {
    if (!apiKey) {
        throw new Error('YOUTUBE_API_KEY required for subscriber enrichment');
    }

    var unique = new Map();
    scraped.forEach(function(video) {
        var url = video.channel_url || video.channelUrl;
        if (!url) return;
        if (!unique.has(url)) {
            unique.set(url, {
                channelName: video.channel_name || video.channelName,
                channelUrl: url,
                niche_keyword: video.niche_keyword || null,
                videoTitle: video.video_title || video.videoTitle || '',
                viewCount: video.view_count || video.viewCount || 0,
                thumbnailUrl: video.thumbnail_url || video.thumbnailUrl || null,
                videoUrl: video.video_url || video.videoUrl || null
            });
            return;
        }
        var entry = unique.get(url);
        // Keep highest-view short as the representative row
        var v = video.view_count || video.viewCount || 0;
        if (v >= (entry.viewCount || 0)) {
            entry.viewCount = v;
            entry.videoTitle = video.video_title || video.videoTitle || entry.videoTitle;
            entry.thumbnailUrl = video.thumbnail_url || video.thumbnailUrl || entry.thumbnailUrl;
            entry.videoUrl = video.video_url || video.videoUrl || entry.videoUrl;
            entry.niche_keyword = video.niche_keyword || entry.niche_keyword;
        }
    });

    var channelArray = Array.from(unique.values());
    console.log('Enrich: resolving stats for', channelArray.length, 'channels');

    var batchSize = 10;
    for (var i = 0; i < channelArray.length; i += batchSize) {
        var batch = channelArray.slice(i, i + batchSize);
        if (onProgress) {
            await onProgress({
                phase: 'subscribers',
                done: Math.min(i + batchSize, channelArray.length),
                total: channelArray.length
            });
        }
        await processBatchStats(batch, apiKey);
        await delay(400);
    }

    var results = channelArray.map(function(info) {
        var subscriberCount = info.subscriberCount || 0;
        var viewCount = info.viewCount || 0;
        var viewToSubRatio = subscriberCount > 0 ? (viewCount / subscriberCount) : 0;
        return {
            channelName: info.channelName,
            channelUrl: info.channelUrl,
            videoTitle: info.videoTitle,
            viewCount: viewCount,
            subscriberCount: subscriberCount,
            viewToSubRatio: viewToSubRatio,
            avatarUrl: info.avatarUrl || info.thumbnailUrl || null,
            thumbnailUrl: info.thumbnailUrl || null,
            videoUrl: info.videoUrl || null,
            totalViews: info.totalViews || 0,
            videoCount: info.videoCount || 0,
            averageViews: info.averageViews || 0,
            niche_keyword: info.niche_keyword || null,
            realChannelId: info.realChannelId || null,
            enhanced: false
        };
    });

    results.sort(function(a, b) { return (b.viewToSubRatio || 0) - (a.viewToSubRatio || 0); });
    return results;
}

/**
 * Who gets enhanced (recent_average + recent_shorts)?
 * Default: every channel we resolved + that clears min avg-views threshold.
 * That powers Niche Finder: Enhanced Only, Recent Avg range, Active Recently.
 *
 * Set SCRAPE_ENHANCED_STRICT=1 to use the old extension tiered ratio gates
 * (saves YouTube quota, but leaves many channels without recent_average).
 */
function shouldRunEnhancedAnalysis(channel, minViewThreshold, strict) {
    var subs = channel.subscriberCount || 0;
    var avgViews = channel.averageViews || 0;
    var ratio = channel.viewToSubRatio || 0;
    var threshold = minViewThreshold || 0;

    if (!channel.realChannelId && !channel.channelUrl) return false;
    if (avgViews < threshold) return false;

    if (!strict) {
        // Need a resolvable channel to pull uploads playlist
        return !!(channel.realChannelId || channel.channelUrl);
    }

    // Legacy extension tiered filters
    if (subs < 100000) {
        return ratio >= 1.0 && avgViews >= threshold;
    }
    if (subs < 1000000) {
        return ratio >= 0.5 && avgViews >= threshold;
    }
    return ratio >= 0.1 && avgViews >= threshold;
}

async function getEnhancedChannelDataYouTube(channel, apiKey) {
    try {
        var channelId = channel.realChannelId || await resolveChannelId(channel.channelUrl, apiKey);
        if (!channelId) return null;

        var channelResponse = await fetch(
            YOUTUBE_API_BASE + '/channels?part=statistics,contentDetails,snippet&id=' + channelId + '&key=' + apiKey
        );
        if (!channelResponse.ok) return null;
        var channelData = await channelResponse.json();
        if (!channelData.items || !channelData.items.length) return null;

        var uploadsPlaylistId = channelData.items[0].contentDetails.relatedPlaylists.uploads;
        var playlistResponse = await fetch(
            YOUTUBE_API_BASE + '/playlistItems?part=snippet&playlistId=' + uploadsPlaylistId +
            '&maxResults=30&key=' + apiKey
        );
        if (!playlistResponse.ok) return null;
        var playlistData = await playlistResponse.json();
        if (!playlistData.items || !playlistData.items.length) return null;

        var videoIds = playlistData.items.map(function(item) {
            return item.snippet.resourceId.videoId;
        });

        var videosResponse = await fetch(
            YOUTUBE_API_BASE + '/videos?part=contentDetails,statistics,snippet&id=' +
            videoIds.join(',') + '&key=' + apiKey
        );
        if (!videosResponse.ok) return null;
        var videosData = await videosResponse.json();

        var shorts = (videosData.items || []).filter(function(video) {
            return parseDuration(video.contentDetails.duration) <= 60;
        }).slice(0, 10);

        if (!shorts.length) return null;

        var recentShorts = shorts.map(function(short) {
            return {
                videoId: short.id,
                title: short.snippet.title,
                viewCount: parseInt(short.statistics.viewCount || 0, 10),
                publishedAt: short.snippet.publishedAt,
                duration: short.contentDetails.duration,
                shortUrl: 'https://youtube.com/shorts/' + short.id,
                watchUrl: 'https://youtube.com/watch?v=' + short.id,
                thumbnailUrl: 'https://img.youtube.com/vi/' + short.id + '/hqdefault.jpg',
                // Shape used by calculateEnhancedMetrics
                view_count: parseInt(short.statistics.viewCount || 0, 10),
                short: true,
                type: 'short'
            };
        });

        // Canonical Niche Finder math (NOT a naive mean):
        // viral outlier (>4× rest) → trimmed mean; else mean of positive views
        var metrics = calculateEnhancedMetrics(recentShorts);
        if (!metrics || metrics.enhanced === false || metrics.recentAverage == null) {
            return null;
        }

        return {
            enhanced: true,
            recentAverage: metrics.recentAverage,
            recentMean: metrics.recentMean,
            recentMedian: metrics.recentMedian,
            recentTrimmedMean: metrics.recentTrimmedMean,
            consistencyScore: metrics.consistencyScore,
            hasViralOutlier: metrics.hasViralOutlier,
            viralMultiplier: metrics.viralMultiplier,
            trendDirection: metrics.trendDirection,
            trendPercentage: metrics.trendPercentage,
            isConsistent: metrics.isConsistent,
            distributionIssue: metrics.distributionIssue,
            viewRange: metrics.viewRange,
            shortsCount: metrics.shortsCount,
            regularCount: metrics.regularCount,
            videosAnalyzed: metrics.videosAnalyzed || shorts.length,
            recentShorts: recentShorts.map(function(s) {
                return {
                    videoId: s.videoId,
                    title: s.title,
                    viewCount: s.viewCount,
                    publishedAt: s.publishedAt,
                    duration: s.duration,
                    shortUrl: s.shortUrl,
                    watchUrl: s.watchUrl,
                    thumbnailUrl: s.thumbnailUrl
                };
            }),
            lastUpdated: new Date().toISOString()
        };
    } catch (e) {
        console.warn('Enhanced analysis failed for', channel.channelName, e.message);
        return null;
    }
}

async function runEnhancedAnalysis(channels, apiKey, minViewThreshold, onProgress, strict) {
    var qualifying = channels.filter(function(c) {
        return shouldRunEnhancedAnalysis(c, minViewThreshold, !!strict);
    });
    console.log(
        'Enrich: enhanced analysis for', qualifying.length, '/', channels.length,
        'channels', strict ? '(strict tiers)' : '(all resolvable — Niche Finder fields)'
    );

    var batchSize = 5;
    for (var i = 0; i < qualifying.length; i += batchSize) {
        var batch = qualifying.slice(i, i + batchSize);
        if (onProgress) {
            await onProgress({
                phase: 'enhanced',
                done: Math.min(i + batchSize, qualifying.length),
                total: qualifying.length
            });
        }
        var results = await Promise.allSettled(
            batch.map(function(ch) { return getEnhancedChannelDataYouTube(ch, apiKey); })
        );
        results.forEach(function(result, idx) {
            if (result.status !== 'fulfilled' || !result.value) return;
            var url = batch[idx].channelUrl;
            var target = channels.find(function(c) { return c.channelUrl === url; });
            if (target) {
                Object.assign(target, result.value, { enhanced: true });
            }
        });
        if (i + batchSize < qualifying.length) await delay(500);
    }
    return channels;
}

/**
 * Full pipeline matching extension processBatchAndSend.
 */
async function enrichChannelsFull(scraped, options) {
    options = options || {};
    var apiKey = options.apiKey;
    var minViewThreshold = options.minViewThreshold || 0;
    var enhancedEnabled = options.enhancedAnalysis !== false;
    var enhancedStrict = !!options.enhancedStrict;
    var onProgress = options.onProgress || null;
    var scrapeRunId = options.scrapeRunId || null;

    if (!apiKey) {
        throw new Error('YOUTUBE_API_KEY required — enrichment cannot run without it');
    }

    var enriched = await enrichSubscriberData(scraped, apiKey, onProgress);

    if (enhancedEnabled) {
        await runEnhancedAnalysis(enriched, apiKey, minViewThreshold, onProgress, enhancedStrict);
    }

    var qualified = enriched.filter(function(ch) {
        return (ch.averageViews || 0) >= minViewThreshold;
    });
    var enhancedCount = qualified.filter(function(ch) { return ch.enhanced && ch.recentAverage; }).length;
    console.log(
        'Enrich: filtered', enriched.length, '→', qualified.length,
        'qualified (min avg views', minViewThreshold + '),',
        enhancedCount, 'with recent_average / recent_shorts'
    );

    return qualified.map(function(ch) {
        // Niche Finder field map (server/mobile filters + sorts):
        // view_to_sub_ratio → Best Ratio
        // average_views     → Channel Avg / avg views range
        // recent_average    → Recent Avg range + Enhanced Only
        // recent_shorts     → Active Recently (4+ in last 14d via publishedAt)
        // subscriber_count  → Subscribers range
        // video_count       → Videos range
        // video_title       → title search
        // niche_keyword     → niche search
        // enhanced          → Enhanced Only badge
        return {
            channelName: ch.channelName,
            channelUrl: ch.channelUrl,
            channel_name: ch.channelName,
            channel_url: ch.channelUrl,
            videoTitle: ch.videoTitle,
            video_title: ch.videoTitle,
            viewCount: ch.viewCount,
            view_count: ch.viewCount,
            subscriberCount: ch.subscriberCount,
            subscriber_count: ch.subscriberCount,
            viewToSubRatio: ch.viewToSubRatio,
            view_to_sub_ratio: ch.viewToSubRatio,
            avatarUrl: ch.avatarUrl,
            avatar_url: ch.avatarUrl,
            thumbnailUrl: ch.thumbnailUrl || ch.avatarUrl,
            thumbnail_url: ch.thumbnailUrl || ch.avatarUrl,
            videoUrl: ch.videoUrl,
            video_url: ch.videoUrl,
            totalViews: ch.totalViews,
            total_views: ch.totalViews,
            videoCount: ch.videoCount,
            video_count: ch.videoCount,
            averageViews: ch.averageViews,
            average_views: ch.averageViews,
            enhanced: !!ch.enhanced,
            recentAverage: ch.recentAverage != null ? ch.recentAverage : null,
            recent_average: ch.recentAverage != null ? ch.recentAverage : null,
            recentMean: ch.recentMean != null ? ch.recentMean : null,
            recent_mean: ch.recentMean != null ? ch.recentMean : null,
            recentMedian: ch.recentMedian != null ? ch.recentMedian : null,
            recent_median: ch.recentMedian != null ? ch.recentMedian : null,
            recentTrimmedMean: ch.recentTrimmedMean != null ? ch.recentTrimmedMean : null,
            recent_trimmed_mean: ch.recentTrimmedMean != null ? ch.recentTrimmedMean : null,
            consistencyScore: ch.consistencyScore != null ? ch.consistencyScore : null,
            consistency_score: ch.consistencyScore != null ? ch.consistencyScore : null,
            hasViralOutlier: ch.hasViralOutlier != null ? ch.hasViralOutlier : null,
            has_viral_outlier: ch.hasViralOutlier != null ? ch.hasViralOutlier : null,
            viralMultiplier: ch.viralMultiplier != null ? ch.viralMultiplier : null,
            viral_multiplier: ch.viralMultiplier != null ? ch.viralMultiplier : null,
            isConsistent: ch.isConsistent != null ? ch.isConsistent : null,
            is_consistent: ch.isConsistent != null ? ch.isConsistent : null,
            trendDirection: ch.trendDirection || null,
            trend_direction: ch.trendDirection || null,
            trendPercentage: ch.trendPercentage != null ? ch.trendPercentage : null,
            trend_percentage: ch.trendPercentage != null ? ch.trendPercentage : null,
            distributionIssue: ch.distributionIssue != null ? ch.distributionIssue : null,
            distribution_issue: ch.distributionIssue != null ? ch.distributionIssue : null,
            viewRangeMin: ch.viewRange ? ch.viewRange.min : null,
            view_range_min: ch.viewRange ? ch.viewRange.min : null,
            viewRangeMax: ch.viewRange ? ch.viewRange.max : null,
            view_range_max: ch.viewRange ? ch.viewRange.max : null,
            videosAnalyzed: ch.videosAnalyzed || null,
            videos_analyzed: ch.videosAnalyzed || null,
            recentShorts: ch.recentShorts || null,
            recent_shorts: ch.recentShorts || null,
            lastUpdated: ch.lastUpdated || null,
            last_enhanced_update: ch.lastUpdated || null,
            niche_keyword: ch.niche_keyword || null,
            scrape_run_id: scrapeRunId,
            scrapeRunId: scrapeRunId,
            status: 'pending',
            source: 'fly-scraper',
            created_at: new Date(),
            updated_at: new Date()
        };
    });
}

module.exports = {
    enrichChannelsFull,
    enrichSubscriberData,
    runEnhancedAnalysis,
    shouldRunEnhancedAnalysis,
    parseDuration
};
