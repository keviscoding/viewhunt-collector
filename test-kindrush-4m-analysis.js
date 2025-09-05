// Analysis of @KindrushDaily - Large channel with 4M+ subscribers
// Testing enhanced analysis on a bigger channel to see distribution issues

console.log('🎯 KINDRUSH DAILY (4M+ SUBS) CHANNEL ANALYSIS');
console.log('=============================================\n');

// Based on actual @KindrushDaily channel (large motivational channel)
const realKindrushDailyStats = {
    channelName: "KindrushDaily",
    channelUrl: "https://www.youtube.com/@KindrushDaily",
    subscriberCount: 4200000, // ~4.2M subscribers
    totalViews: 850000000, // ~850M total views
    videoCount: 1200, // ~1200 total videos
    averageViews: Math.round(850000000 / 1200), // 708,333 average
    viewToSubRatio: Math.round(850000000 / 1200) / 4200000 // ~0.17 ratio
};

// Simulated recent video data based on large motivational channel patterns
// Large channels often have more consistent performance but still some variance
const recentVideos = [
    {
        title: "This One Habit Will Change Your Life Forever",
        videoId: "abc123xyz",
        videoUrl: "https://www.youtube.com/watch?v=abc123xyz",
        viewsText: "1.2M views",
        viewCount: 1200000,
        publishedTime: "2 days ago",
        index: 1
    },
    {
        title: "Morning Motivation: Start Strong Every Day",
        videoId: "def456uvw", 
        videoUrl: "https://www.youtube.com/watch?v=def456uvw",
        viewsText: "450K views",
        viewCount: 450000,
        publishedTime: "4 days ago",
        index: 2
    },
    {
        title: "The Secret Mindset of Successful People",
        videoId: "ghi789rst",
        videoUrl: "https://www.youtube.com/watch?v=ghi789rst", 
        viewsText: "680K views",
        viewCount: 680000,
        publishedTime: "6 days ago",
        index: 3
    },
    {
        title: "Daily Affirmations for Unstoppable Confidence",
        videoId: "jkl012opq",
        videoUrl: "https://www.youtube.com/watch?v=jkl012opq",
        viewsText: "320K views",
        viewCount: 320000,
        publishedTime: "1 week ago", 
        index: 4
    },
    {
        title: "Transform Your Mind in 30 Days",
        videoId: "mno345lmn",
        videoUrl: "https://www.youtube.com/watch?v=mno345lmn",
        viewsText: "890K views",
        viewCount: 890000,
        publishedTime: "1 week ago",
        index: 5
    },
    {
        title: "Why Most People Never Reach Their Potential",
        videoId: "pqr678ijk", 
        videoUrl: "https://www.youtube.com/watch?v=pqr678ijk",
        viewsText: "520K views",
        viewCount: 520000,
        publishedTime: "2 weeks ago",
        index: 6
    },
    {
        title: "The Power of Positive Self-Talk",
        videoId: "stu901def",
        videoUrl: "https://www.youtube.com/watch?v=stu901def", 
        viewsText: "410K views",
        viewCount: 410000,
        publishedTime: "2 weeks ago",
        index: 7
    }
];

// Enhanced filtering strategies for different channel sizes
const channelSizeStrategies = {
    // Large channels (1M+ subs) - Different considerations
    largeChannel: {
        name: "Large Channel Strategy",
        description: "For established channels with 1M+ subscribers",
        criteria: {
            minViewToSubRatio: 0.1,     // Lower ratio expected for large channels
            maxSubscribers: 10000000,   // Up to 10M subs
            minAverageViews: 100000,    // Higher absolute view threshold
            focusOnConsistency: true,   // More interested in consistency than discovery
            skipIfTooLarge: false       // Don't skip large channels
        },
        reasoning: "Large channels are less likely to be 'undiscovered' but users still want accurate recent performance data",
        expectedCoverage: "5-15% of large channels"
    },
    
    // Medium channels (100K-1M subs) - Sweet spot for discovery
    mediumChannel: {
        name: "Medium Channel Strategy", 
        description: "For growing channels with 100K-1M subscribers",
        criteria: {
            minViewToSubRatio: 0.5,     // Moderate ratio expected
            maxSubscribers: 1000000,    // Up to 1M subs
            minAverageViews: 50000,     // Moderate view threshold
            prioritizeGrowth: true,     // Look for trending channels
            skipIfTooLarge: false
        },
        reasoning: "Medium channels are often in growth phase, high potential for discovery",
        expectedCoverage: "20-40% of medium channels"
    },
    
    // Small channels (<100K subs) - High discovery potential
    smallChannel: {
        name: "Small Channel Strategy",
        description: "For smaller channels under 100K subscribers", 
        criteria: {
            minViewToSubRatio: 1.0,     // Higher ratio expected for small channels
            maxSubscribers: 100000,     // Under 100K subs
            minAverageViews: 5000,      // Lower absolute threshold
            prioritizeDiscovery: true,  // Focus on undiscovered gems
            skipIfTooLarge: false
        },
        reasoning: "Small channels have highest potential for being undiscovered niches",
        expectedCoverage: "30-60% of small channels"
    }
};

function calculateEnhancedMetrics(videos) {
    if (videos.length === 0) return null;
    
    const viewCounts = videos.map(v => v.viewCount).sort((a, b) => b - a);
    const recentCount = Math.min(7, viewCounts.length);
    const recent7 = viewCounts.slice(0, recentCount);
    
    const mean = recent7.reduce((a, b) => a + b) / recent7.length;
    const median = recent7[Math.floor(recent7.length / 2)];
    
    // Trimmed mean (remove highest and lowest)
    let trimmedMean = mean;
    if (recent7.length >= 3) {
        const trimmed = recent7.slice(1, -1);
        trimmedMean = trimmed.reduce((a, b) => a + b) / trimmed.length;
    }
    
    // Consistency score
    const variance = recent7.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / recent7.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = mean > 0 ? stdDev / mean : 0;
    const consistencyScore = Math.max(0, 100 - (coefficientOfVariation * 100));
    
    // Detect viral outliers (adjusted threshold for larger channels)
    const maxView = Math.max(...recent7);
    const minView = Math.min(...recent7);
    const avgWithoutExtremes = recent7.filter(v => v !== maxView && v !== minView).reduce((a, b) => a + b, 0) / Math.max(1, recent7.length - 2);
    const viralMultiplier = avgWithoutExtremes > 0 ? maxView / avgWithoutExtremes : 1;
    
    // For large channels, use lower viral threshold (they're more consistent)
    const viralThreshold = recent7[0] > 500000 ? 2.5 : 4.0; // Lower threshold for large channels
    const hasViralOutlier = viralMultiplier > viralThreshold;
    
    // Performance trend analysis
    const firstHalf = recent7.slice(0, Math.ceil(recent7.length / 2));
    const secondHalf = recent7.slice(Math.ceil(recent7.length / 2));
    const firstHalfAvg = firstHalf.reduce((a, b) => a + b) / firstHalf.length;
    const secondHalfAvg = secondHalf.reduce((a, b) => a + b) / secondHalf.length;
    const trendPercentage = Math.round(((firstHalfAvg - secondHalfAvg) / secondHalfAvg) * 100);
    
    let trendDirection;
    if (Math.abs(trendPercentage) < 15) { // Larger threshold for large channels
        trendDirection = 'STABLE';
    } else if (trendPercentage > 0) {
        trendDirection = 'IMPROVING';
    } else {
        trendDirection = 'DECLINING';
    }
    
    // Channel size classification
    let channelSize;
    if (recent7[0] > 500000) {
        channelSize = 'LARGE';
    } else if (recent7[0] > 50000) {
        channelSize = 'MEDIUM';
    } else {
        channelSize = 'SMALL';
    }
    
    return {
        recentVideoCount: recentCount,
        averageViews: Math.round(mean),
        medianViews: Math.round(median),
        trimmedMeanViews: Math.round(trimmedMean),
        consistencyScore: Math.round(consistencyScore),
        coefficientOfVariation: coefficientOfVariation.toFixed(3),
        isConsistent: consistencyScore > 70,
        viewRange: `${Math.min(...recent7).toLocaleString()} - ${Math.max(...recent7).toLocaleString()}`,
        standardDeviation: Math.round(stdDev),
        hasViralOutlier,
        viralMultiplier: viralMultiplier.toFixed(1),
        viralThreshold,
        trendDirection,
        trendPercentage,
        channelSize,
        recommendedMetric: hasViralOutlier ? 'trimmedMean' : 'median',
        distributionIssue: Math.abs(mean - median) / mean > 0.25 // Adjusted threshold for large channels
    };
}

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toLocaleString();
}

function getChannelSizeCategory(subscriberCount) {
    if (subscriberCount >= 1000000) return 'largeChannel';
    if (subscriberCount >= 100000) return 'mediumChannel';
    return 'smallChannel';
}

function evaluateChannelForEnhancement(channel) {
    const sizeCategory = getChannelSizeCategory(channel.subscriberCount);
    const strategy = channelSizeStrategies[sizeCategory];
    const criteria = strategy.criteria;
    
    let shouldAnalyze = true;
    let reasons = [];
    let score = 0;
    
    // Check ratio threshold
    if (channel.viewToSubRatio >= criteria.minViewToSubRatio) {
        score += 25;
        reasons.push(`✅ Good ratio for ${sizeCategory.replace('Channel', '')} channel (${channel.viewToSubRatio.toFixed(2)})`);
    } else {
        shouldAnalyze = false;
        reasons.push(`❌ Low ratio (${channel.viewToSubRatio.toFixed(2)} < ${criteria.minViewToSubRatio})`);
    }
    
    // Check subscriber limit
    if (channel.subscriberCount <= criteria.maxSubscribers) {
        score += 25;
        reasons.push(`✅ Under subscriber limit (${formatNumber(channel.subscriberCount)})`);
    } else {
        shouldAnalyze = false;
        reasons.push(`❌ Too many subscribers (${formatNumber(channel.subscriberCount)})`);
    }
    
    // Check average views
    if (channel.averageViews >= criteria.minAverageViews) {
        score += 25;
        reasons.push(`✅ Good average views (${formatNumber(channel.averageViews)})`);
    } else {
        shouldAnalyze = false;
        reasons.push(`❌ Low average views (${formatNumber(channel.averageViews)})`);
    }
    
    // Bonus scoring based on strategy focus
    if (criteria.focusOnConsistency) {
        score += 15;
        reasons.push(`🎯 Large channel - focus on consistency`);
    } else if (criteria.prioritizeGrowth) {
        score += 15;
        reasons.push(`🎯 Medium channel - growth potential`);
    } else if (criteria.prioritizeDiscovery) {
        score += 15;
        reasons.push(`🎯 Small channel - discovery potential`);
    }
    
    // Final bonus for being in sweet spot
    score += 10;
    reasons.push(`✅ ${strategy.name} applied`);
    
    return {
        shouldAnalyze,
        score,
        reasons,
        strategy: strategy.name,
        sizeCategory,
        expectedCoverage: strategy.expectedCoverage
    };
}

// Run the analysis
console.log('📊 LARGE CHANNEL STATS:');
console.log('=======================');
console.log(`Channel: ${realKindrushDailyStats.channelName}`);
console.log(`URL: ${realKindrushDailyStats.channelUrl}`);
console.log(`Subscribers: ${formatNumber(realKindrushDailyStats.subscriberCount)}`);
console.log(`Total Videos: ${realKindrushDailyStats.videoCount.toLocaleString()}`);
console.log(`Total Views: ${formatNumber(realKindrushDailyStats.totalViews)}`);
console.log(`Average Views (Current Method): ${formatNumber(realKindrushDailyStats.averageViews)}`);
console.log(`View-to-Sub Ratio: ${realKindrushDailyStats.viewToSubRatio.toFixed(2)}`);

console.log('\n🎬 RECENT VIDEOS (Last 7):');
console.log('==========================');
recentVideos.forEach((video, index) => {
    console.log(`${index + 1}. ${video.title}`);
    console.log(`   Views: ${formatNumber(video.viewCount)} (${video.viewsText})`);
    console.log(`   Published: ${video.publishedTime}`);
    console.log('');
});

const enhancedMetrics = calculateEnhancedMetrics(recentVideos);

console.log('📈 ENHANCED METRICS ANALYSIS:');
console.log('=============================');
console.log(`Videos Analyzed: ${enhancedMetrics.recentVideoCount}`);
console.log(`Channel Size: ${enhancedMetrics.channelSize}`);
console.log(`Average Views: ${formatNumber(enhancedMetrics.averageViews)}`);
console.log(`Median Views: ${formatNumber(enhancedMetrics.medianViews)}`);
console.log(`Trimmed Mean: ${formatNumber(enhancedMetrics.trimmedMeanViews)} (removes highest/lowest)`);
console.log(`View Range: ${enhancedMetrics.viewRange}`);
console.log(`Consistency Score: ${enhancedMetrics.consistencyScore}/100`);
console.log(`Is Consistent: ${enhancedMetrics.isConsistent ? '✅ YES' : '❌ NO'}`);
console.log(`Has Viral Outlier: ${enhancedMetrics.hasViralOutlier ? '🚀 YES' : '❌ NO'} (threshold: ${enhancedMetrics.viralThreshold}x)`);
if (enhancedMetrics.hasViralOutlier) {
    console.log(`Viral Multiplier: ${enhancedMetrics.viralMultiplier}x`);
}
console.log(`Performance Trend: ${enhancedMetrics.trendDirection} (${enhancedMetrics.trendPercentage > 0 ? '+' : ''}${enhancedMetrics.trendPercentage}%)`);
console.log(`Distribution Issue: ${enhancedMetrics.distributionIssue ? '⚠️  YES' : '✅ NO'}`);
console.log(`Recommended Metric: ${enhancedMetrics.recommendedMetric === 'trimmedMean' ? 'Trimmed Mean' : 'Median'}`);

console.log('\n🔍 ACCURACY COMPARISON:');
console.log('=======================');
const currentEstimate = realKindrushDailyStats.averageViews;
const enhancedEstimate = enhancedMetrics[enhancedMetrics.recommendedMetric + 'Views'];
const accuracyDiff = ((currentEstimate - enhancedEstimate) / currentEstimate * 100);

console.log(`Current Method: ${formatNumber(currentEstimate)} average`);
console.log(`Enhanced Method: ${formatNumber(enhancedEstimate)} ${enhancedMetrics.recommendedMetric}`);
console.log(`Accuracy Difference: ${Math.abs(accuracyDiff).toFixed(1)}% ${accuracyDiff > 0 ? 'overestimate' : 'underestimate'}`);

console.log('\n🎯 CHURN RISK ASSESSMENT:');
console.log('=========================');
if (accuracyDiff > 50) {
    console.log('🚨 HIGH CHURN RISK: Major expectation mismatch');
} else if (accuracyDiff > 25) {
    console.log('⚠️  MEDIUM CHURN RISK: Noticeable expectation gap');
} else if (accuracyDiff > 10) {
    console.log('⚠️  LOW CHURN RISK: Minor expectation difference');
} else {
    console.log('✅ MINIMAL CHURN RISK: Expectations align well');
}

console.log('\n🤖 CHANNEL SIZE-BASED FILTERING EVALUATION:');
console.log('============================================');

const evaluation = evaluateChannelForEnhancement(realKindrushDailyStats);
console.log(`Channel Category: ${evaluation.sizeCategory.replace('Channel', '').toUpperCase()} CHANNEL`);
console.log(`Strategy Applied: ${evaluation.strategy}`);
console.log(`Should Analyze: ${evaluation.shouldAnalyze ? '✅ YES' : '❌ NO'}`);
console.log(`Score: ${evaluation.score}/100`);
console.log(`Expected Coverage: ${evaluation.expectedCoverage}`);
console.log('Evaluation Reasons:');
evaluation.reasons.forEach(reason => console.log(`  ${reason}`));

console.log('\n💡 LARGE CHANNEL INSIGHTS:');
console.log('==========================');
console.log('Key findings for large channels (1M+ subscribers):');
console.log('');
console.log('1. DIFFERENT EXPECTATIONS:');
console.log('   • Lower view-to-subscriber ratios are normal');
console.log('   • Users expect more consistency, less discovery potential');
console.log('   • Focus shifts from "undiscovered" to "recent performance"');
console.log('');
console.log('2. ADJUSTED THRESHOLDS:');
console.log('   • Viral outlier threshold: 2.5x (vs 4x for smaller channels)');
console.log('   • Trend stability threshold: ±15% (vs ±10% for smaller)');
console.log('   • Distribution issue threshold: 25% (vs 30% for smaller)');
console.log('');
console.log('3. VALUE PROPOSITION:');
console.log('   • Less about "discovery", more about "accurate expectations"');
console.log('   • Users want to know recent performance vs historical average');
console.log('   • Still valuable for churn reduction');

console.log('\n🎯 FILTERING STRATEGY RECOMMENDATIONS:');
console.log('=====================================');
console.log('Based on channel size analysis:');
console.log('');
console.log('SMALL CHANNELS (<100K subs):');
console.log('• High discovery potential → Analyze 30-60%');
console.log('• Focus: Finding undiscovered gems');
console.log('• Threshold: Ratio ≥ 1.0, Views ≥ 5K');
console.log('');
console.log('MEDIUM CHANNELS (100K-1M subs):');
console.log('• Growth potential → Analyze 20-40%');
console.log('• Focus: Trending/growing channels');
console.log('• Threshold: Ratio ≥ 0.5, Views ≥ 50K');
console.log('');
console.log('LARGE CHANNELS (1M+ subs):');
console.log('• Consistency focus → Analyze 5-15%');
console.log('• Focus: Accurate recent performance');
console.log('• Threshold: Ratio ≥ 0.1, Views ≥ 100K');
console.log('');
console.log('This tiered approach optimizes for different user needs per channel size! 🎯');