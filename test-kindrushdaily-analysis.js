// Enhanced analysis test for @kindrushdaily channel
// Testing the smart filtering system and distribution metrics

console.log('🎯 KINDRUSHDAILY CHANNEL ANALYSIS');
console.log('=================================\n');

// Simulate what we'd get from current method (YouTube API channel stats)
const simulatedCurrentStats = {
    channelName: "KindRushDaily",
    channelUrl: "https://www.youtube.com/@kindrushdaily",
    subscriberCount: 45200, // ~45K subscribers
    totalViews: 12500000, // ~12.5M total views
    videoCount: 180, // ~180 total videos
    averageViews: Math.round(12500000 / 180), // 69,444 average
    viewToSubRatio: Math.round(12500000 / 180) / 45200 // ~1.54 ratio
};

// Simulate recent video data (what enhanced method would scrape)
const simulatedRecentVideos = [
    {
        title: "Daily Motivation: You Are Stronger Than You Think",
        videoId: "abc123def",
        videoUrl: "https://www.youtube.com/watch?v=abc123def",
        viewsText: "2.1K views",
        viewCount: 2100,
        publishedTime: "2 days ago",
        index: 1
    },
    {
        title: "Morning Affirmations for Success",
        videoId: "def456ghi", 
        videoUrl: "https://www.youtube.com/watch?v=def456ghi",
        viewsText: "1.8K views",
        viewCount: 1800,
        publishedTime: "3 days ago",
        index: 2
    },
    {
        title: "Overcome Your Fears Today",
        videoId: "ghi789jkl",
        videoUrl: "https://www.youtube.com/watch?v=ghi789jkl", 
        viewsText: "3.2K views",
        viewCount: 3200,
        publishedTime: "5 days ago",
        index: 3
    },
    {
        title: "The Power of Positive Thinking",
        videoId: "jkl012mno",
        videoUrl: "https://www.youtube.com/watch?v=jkl012mno",
        viewsText: "1.5K views",
        viewCount: 1500,
        publishedTime: "1 week ago", 
        index: 4
    },
    {
        title: "Daily Habits That Changed My Life",
        videoId: "mno345pqr",
        videoUrl: "https://www.youtube.com/watch?v=mno345pqr",
        viewsText: "4.1K views",
        viewCount: 4100,
        publishedTime: "1 week ago",
        index: 5
    },
    {
        title: "Mindfulness Meditation for Beginners",
        videoId: "pqr678stu", 
        videoUrl: "https://www.youtube.com/watch?v=pqr678stu",
        viewsText: "2.7K views",
        viewCount: 2700,
        publishedTime: "2 weeks ago",
        index: 6
    },
    {
        title: "Transform Your Life in 30 Days",
        videoId: "stu901vwx",
        videoUrl: "https://www.youtube.com/watch?v=stu901vwx", 
        viewsText: "1.9K views",
        viewCount: 1900,
        publishedTime: "2 weeks ago",
        index: 7
    }
];

// Smart filtering criteria for enhanced analysis
function shouldRunEnhancedAnalysis(channel) {
    const criteria = {
        // Primary filters (must meet ALL)
        minViewToSubRatio: 1.0,     // At least 1.0 ratio
        maxSubscribers: 500000,     // Under 500K subs (bigger channels less likely to be "undiscovered")
        minAverageViews: 10000,     // At least 10K average views
        
        // Secondary filters (bonus points)
        idealSubRange: [10000, 100000],  // Sweet spot for undiscovered channels
        idealRatioRange: [2.0, 10.0],    // Good engagement without being too viral
        recentActivity: true,             // Has videos in last 30 days
    };
    
    // Calculate scores
    let score = 0;
    let reasons = [];
    
    // Primary filters (required)
    if (channel.viewToSubRatio >= criteria.minViewToSubRatio) {
        score += 20;
        reasons.push(`✅ Good ratio (${channel.viewToSubRatio.toFixed(2)})`);
    } else {
        reasons.push(`❌ Low ratio (${channel.viewToSubRatio.toFixed(2)} < ${criteria.minViewToSubRatio})`);
        return { shouldAnalyze: false, score: 0, reasons };
    }
    
    if (channel.subscriberCount <= criteria.maxSubscribers) {
        score += 20;
        reasons.push(`✅ Under ${criteria.maxSubscribers.toLocaleString()} subs`);
    } else {
        reasons.push(`❌ Too many subs (${channel.subscriberCount.toLocaleString()})`);
        return { shouldAnalyze: false, score: 0, reasons };
    }
    
    if (channel.averageViews >= criteria.minAverageViews) {
        score += 20;
        reasons.push(`✅ Good average views (${channel.averageViews.toLocaleString()})`);
    } else {
        reasons.push(`❌ Low average views (${channel.averageViews.toLocaleString()})`);
        return { shouldAnalyze: false, score: 0, reasons };
    }
    
    // Bonus scoring
    if (channel.subscriberCount >= criteria.idealSubRange[0] && 
        channel.subscriberCount <= criteria.idealSubRange[1]) {
        score += 15;
        reasons.push(`🎯 Ideal sub range (${criteria.idealSubRange[0].toLocaleString()}-${criteria.idealSubRange[1].toLocaleString()})`);
    }
    
    if (channel.viewToSubRatio >= criteria.idealRatioRange[0] && 
        channel.viewToSubRatio <= criteria.idealRatioRange[1]) {
        score += 15;
        reasons.push(`🎯 Ideal ratio range (${criteria.idealRatioRange[0]}-${criteria.idealRatioRange[1]})`);
    }
    
    // Activity bonus (would need to check in real implementation)
    score += 10;
    reasons.push(`✅ Recent activity assumed`);
    
    return {
        shouldAnalyze: score >= 60, // Need at least 60/100 points
        score,
        reasons,
        priority: score >= 80 ? 'HIGH' : score >= 70 ? 'MEDIUM' : 'LOW'
    };
}

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
    
    // Detect viral outliers
    const maxView = Math.max(...recent7);
    const avgWithoutMax = recent7.filter(v => v !== maxView).reduce((a, b) => a + b, 0) / (recent7.length - 1);
    const viralMultiplier = maxView / avgWithoutMax;
    const hasViralOutlier = viralMultiplier > 3; // If top video is 3x+ the average of others
    
    // Performance trend (comparing first half vs second half)
    const firstHalf = recent7.slice(0, Math.ceil(recent7.length / 2));
    const secondHalf = recent7.slice(Math.ceil(recent7.length / 2));
    const firstHalfAvg = firstHalf.reduce((a, b) => a + b) / firstHalf.length;
    const secondHalfAvg = secondHalf.reduce((a, b) => a + b) / secondHalf.length;
    const trendDirection = firstHalfAvg > secondHalfAvg ? 'IMPROVING' : 
                          firstHalfAvg < secondHalfAvg ? 'DECLINING' : 'STABLE';
    
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
        trendDirection,
        trendPercentage: Math.round(((firstHalfAvg - secondHalfAvg) / secondHalfAvg) * 100),
        recommendedMetric: hasViralOutlier ? 'trimmedMean' : 'median'
    };
}

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toLocaleString();
}

// Run the analysis
console.log('📊 CURRENT METHOD RESULTS:');
console.log('==========================');
console.log(`Channel: ${simulatedCurrentStats.channelName}`);
console.log(`Subscribers: ${simulatedCurrentStats.subscriberCount.toLocaleString()}`);
console.log(`Total Videos: ${simulatedCurrentStats.videoCount}`);
console.log(`Total Views: ${simulatedCurrentStats.totalViews.toLocaleString()}`);
console.log(`Average Views: ${formatNumber(simulatedCurrentStats.averageViews)}`);
console.log(`View-to-Sub Ratio: ${simulatedCurrentStats.viewToSubRatio.toFixed(2)}`);

console.log('\n🤖 SMART FILTERING DECISION:');
console.log('============================');
const filterResult = shouldRunEnhancedAnalysis(simulatedCurrentStats);
console.log(`Should run enhanced analysis: ${filterResult.shouldAnalyze ? '✅ YES' : '❌ NO'}`);
console.log(`Score: ${filterResult.score}/100 (${filterResult.priority} priority)`);
console.log('Reasons:');
filterResult.reasons.forEach(reason => console.log(`  ${reason}`));

if (filterResult.shouldAnalyze) {
    console.log('\n🎬 RECENT VIDEOS (Last 7):');
    console.log('==========================');
    simulatedRecentVideos.forEach((video, index) => {
        console.log(`${index + 1}. ${video.title}`);
        console.log(`   Views: ${formatNumber(video.viewCount)} (${video.viewsText})`);
        console.log(`   Published: ${video.publishedTime}`);
        console.log('');
    });

    const enhancedMetrics = calculateEnhancedMetrics(simulatedRecentVideos);

    console.log('📈 ENHANCED METRICS ANALYSIS:');
    console.log('=============================');
    console.log(`Videos Analyzed: ${enhancedMetrics.recentVideoCount}`);
    console.log(`Average Views: ${formatNumber(enhancedMetrics.averageViews)}`);
    console.log(`Median Views: ${formatNumber(enhancedMetrics.medianViews)}`);
    console.log(`Trimmed Mean: ${formatNumber(enhancedMetrics.trimmedMeanViews)} (removes highest/lowest)`);
    console.log(`View Range: ${enhancedMetrics.viewRange}`);
    console.log(`Standard Deviation: ${formatNumber(enhancedMetrics.standardDeviation)}`);
    console.log(`Consistency Score: ${enhancedMetrics.consistencyScore}/100`);
    console.log(`Is Consistent: ${enhancedMetrics.isConsistent ? '✅ YES' : '❌ NO'}`);
    console.log(`Has Viral Outlier: ${enhancedMetrics.hasViralOutlier ? '🚀 YES' : '❌ NO'}`);
    console.log(`Performance Trend: ${enhancedMetrics.trendDirection} (${enhancedMetrics.trendPercentage > 0 ? '+' : ''}${enhancedMetrics.trendPercentage}%)`);
    console.log(`Recommended Metric: ${enhancedMetrics.recommendedMetric === 'trimmedMean' ? 'Trimmed Mean' : 'Median'}`);

    console.log('\n🔍 ACCURACY COMPARISON:');
    console.log('=======================');
    const currentEstimate = simulatedCurrentStats.averageViews;
    const enhancedEstimate = enhancedMetrics[enhancedMetrics.recommendedMetric + 'Views'];
    const accuracyDiff = ((currentEstimate - enhancedEstimate) / currentEstimate * 100);
    
    console.log(`Current Method: ${formatNumber(currentEstimate)} average`);
    console.log(`Enhanced Method: ${formatNumber(enhancedEstimate)} ${enhancedMetrics.recommendedMetric}`);
    console.log(`Accuracy Difference: ${Math.abs(accuracyDiff).toFixed(1)}% ${accuracyDiff > 0 ? 'overestimate' : 'underestimate'}`);

    console.log('\n🎯 USER EXPERIENCE IMPACT:');
    console.log('==========================');
    if (accuracyDiff > 50) {
        console.log('🚨 MAJOR CHURN RISK: Current method severely overestimates performance');
        console.log(`   User expects: ~${formatNumber(currentEstimate)} views per video`);
        console.log(`   Reality: ~${formatNumber(enhancedEstimate)} views per video`);
        console.log('   User will be very disappointed → high churn probability');
    } else if (accuracyDiff > 20) {
        console.log('⚠️  MODERATE CHURN RISK: Noticeable difference in expectations');
        console.log(`   User expects: ~${formatNumber(currentEstimate)} views per video`);
        console.log(`   Reality: ~${formatNumber(enhancedEstimate)} views per video`);
        console.log('   User may be disappointed → medium churn probability');
    } else {
        console.log('✅ LOW CHURN RISK: Expectations align with reality');
        console.log(`   Current and enhanced methods show similar performance`);
    }

    console.log('\n📊 CHANNEL QUALITY ASSESSMENT:');
    console.log('==============================');
    let qualityScore = 0;
    let qualityReasons = [];

    // Consistency scoring
    if (enhancedMetrics.consistencyScore > 80) {
        qualityScore += 30;
        qualityReasons.push('✅ Highly consistent performance');
    } else if (enhancedMetrics.consistencyScore > 60) {
        qualityScore += 20;
        qualityReasons.push('⚠️  Moderately consistent performance');
    } else {
        qualityScore += 10;
        qualityReasons.push('❌ Inconsistent performance');
    }

    // Trend scoring
    if (enhancedMetrics.trendDirection === 'IMPROVING') {
        qualityScore += 25;
        qualityReasons.push('📈 Improving trend');
    } else if (enhancedMetrics.trendDirection === 'STABLE') {
        qualityScore += 15;
        qualityReasons.push('📊 Stable performance');
    } else {
        qualityScore += 5;
        qualityReasons.push('📉 Declining trend');
    }

    // View performance relative to subscriber count
    const viewsPerSub = enhancedMetrics.medianViews / simulatedCurrentStats.subscriberCount;
    if (viewsPerSub > 0.1) {
        qualityScore += 25;
        qualityReasons.push('🎯 Excellent engagement rate');
    } else if (viewsPerSub > 0.05) {
        qualityScore += 15;
        qualityReasons.push('👍 Good engagement rate');
    } else {
        qualityScore += 5;
        qualityReasons.push('👎 Low engagement rate');
    }

    // Viral outlier penalty
    if (enhancedMetrics.hasViralOutlier) {
        qualityScore -= 10;
        qualityReasons.push('⚠️  Has viral outlier (less predictable)');
    } else {
        qualityScore += 10;
        qualityReasons.push('✅ No viral outliers (predictable)');
    }

    console.log(`Overall Quality Score: ${qualityScore}/90`);
    console.log('Quality Factors:');
    qualityReasons.forEach(reason => console.log(`  ${reason}`));

    let recommendation;
    if (qualityScore >= 70) {
        recommendation = '🌟 EXCELLENT NICHE OPPORTUNITY';
    } else if (qualityScore >= 50) {
        recommendation = '👍 GOOD NICHE OPPORTUNITY';
    } else if (qualityScore >= 30) {
        recommendation = '⚠️  MODERATE OPPORTUNITY';
    } else {
        recommendation = '❌ POOR OPPORTUNITY';
    }

    console.log(`\nRecommendation: ${recommendation}`);
}

console.log('\n🎯 SMART FILTERING CRITERIA SUMMARY:');
console.log('====================================');
console.log('Enhanced analysis will run for channels that meet ALL of:');
console.log('• View-to-subscriber ratio ≥ 1.0');
console.log('• Subscriber count ≤ 500,000');
console.log('• Average views ≥ 10,000');
console.log('');
console.log('Bonus points for:');
console.log('• Subscriber count in 10K-100K range (sweet spot)');
console.log('• View-to-sub ratio in 2.0-10.0 range (good engagement)');
console.log('• Recent activity (videos in last 30 days)');
console.log('');
console.log('This should capture ~10-20% of channels for enhanced analysis');
console.log('Focusing on the most promising undiscovered niches! 🎯');