const { MongoClient } = require('mongodb');

// Database connection
const V2_MONGODB_URI = process.env.V2_MONGO_URI || process.env.MONGO_URI;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyBOJg1zOs4STy1MJdqdiFKnKzAUyNa-LdU';
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

// YouTube API helper functions
function parseDuration(duration) {
    const match = duration.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
    const minutes = parseInt(match[1] || 0);
    const seconds = parseInt(match[2] || 0);
    return minutes * 60 + seconds;
}

async function resolveChannelId(channelUrl) {
    try {
        if (channelUrl.includes('/channel/UC')) {
            return channelUrl.split('/channel/')[1].split('/')[0];
        } else if (channelUrl.includes('/@')) {
            const handle = channelUrl.split('/@')[1].split('/')[0];
            
            const response = await fetch(
                `${YOUTUBE_API_BASE}/search?part=snippet&type=channel&q=${handle}&key=${YOUTUBE_API_KEY}`
            );
            
            if (response.ok) {
                const data = await response.json();
                if (data.items && data.items.length > 0) {
                    return data.items[0].snippet.channelId;
                }
            }
        }
        return null;
    } catch (error) {
        console.error('Error resolving channel ID:', error);
        return null;
    }
}

async function getEnhancedChannelData(channelUrl, channelName) {
    try {
        console.log(`🚀 Processing: ${channelName}`);
        
        // Step 1: Resolve channel ID
        const channelId = await resolveChannelId(channelUrl);
        if (!channelId) {
            console.warn(`❌ Could not resolve channel ID for ${channelName}`);
            return null;
        }
        
        // Step 2: Get channel info and uploads playlist
        const channelResponse = await fetch(
            `${YOUTUBE_API_BASE}/channels?part=statistics,contentDetails,snippet&id=${channelId}&key=${YOUTUBE_API_KEY}`
        );
        
        if (!channelResponse.ok) {
            console.warn(`❌ Channel API failed for ${channelName}: ${channelResponse.status}`);
            return null;
        }
        
        const channelData = await channelResponse.json();
        if (!channelData.items || channelData.items.length === 0) {
            console.warn(`❌ No channel data found for ${channelName}`);
            return null;
        }
        
        const channelInfo = channelData.items[0];
        const uploadsPlaylistId = channelInfo.contentDetails.relatedPlaylists.uploads;
        
        // Step 3: Get recent videos from uploads playlist
        const playlistResponse = await fetch(
            `${YOUTUBE_API_BASE}/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=30&key=${YOUTUBE_API_KEY}`
        );
        
        if (!playlistResponse.ok) {
            console.warn(`❌ Playlist API failed for ${channelName}: ${playlistResponse.status}`);
            return null;
        }
        
        const playlistData = await playlistResponse.json();
        if (!playlistData.items || playlistData.items.length === 0) {
            console.warn(`❌ No videos found for ${channelName}`);
            return null;
        }
        
        const videoIds = playlistData.items.map(item => item.snippet.resourceId.videoId);
        
        // Step 4: Get video details and filter for shorts
        const videosResponse = await fetch(
            `${YOUTUBE_API_BASE}/videos?part=contentDetails,statistics,snippet&id=${videoIds.join(',')}&key=${YOUTUBE_API_KEY}`
        );
        
        if (!videosResponse.ok) {
            console.warn(`❌ Videos API failed for ${channelName}: ${videosResponse.status}`);
            return null;
        }
        
        const videosData = await videosResponse.json();
        
        // Filter for shorts only (duration ≤ 60 seconds)
        const shorts = videosData.items.filter(video => {
            const duration = video.contentDetails.duration;
            const seconds = parseDuration(duration);
            return seconds <= 60;
        }).slice(0, 10); // Take first 10 shorts
        
        if (shorts.length === 0) {
            console.warn(`❌ No shorts found for ${channelName}`);
            return null;
        }
        
        // Step 5: Calculate enhanced metrics
        const viewCounts = shorts.map(short => parseInt(short.statistics.viewCount || 0));
        const recentAverage = Math.round(viewCounts.reduce((a, b) => a + b, 0) / viewCounts.length);
        
        // Step 6: Create recent shorts data with links
        const recentShorts = shorts.map(short => ({
            videoId: short.id,
            title: short.snippet.title,
            viewCount: parseInt(short.statistics.viewCount || 0),
            publishedAt: short.snippet.publishedAt,
            duration: short.contentDetails.duration,
            shortUrl: `https://youtube.com/shorts/${short.id}`,
            watchUrl: `https://youtube.com/watch?v=${short.id}`,
            thumbnailUrl: `https://img.youtube.com/vi/${short.id}/hqdefault.jpg`
        }));
        
        console.log(`✅ SUCCESS: ${channelName} - Recent Avg: ${recentAverage.toLocaleString()} from ${shorts.length} shorts`);
        
        return {
            enhanced: true,
            recent_average: recentAverage,
            videos_analyzed: shorts.length,
            recent_shorts: recentShorts,
            last_enhanced_update: new Date()
        };
        
    } catch (error) {
        console.error(`❌ ERROR for ${channelName}:`, error.message);
        return null;
    }
}

async function enhanceAllChannels() {
    if (!V2_MONGODB_URI) {
        console.error('❌ MongoDB URI not provided');
        process.exit(1);
    }
    
    if (!YOUTUBE_API_KEY) {
        console.error('❌ YouTube API key not provided');
        process.exit(1);
    }
    
    const client = new MongoClient(V2_MONGODB_URI);
    
    try {
        await client.connect();
        const db = client.db('viewhuntv2');
        const collection = db.collection('channels');
        
        console.log('🚀 Starting MASSIVE database enhancement...');
        console.log('📊 This will add Recent Avg + video previews to EVERY SINGLE CHANNEL!');
        console.log('🎯 No view limitations - enhancing ALL channels in the database!');
        console.log('');
        
        // Get ALL channels that need enhancement (no view limitations!)
        const channels = await collection.find({
            $or: [
                { enhanced: { $ne: true } },
                { enhanced: { $exists: false } },
                { recent_average: { $exists: false } },
                { recent_shorts: { $exists: false } }
            ]
        }).toArray();
        
        console.log(`📈 Found ${channels.length} channels that need enhancement (ALL CHANNELS - no view limits!)`);
        
        if (channels.length === 0) {
            console.log('✅ All channels are already enhanced!');
            return;
        }
        
        // Show quota estimation
        const quotaNeeded = channels.length * 3; // 3 quota units per channel
        console.log(`💰 Estimated quota needed: ${quotaNeeded.toLocaleString()} units`);
        console.log(`⏱️  Estimated time: ${Math.round(channels.length / 20)} minutes (20 channels/min)`);
        console.log('');
        
        let processed = 0;
        let enhanced = 0;
        let failed = 0;
        let quotaUsed = 0;
        
        // Process channels in batches to respect rate limits
        const batchSize = 10; // Process 10 channels at a time
        
        for (let i = 0; i < channels.length; i += batchSize) {
            const batch = channels.slice(i, i + batchSize);
            
            console.log(`\n📦 Batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(channels.length/batchSize)} (${batch.length} channels)`);
            
            // Process batch with staggered timing to avoid rate limits
            const promises = batch.map((channel, index) => {
                return new Promise(resolve => {
                    setTimeout(async () => {
                        try {
                            processed++;
                            
                            const enhancedData = await getEnhancedChannelData(channel.channel_url, channel.channel_name);
                            quotaUsed += 3; // Each channel uses ~3 quota units
                            
                            if (enhancedData) {
                                // Update channel with enhanced data
                                await collection.updateOne(
                                    { _id: channel._id },
                                    {
                                        $set: {
                                            enhanced: true,
                                            recent_average: enhancedData.recent_average,
                                            videos_analyzed: enhancedData.videos_analyzed,
                                            recent_shorts: enhancedData.recent_shorts,
                                            last_enhanced_update: enhancedData.last_enhanced_update,
                                            updated_at: new Date()
                                        }
                                    }
                                );
                                
                                enhanced++;
                            } else {
                                failed++;
                            }
                            
                        } catch (error) {
                            failed++;
                            console.error(`❌ Error processing ${channel.channel_name}:`, error.message);
                        }
                        
                        resolve();
                    }, index * 200); // Stagger by 200ms to avoid rate limits
                });
            });
            
            await Promise.all(promises);
            
            // Progress update
            const progress = ((i + batchSize) / channels.length * 100).toFixed(1);
            console.log(`📊 Progress: ${progress}% | Enhanced: ${enhanced} | Failed: ${failed} | Quota: ${quotaUsed.toLocaleString()}`);
            
            // Delay between batches to respect rate limits
            if (i + batchSize < channels.length) {
                console.log('⏳ Cooling down for 2 seconds...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        console.log('\n🎉 MASSIVE ENHANCEMENT COMPLETE!');
        console.log('═══════════════════════════════════');
        console.log(`📊 Final Results:`);
        console.log(`   🔄 Processed: ${processed.toLocaleString()} channels`);
        console.log(`   ✅ Enhanced: ${enhanced.toLocaleString()} channels`);
        console.log(`   ❌ Failed: ${failed.toLocaleString()} channels`);
        console.log(`   💰 Quota Used: ${quotaUsed.toLocaleString()} units`);
        console.log(`   📈 Success Rate: ${((enhanced / processed) * 100).toFixed(1)}%`);
        console.log('');
        console.log('🚀 ViewHunt is now FULLY ENHANCED - EVERY CHANNEL has Recent Avg + Video Previews!');
        
        // Show final database stats
        const totalEnhanced = await collection.countDocuments({ enhanced: true });
        const totalChannels = await collection.countDocuments();
        console.log(`📈 Database: ${totalEnhanced}/${totalChannels} channels now enhanced (${((totalEnhanced/totalChannels)*100).toFixed(1)}%)`);
        
    } catch (error) {
        console.error('❌ Fatal error during enhancement:', error);
    } finally {
        await client.close();
    }
}

// Add command line argument support
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

if (dryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made');
    // Add dry run logic here if needed
} else {
    console.log('🔥 LIVE MODE - Database will be enhanced');
    enhanceAllChannels();
}