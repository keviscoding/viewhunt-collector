const { MongoClient } = require('mongodb');

// Use built-in fetch (Node 18+) or require node-fetch for older versions
const fetch = globalThis.fetch || require('node-fetch');

// Database connection
const V2_MONGODB_URI = process.env.V2_MONGO_URI || process.env.MONGO_URI;
const APIFY_TOKEN = process.env.APIFY_TOKEN;

// Enhanced analysis function (copied from server.js)
function calculateEnhancedMetrics(videos) {
    if (!videos || videos.length === 0) return null;
    
    // Get view counts from recent videos (last 7-10)
    const recentVideos = videos.slice(0, Math.min(10, videos.length));
    const viewCounts = recentVideos
        .map(v => v.view_count || 0)
        .filter(count => count > 0)
        .sort((a, b) => b - a);
    
    console.log(`calculateEnhancedMetrics: Processing ${recentVideos.length} videos`);
    console.log(`View counts (sorted):`, viewCounts);
    
    if (viewCounts.length === 0) {
        return {
            enhanced: false,
            reason: 'No valid view counts found'
        };
    }
    
    const mean = viewCounts.reduce((a, b) => a + b) / viewCounts.length;
    const median = viewCounts[Math.floor(viewCounts.length / 2)];
    
    console.log(`Calculation: mean=${Math.round(mean)}, median=${Math.round(median)}`);
    
    // Trimmed mean (remove highest and lowest to reduce outlier impact)
    let trimmedMean = mean;
    if (viewCounts.length >= 3) {
        const trimmed = viewCounts.slice(1, -1);
        trimmedMean = trimmed.reduce((a, b) => a + b) / trimmed.length;
    }
    
    // Consistency score (lower coefficient of variation = more consistent)
    const variance = viewCounts.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / viewCounts.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = mean > 0 ? stdDev / mean : 0;
    const consistencyScore = Math.max(0, 100 - (coefficientOfVariation * 100));
    
    // Detect viral outliers
    const maxView = Math.max(...viewCounts);
    const avgWithoutMax = viewCounts.filter(v => v !== maxView).reduce((a, b) => a + b, 0) / (viewCounts.length - 1);
    const viralMultiplier = avgWithoutMax > 0 ? maxView / avgWithoutMax : 1;
    const hasViralOutlier = viralMultiplier > 4;
    
    // Performance trend (comparing first half vs second half)
    const firstHalf = viewCounts.slice(0, Math.ceil(viewCounts.length / 2));
    const secondHalf = viewCounts.slice(Math.ceil(viewCounts.length / 2));
    const firstHalfAvg = firstHalf.reduce((a, b) => a + b) / firstHalf.length;
    const secondHalfAvg = secondHalf.reduce((a, b) => a + b) / secondHalf.length;
    const trendPercentage = Math.round(((firstHalfAvg - secondHalfAvg) / secondHalfAvg) * 100);
    
    let trendDirection = 'STABLE';
    if (Math.abs(trendPercentage) >= 15) {
        trendDirection = trendPercentage > 0 ? 'IMPROVING' : 'DECLINING';
    }
    
    // Count shorts vs regular videos
    const shortsCount = recentVideos.filter(v => v.short === true || v.type === 'short').length;
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
        hasViralOutlier,
        viralMultiplier: hasViralOutlier ? parseFloat(viralMultiplier.toFixed(1)) : null,
        
        // Performance insights
        trendDirection,
        trendPercentage,
        
        // Content breakdown
        shortsCount,
        regularCount,
        videosAnalyzed: recentVideos.length,
        
        // Quality indicators
        isConsistent: consistencyScore > 70,
        distributionIssue: Math.abs(mean - median) / mean > 0.3,
        
        // View range for context
        viewRange: {
            min: Math.min(...viewCounts),
            max: Math.max(...viewCounts)
        }
    };
}

// Get enhanced channel data from Apify
async function getEnhancedChannelData(channelUrl, channelName) {
    if (!APIFY_TOKEN) {
        console.error('APIFY_TOKEN not configured');
        return null;
    }
    
    try {
        console.log(`Calling Apify for channel data: ${channelName}`);
        
        const apifyResponse = await fetch(`https://api.apify.com/v2/acts/maged120~youtube-channel-data/run-sync-get-dataset-items?token=${APIFY_TOKEN}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                channel_identifier: channelUrl,
                max_results: 10,
                select_types: ["short"],
                sleep_interval: 1,
                max_retries: 2
            })
        });
        
        if (!apifyResponse.ok) {
            console.error(`Apify API error for ${channelName}: ${apifyResponse.status}`);
            return null;
        }
        
        const apifyData = await apifyResponse.json();
        console.log(`Apify returned ${apifyData.length} videos for ${channelName}`);
        
        if (!Array.isArray(apifyData) || apifyData.length === 0) {
            console.log(`No valid data returned for ${channelName}`);
            return null;
        }
        
        // Transform Apify data to our expected format
        const videos = apifyData.map(video => ({
            view_count: parseInt(video.viewCount || video.view_count || video.views) || 0,
            short: video.isShort || video.is_short || video.type === 'short' || false,
            type: video.isShort || video.is_short || video.type === 'short' ? 'short' : 'video',
            title: video.title || 'Unknown',
            video_id: video.videoId || video.video_id || video.id
        })).filter(v => v.view_count > 0);
        
        console.log(`Processed ${videos.length} valid videos for ${channelName}`);
        
        if (videos.length === 0) {
            return null;
        }
        
        // Calculate enhanced metrics
        const enhancedMetrics = calculateEnhancedMetrics(videos);
        
        if (!enhancedMetrics) {
            return null;
        }
        
        return {
            enhanced: true,
            ...enhancedMetrics,
            lastUpdated: new Date()
        };
        
    } catch (error) {
        console.error(`Error getting enhanced data for ${channelName}:`, error.message);
        return null;
    }
}

async function enhanceRecentChannels() {
    if (!V2_MONGODB_URI) {
        console.error('MongoDB URI not provided');
        process.exit(1);
    }
    
    if (!APIFY_TOKEN) {
        console.error('APIFY_TOKEN not provided');
        process.exit(1);
    }
    
    const client = new MongoClient(V2_MONGODB_URI);
    
    try {
        await client.connect();
        const db = client.db('viewhuntv2');
        const collection = db.collection('channels');
        
        console.log('🚀 Starting enhanced analysis for recent channels...');
        
        // Find last 500 channels that:
        // 1. Have 500K+ average views
        // 2. Don't already have enhanced data
        // 3. Are ordered by creation date (newest first)
        const channels = await collection.find({
            average_views: { $gte: 500000 },
            $or: [
                { enhanced: { $ne: true } },
                { enhanced: { $exists: false } },
                { recent_average: { $exists: false } }
            ]
        })
        .sort({ created_at: -1 })
        .limit(500)
        .toArray();
        
        console.log(`Found ${channels.length} channels that need enhanced analysis`);
        
        if (channels.length === 0) {
            console.log('No channels need enhancement. Exiting.');
            return;
        }
        
        let processed = 0;
        let enhanced = 0;
        let failed = 0;
        
        // Process channels in batches of 3 with delays
        const batchSize = 3;
        
        for (let i = 0; i < channels.length; i += batchSize) {
            const batch = channels.slice(i, i + batchSize);
            
            console.log(`\n📊 Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(channels.length/batchSize)} (${batch.length} channels)`);
            
            // Process batch in parallel with staggered start
            const promises = batch.map((channel, index) => {
                return new Promise(resolve => {
                    setTimeout(async () => {
                        try {
                            processed++;
                            console.log(`[${processed}/${channels.length}] Processing: ${channel.channel_name}`);
                            
                            const enhancedData = await getEnhancedChannelData(channel.channel_url, channel.channel_name);
                            
                            if (enhancedData) {
                                // Update channel with enhanced data
                                await collection.updateOne(
                                    { _id: channel._id },
                                    {
                                        $set: {
                                            enhanced: true,
                                            recent_average: enhancedData.recentAverage,
                                            recent_mean: enhancedData.recentMean,
                                            recent_median: enhancedData.recentMedian,
                                            recent_trimmed_mean: enhancedData.recentTrimmedMean,
                                            consistency_score: enhancedData.consistencyScore,
                                            has_viral_outlier: enhancedData.hasViralOutlier,
                                            is_consistent: enhancedData.isConsistent,
                                            trend_direction: enhancedData.trendDirection,
                                            trend_percentage: enhancedData.trendPercentage,
                                            shorts_count: enhancedData.shortsCount,
                                            regular_count: enhancedData.regularCount,
                                            videos_analyzed: enhancedData.videosAnalyzed,
                                            viral_multiplier: enhancedData.viralMultiplier,
                                            distribution_issue: enhancedData.distributionIssue,
                                            view_range_min: enhancedData.viewRange?.min,
                                            view_range_max: enhancedData.viewRange?.max,
                                            last_enhanced_update: enhancedData.lastUpdated,
                                            updated_at: new Date()
                                        }
                                    }
                                );
                                
                                enhanced++;
                                console.log(`✅ Enhanced: ${channel.channel_name} - Recent Avg: ${enhancedData.recentAverage}`);
                            } else {
                                failed++;
                                console.log(`❌ Failed: ${channel.channel_name}`);
                            }
                            
                        } catch (error) {
                            failed++;
                            console.error(`❌ Error processing ${channel.channel_name}:`, error.message);
                        }
                        
                        resolve();
                    }, index * 500); // Stagger by 500ms
                });
            });
            
            await Promise.all(promises);
            
            // Delay between batches
            if (i + batchSize < channels.length) {
                console.log('⏳ Waiting 2 seconds before next batch...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        console.log('\n🎉 Enhancement complete!');
        console.log(`📊 Results:`);
        console.log(`   - Processed: ${processed} channels`);
        console.log(`   - Enhanced: ${enhanced} channels`);
        console.log(`   - Failed: ${failed} channels`);
        console.log(`   - Success rate: ${((enhanced / processed) * 100).toFixed(1)}%`);
        
    } catch (error) {
        console.error('❌ Error during enhancement:', error);
    } finally {
        await client.close();
    }
}

// Run the enhancement
console.log('🔄 Starting background enhancement of recent channels...');
enhanceRecentChannels();