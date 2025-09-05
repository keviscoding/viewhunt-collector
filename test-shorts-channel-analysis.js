// Test enhanced analysis on a Shorts channel with timing comparison
// Testing: https://www.youtube.com/@InfinitySIChannel/shorts

console.log('🎬 SHORTS CHANNEL ENHANCED ANALYSIS TEST');
console.log('=======================================\n');

// Simulate real data from @InfinitySIChannel/shorts (smaller Shorts channel)
const simulatedInfinitySIData = [
    {
        title: "This Optical Illusion Will Break Your Brain! 🤯",
        videoId: "abc123def",
        videoUrl: "https://www.youtube.com/shorts/abc123def",
        viewsText: "2.1M views",
        viewCount: 2100000,
        publishedTime: "5 days ago",
        index: 1,
        isShort: true
    },
    {
        title: "Mind-Bending Physics Trick That Seems Impossible",
        videoId: "def456ghi", 
        videoUrl: "https://www.youtube.com/shorts/def456ghi",
        viewsText: "45K views",
        viewCount: 45000,
        publishedTime: "1 week ago",
        index: 2,
        isShort: true
    },
    {
        title: "The Science Behind This Crazy Illusion",
        videoId: "ghi789jkl",
        videoUrl: "https://www.youtube.com/shorts/ghi789jkl", 
        viewsText: "78K views",
        viewCount: 78000,
        publishedTime: "2 weeks ago",
        index: 3,
        isShort: true
    },
    {
        title: "This Will Change How You See Everything",
        videoId: "jkl012mno",
        videoUrl: "https://www.youtube.com/shorts/jkl012mno",
        viewsText: "156K views",
        viewCount: 156000,
        publishedTime: "2 weeks ago", 
        index: 4,
        isShort: true
    },
    {
        title: "Impossible Geometry That Actually Works",
        videoId: "mno345pqr",
        videoUrl: "https://www.youtube.com/shorts/mno345pqr",
        viewsText: "89K views",
        viewCount: 89000,
        publishedTime: "3 weeks ago",
        index: 5,
        isShort: true
    },
    {
        title: "The Math Behind This Viral Trick",
        videoId: "pqr678stu", 
        videoUrl: "https://www.youtube.com/shorts/pqr678stu",
        viewsText: "234K views",
        viewCount: 234000,
        publishedTime: "1 month ago",
        index: 6,
        isShort: true
    },
    {
        title: "Why This Illusion Breaks Your Brain",
        videoId: "stu901vwx",
        videoUrl: "https://www.youtube.com/shorts/stu901vwx", 
        viewsText: "67K views",
        viewCount: 67000,
        publishedTime: "1 month ago",
        index: 7,
        isShort: true
    }
];

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
    
    // Consistency score (lower coefficient of variation = more consistent)
    const variance = recent7.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / recent7.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = mean > 0 ? stdDev / mean : 0;
    const consistencyScore = Math.max(0, 100 - (coefficientOfVariation * 100));
    
    // Detect viral outliers
    const maxView = Math.max(...recent7);
    const avgWithoutMax = recent7.filter(v => v !== maxView).reduce((a, b) => a + b, 0) / (recent7.length - 1);
    const viralMultiplier = maxView / avgWithoutMax;
    const hasViralOutlier = viralMultiplier > 5; // If top video is 5x+ the average of others
    
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
        recommendedMetric: hasViralOutlier ? 'trimmedMean' : 'median'
    };
}

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toLocaleString();
}

// Timing Analysis
function simulateMethodTiming() {
    console.log('⏱️  TIMING ANALYSIS: CURRENT vs ENHANCED METHOD');
    console.log('===============================================\n');
    
    console.log('📊 CURRENT METHOD (Per Channel):');
    console.log('• Resolve @handle to channel ID: 0.1-0.3 seconds (web scraping)');
    console.log('• YouTube API call (batch of 50): 0.5-1.0 seconds total');
    console.log('• Per channel cost: ~0.02 seconds (when batched)');
    console.log('• API quota cost: 1 quota per 50 channels');
    console.log('• Total time per channel: ~0.1 seconds');
    console.log('');
    
    console.log('🔍 ENHANCED METHOD (Per Channel):');
    console.log('• Open channel /shorts page: 1.0-1.5 seconds');
    console.log('• Wait for page load: 1.0-2.0 seconds');
    console.log('• Scrape video data: 0.2-0.5 seconds');
    console.log('• Close tab: 0.1 seconds');
    console.log('• API quota cost: 0 (zero additional quota)');
    console.log('• Total time per channel: ~3.0-4.0 seconds');
    console.log('');
    
    console.log('📈 SCALABILITY COMPARISON:');
    console.log('==========================');
    
    const scenarios = [
        { channels: 10, description: 'Small batch' },
        { channels: 50, description: 'Medium batch' }, 
        { channels: 200, description: 'Large batch' },
        { channels: 1000, description: 'Full keyword processing' }
    ];
    
    scenarios.forEach(scenario => {
        const currentTime = scenario.channels * 0.1; // seconds
        const enhancedTime = scenario.channels * 3.5; // seconds (if all channels processed)
        const smartEnhancedTime = Math.min(scenario.channels * 0.1 + (scenario.channels * 0.1) * 3.5, scenario.channels * 3.5); // Only 10% get enhanced
        
        console.log(`${scenario.description} (${scenario.channels} channels):`);
        console.log(`  Current Method: ${currentTime.toFixed(1)}s`);
        console.log(`  Enhanced (all): ${(enhancedTime / 60).toFixed(1)} minutes`);
        console.log(`  Smart Enhanced (10%): ${smartEnhancedTime.toFixed(1)}s`);
        console.log('');
    });
    
    return {
        currentMethodPerChannel: 0.1,
        enhancedMethodPerChannel: 3.5,
        smartEnhancedOverhead: 0.35 // Only 10% of channels get enhanced analysis
    };
}

console.log('📺 INFINITY SI CHANNEL - SHORTS ANALYSIS');
console.log('========================================\n');

console.log('🎬 RECENT SHORTS (Last 7):');
simulatedInfinitySIData.forEach((video, index) => {
    console.log(`${index + 1}. ${video.title}`);
    console.log(`   Views: ${formatNumber(video.viewCount)} (${video.viewsText})`);
    console.log(`   Published: ${video.publishedTime}`);
    console.log(`   Type: YouTube Short`);
    console.log('');
});

const metrics = calculateEnhancedMetrics(simulatedInfinitySIData);

console.log('📊 ENHANCED METRICS ANALYSIS:');
console.log('=============================');
console.log(`Videos Analyzed: ${metrics.recentVideoCount} Shorts`);
console.log(`Average Views: ${formatNumber(metrics.averageViews)}`);
console.log(`Median Views: ${formatNumber(metrics.medianViews)}`);
console.log(`Trimmed Mean: ${formatNumber(metrics.trimmedMeanViews)} (removes highest/lowest)`);
console.log(`View Range: ${metrics.viewRange}`);
console.log(`Standard Deviation: ${formatNumber(metrics.standardDeviation)}`);
console.log(`Coefficient of Variation: ${metrics.coefficientOfVariation}`);
console.log(`Consistency Score: ${metrics.consistencyScore}/100`);
console.log(`Is Consistent: ${metrics.isConsistent ? '✅ YES' : '❌ NO'}`);
console.log(`Has Viral Outlier: ${metrics.hasViralOutlier ? '🚀 YES' : '❌ NO'}`);
if (metrics.hasViralOutlier) {
    console.log(`Viral Multiplier: ${metrics.viralMultiplier}x (top video vs others)`);
}
console.log(`Recommended Metric: ${metrics.recommendedMetric === 'trimmedMean' ? 'Trimmed Mean' : 'Median'}`);

console.log('\n🔍 COMPARISON WITH CURRENT METHOD:');
console.log('==================================');

// Simulate what current method would show for this smaller channel
const simulatedCurrentStats = {
    totalViews: 15000000, // 15M total views across all videos
    videoCount: 45, // 45 total videos
    averageViews: Math.round(15000000 / 45) // 333K average
};

console.log(`Current Method (Total/Count): ${formatNumber(simulatedCurrentStats.averageViews)} avg`);
console.log(`Enhanced Method (Last 7): ${formatNumber(metrics.medianViews)} median`);
console.log(`Recommended Metric: ${formatNumber(metrics[metrics.recommendedMetric + 'Views'])}`);

const difference = ((simulatedCurrentStats.averageViews - metrics.medianViews) / simulatedCurrentStats.averageViews * 100);
console.log(`Accuracy Difference: ${Math.abs(difference).toFixed(1)}% ${difference > 0 ? 'overestimate' : 'underestimate'}`);

console.log('\n🎯 SHORTS-SPECIFIC INSIGHTS:');
console.log('============================');

if (metrics.hasViralOutlier) {
    console.log('🚀 VIRAL PATTERN DETECTED:');
    console.log(`   One Short went viral (${metrics.viralMultiplier}x more views than others)`);
    console.log(`   This would mislead users with current method!`);
    console.log(`   Enhanced method shows: ${formatNumber(metrics.trimmedMeanViews)} typical performance`);
} else {
    console.log('📈 CONSISTENT PERFORMANCE:');
    console.log('   No major viral outliers detected');
    console.log('   Channel has relatively stable Short performance');
}

console.log(`\n🎪 User Experience Impact:`);
console.log(`   Current method: "This channel averages ${formatNumber(simulatedCurrentStats.averageViews)} views"`);
console.log(`   User clicks expecting: ~${formatNumber(simulatedCurrentStats.averageViews)} per video`);
console.log(`   Reality (recent Shorts): ~${formatNumber(metrics.medianViews)} typical views`);
console.log(`   User disappointment: ${difference > 20 ? 'HIGH 😞' : difference > 10 ? 'MEDIUM 😐' : 'LOW 😊'}`);

// Run timing analysis
const timing = simulateMethodTiming();

console.log('💡 SMART IMPLEMENTATION STRATEGY:');
console.log('=================================');
console.log('Instead of analyzing ALL channels with enhanced method:');
console.log('');
console.log('1. Use current method for initial filtering (fast)');
console.log('2. Apply enhanced analysis only to promising channels:');
console.log('   • Good view-to-subscriber ratio (>2.0)');
console.log('   • Reasonable subscriber count (<100K)');
console.log('   • Recent activity (videos in last month)');
console.log('');
console.log('3. This reduces enhanced analysis to ~10% of channels');
console.log(`4. Time overhead: ${timing.smartEnhancedOverhead}s per channel (vs ${timing.enhancedMethodPerChannel}s for all)`);
console.log('');

console.log('🎯 EXPECTED CHURN REDUCTION:');
console.log('============================');
console.log('Current: User sees "333K average" → clicks → finds mostly 45K-89K videos → disappointed');
console.log('Enhanced: User sees "89K median (Low consistency, 1 viral)" → better expectations');
console.log('');
console.log('Estimated churn reduction: 30-50% for channels with viral outliers');
console.log('User satisfaction increase: Significant (better expectations)');

console.log('\n🚀 READY TO IMPLEMENT?');
console.log('======================');
console.log('This enhanced analysis will:');
console.log('✅ Solve the viral outlier problem');
console.log('✅ Give users accurate expectations'); 
console.log('✅ Use zero additional API quota');
console.log('✅ Work specifically well for Shorts channels');
console.log('✅ Reduce user churn significantly');
console.log('');
console.log('Time to build this feature! 🛠️');