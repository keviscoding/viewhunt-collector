/**
 * Canonical Niche Finder "intelligent" recent-average math.
 *
 * Source of truth historically used by:
 *   - POST /api/channels/enhanced-analysis (server.js)
 *   - enhance-recent-channels.js batch job
 *
 * recentAverage:
 *   - If one Short is >4× the mean of the rest (viral outlier) → trimmed mean
 *     (drop highest + lowest, then average)
 *   - Else → plain mean of positive view counts
 *
 * Input videos: array of { view_count|viewCount, short?, type? }
 */
function calculateEnhancedMetrics(videos) {
    if (!videos || videos.length === 0) return null;

    // Get view counts from recent videos (last 7-10)
    const recentVideos = videos.slice(0, Math.min(10, videos.length));
    const viewCounts = recentVideos
        .map(function(v) {
            return v.view_count != null ? v.view_count : (v.viewCount || 0);
        })
        .filter(function(count) { return count > 0; })
        .sort(function(a, b) { return b - a; });

    if (viewCounts.length === 0) {
        return {
            enhanced: false,
            reason: 'No valid view counts found'
        };
    }

    const mean = viewCounts.reduce(function(a, b) { return a + b; }, 0) / viewCounts.length;
    const median = viewCounts[Math.floor(viewCounts.length / 2)];

    // Trimmed mean (remove highest and lowest to reduce outlier impact)
    let trimmedMean = mean;
    if (viewCounts.length >= 3) {
        const trimmed = viewCounts.slice(1, -1);
        trimmedMean = trimmed.reduce(function(a, b) { return a + b; }, 0) / trimmed.length;
    }

    // Consistency score (lower coefficient of variation = more consistent)
    const variance = viewCounts.reduce(function(sum, val) {
        return sum + Math.pow(val - mean, 2);
    }, 0) / viewCounts.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = mean > 0 ? stdDev / mean : 0;
    const consistencyScore = Math.max(0, 100 - (coefficientOfVariation * 100));

    // Detect viral outliers
    const maxView = Math.max.apply(null, viewCounts);
    const withoutMax = viewCounts.filter(function(v) { return v !== maxView; });
    const avgWithoutMax = withoutMax.length
        ? withoutMax.reduce(function(a, b) { return a + b; }, 0) / withoutMax.length
        : 0;
    const viralMultiplier = avgWithoutMax > 0 ? maxView / avgWithoutMax : 1;
    const hasViralOutlier = viralMultiplier > 4;

    // Performance trend (comparing first half vs second half)
    const firstHalf = viewCounts.slice(0, Math.ceil(viewCounts.length / 2));
    const secondHalf = viewCounts.slice(Math.ceil(viewCounts.length / 2));
    const firstHalfAvg = firstHalf.reduce(function(a, b) { return a + b; }, 0) / firstHalf.length;
    const secondHalfAvg = secondHalf.length
        ? secondHalf.reduce(function(a, b) { return a + b; }, 0) / secondHalf.length
        : firstHalfAvg;
    const trendPercentage = secondHalfAvg > 0
        ? Math.round(((firstHalfAvg - secondHalfAvg) / secondHalfAvg) * 100)
        : 0;

    let trendDirection = 'STABLE';
    if (Math.abs(trendPercentage) >= 15) {
        trendDirection = trendPercentage > 0 ? 'IMPROVING' : 'DECLINING';
    }

    // Count shorts vs regular videos
    const shortsCount = recentVideos.filter(function(v) {
        return v.short === true || v.type === 'short';
    }).length;
    const regularCount = recentVideos.length - shortsCount;

    return {
        // RECENT AVERAGE - Distribution-aware metric from last 10 videos
        recentAverage: hasViralOutlier ? Math.round(trimmedMean) : Math.round(mean),

        // Detailed breakdown for debugging/analysis
        recentMean: Math.round(mean),
        recentMedian: Math.round(median),
        recentTrimmedMean: Math.round(trimmedMean),

        // Distribution analysis
        consistencyScore: Math.round(consistencyScore),
        hasViralOutlier: hasViralOutlier,
        viralMultiplier: hasViralOutlier ? parseFloat(viralMultiplier.toFixed(1)) : null,

        // Performance insights
        trendDirection: trendDirection,
        trendPercentage: trendPercentage,

        // Content breakdown
        shortsCount: shortsCount,
        regularCount: regularCount,
        videosAnalyzed: recentVideos.length,

        // Quality indicators
        isConsistent: consistencyScore > 70,
        distributionIssue: mean > 0 ? Math.abs(mean - median) / mean > 0.3 : false,

        // View range for context
        viewRange: {
            min: Math.min.apply(null, viewCounts),
            max: Math.max.apply(null, viewCounts)
        }
    };
}

module.exports = { calculateEnhancedMetrics };
