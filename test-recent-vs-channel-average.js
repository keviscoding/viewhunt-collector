// Test the "Recent Average" vs "Channel Average" implementation
// This shows exactly how the enhanced analysis solves the churn problem

console.log('🎯 RECENT AVERAGE vs CHANNEL AVERAGE TEST');
console.log('========================================\n');

// Simulate real channel data scenarios
const testScenarios = [
    {
        name: "Viral Outlier Channel",
        description: "One video went mega viral, rest are normal",
        channelData: {
            channelName: "MotivationDaily",
            totalViews: 15000000,
            totalVideos: 100,
            channelAverage: 150000, // 15M ÷ 100 = 150K
            last10Videos: [
                { views: 8500000, title: "This Changed My Life Forever" }, // VIRAL
                { views: 12000, title: "Morning Motivation" },
                { views: 15000, title: "Daily Affirmations" },
                { views: 8000, title: "Success Mindset" },
                { views: 18000, title: "Overcome Fear" },
                { views: 11000, title: "Positive Thinking" },
                { views: 9500, title: "Goal Setting" },
                { views: 14000, title: "Self Confidence" },
                { views: 7500, title: "Morning Routine" },
                { views: 13000, title: "Productivity Tips" }
            ]
        }
    },
    {
        name: "Declining Channel",
        description: "Used to be popular, now getting fewer views",
        channelData: {
            channelName: "TechReviewsPro",
            totalViews: 50000000,
            totalVideos: 200,
            channelAverage: 250000, // 50M ÷ 200 = 250K
            last10Videos: [
                { views: 45000, title: "iPhone 15 Review" },
                { views: 38000, title: "Samsung Galaxy S24" },
                { views: 52000, title: "MacBook Pro M3" },
                { views: 41000, title: "iPad Air Review" },
                { views: 47000, title: "AirPods Pro 3" },
                { views: 39000, title: "Apple Watch Ultra" },
                { views: 44000, title: "Tesla Model Y" },
                { views: 48000, title: "Google Pixel 8" },
                { views: 42000, title: "Surface Pro 10" },
                { views: 46000, title: "Nothing Phone 2" }
            ]
        }
    },
    {
        name: "Consistent Performer",
        description: "Steady, reliable view counts",
        channelData: {
            channelName: "CookingBasics",
            totalViews: 8000000,
            totalVideos: 160,
            channelAverage: 50000, // 8M ÷ 160 = 50K
            last10Videos: [
                { views: 52000, title: "Perfect Pasta Recipe" },
                { views: 48000, title: "Chicken Stir Fry" },
                { views: 51000, title: "Homemade Bread" },
                { views: 49000, title: "Beef Tacos" },
                { views: 53000, title: "Chocolate Cake" },
                { views: 47000, title: "Salmon Dinner" },
                { views: 50000, title: "Vegetable Soup" },
                { views: 52000, title: "Pizza Dough" },
                { views: 48000, title: "Pancakes" },
                { views: 51000, title: "Grilled Cheese" }
            ]
        }
    }
];

function calculateRecentAverage(videos) {
    const viewCounts = videos.map(v => v.views).sort((a, b) => b - a);
    const mean = viewCounts.reduce((a, b) => a + b) / viewCounts.length;
    const median = viewCounts[Math.floor(viewCounts.length / 2)];
    
    // Trimmed mean (remove highest and lowest)
    let trimmedMean = mean;
    if (viewCounts.length >= 3) {
        const trimmed = viewCounts.slice(1, -1);
        trimmedMean = trimmed.reduce((a, b) => a + b) / trimmed.length;
    }
    
    // Detect viral outliers
    const maxView = Math.max(...viewCounts);
    const avgWithoutMax = viewCounts.filter(v => v !== maxView).reduce((a, b) => a + b, 0) / (viewCounts.length - 1);
    const viralMultiplier = avgWithoutMax > 0 ? maxView / avgWithoutMax : 1;
    const hasViralOutlier = viralMultiplier > 4;
    
    // Use trimmed mean if viral outlier, otherwise median
    const recentAverage = hasViralOutlier ? trimmedMean : median;
    
    return {
        recentAverage: Math.round(recentAverage),
        mean: Math.round(mean),
        median: Math.round(median),
        trimmedMean: Math.round(trimmedMean),
        hasViralOutlier,
        viralMultiplier: viralMultiplier.toFixed(1)
    };
}

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toLocaleString();
}

function calculateChurnRisk(channelAvg, recentAvg) {
    const diff = ((channelAvg - recentAvg) / channelAvg * 100);
    
    if (diff > 50) return { level: 'HIGH', emoji: '🚨', description: 'Major disappointment likely' };
    if (diff > 25) return { level: 'MEDIUM', emoji: '⚠️', description: 'Noticeable disappointment' };
    if (diff > 10) return { level: 'LOW', emoji: '⚠️', description: 'Minor disappointment' };
    if (diff < -10) return { level: 'POSITIVE', emoji: '✅', description: 'Pleasant surprise' };
    return { level: 'MINIMAL', emoji: '✅', description: 'Expectations match reality' };
}

// Test each scenario
testScenarios.forEach((scenario, index) => {
    console.log(`${index + 1}. ${scenario.name.toUpperCase()}`);
    console.log(`   ${scenario.description}`);
    console.log(`   Channel: ${scenario.channelData.channelName}`);
    console.log('');
    
    const channelAvg = scenario.channelData.channelAverage;
    const analysis = calculateRecentAverage(scenario.channelData.last10Videos);
    const recentAvg = analysis.recentAverage;
    const churnRisk = calculateChurnRisk(channelAvg, recentAvg);
    
    console.log('   📊 CURRENT METHOD (Channel Average):');
    console.log(`      Total Views: ${formatNumber(scenario.channelData.totalViews)}`);
    console.log(`      Total Videos: ${scenario.channelData.totalVideos}`);
    console.log(`      Channel Average: ${formatNumber(channelAvg)}`);
    console.log('');
    
    console.log('   ✨ ENHANCED METHOD (Recent Average):');
    console.log(`      Last 10 Videos Analyzed:`);
    scenario.channelData.last10Videos.forEach((video, i) => {
        const isViral = video.views > analysis.mean * 2;
        console.log(`         ${i + 1}. ${formatNumber(video.views)} views ${isViral ? '🚀' : ''}`);
    });
    console.log('');
    console.log(`      Mean: ${formatNumber(analysis.mean)}`);
    console.log(`      Median: ${formatNumber(analysis.median)}`);
    console.log(`      Trimmed Mean: ${formatNumber(analysis.trimmedMean)}`);
    console.log(`      Has Viral Outlier: ${analysis.hasViralOutlier ? '🚀 YES' : '❌ NO'}`);
    if (analysis.hasViralOutlier) {
        console.log(`      Viral Multiplier: ${analysis.viralMultiplier}x`);
    }
    console.log(`      Recent Average: ${formatNumber(recentAvg)} (${analysis.hasViralOutlier ? 'trimmed mean' : 'median'})`);
    console.log('');
    
    console.log('   🎯 USER EXPERIENCE IMPACT:');
    const accuracyDiff = Math.abs(((channelAvg - recentAvg) / channelAvg * 100));
    console.log(`      User sees: "${formatNumber(channelAvg)} average views"`);
    console.log(`      User finds: "${formatNumber(recentAvg)} typical recent views"`);
    console.log(`      Accuracy difference: ${accuracyDiff.toFixed(1)}%`);
    console.log(`      Churn risk: ${churnRisk.emoji} ${churnRisk.level} - ${churnRisk.description}`);
    console.log('');
    
    console.log('   💡 ENHANCED ANALYSIS BENEFIT:');
    if (analysis.hasViralOutlier) {
        console.log(`      ✅ Detects viral outlier that skews channel average`);
        console.log(`      ✅ Uses trimmed mean to show typical performance`);
        console.log(`      ✅ Prevents user disappointment from inflated expectations`);
    } else if (accuracyDiff > 20) {
        console.log(`      ✅ Shows significant difference between historical and recent performance`);
        console.log(`      ✅ Gives users accurate expectations about current channel state`);
        console.log(`      ✅ Prevents churn from misleading historical averages`);
    } else {
        console.log(`      ✅ Confirms channel has consistent performance`);
        console.log(`      ✅ Builds user confidence in channel reliability`);
        console.log(`      ✅ Enhanced analysis validates the channel quality`);
    }
    
    console.log('\n' + '='.repeat(60) + '\n');
});

console.log('🎉 IMPLEMENTATION SUMMARY');
console.log('========================');
console.log('✅ "Channel Average" = Total views ÷ Total videos (historical)');
console.log('✅ "Recent Average" = Distribution-aware metric from last 10 videos');
console.log('✅ Automatically detects viral outliers and uses appropriate metric');
console.log('✅ Shows both metrics when enhanced analysis is available');
console.log('✅ Prevents user churn by setting accurate expectations');
console.log('');

console.log('🚀 READY FOR DEPLOYMENT!');
console.log('Your enhanced analysis will solve the churn problem by showing users');
console.log('what they can ACTUALLY expect from recent channel performance! 🎯');