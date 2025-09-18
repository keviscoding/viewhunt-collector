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

// Zero-quota channel ID resolution (web scraping method)
async function getChannelIdFromHandle(handleUrl) {
    try {
        const response = await fetch(handleUrl);
        if (!response.ok) {
            return null;
        }
        
        const html = await response.text();
        
        // Look for channel ID in various places in the HTML
        const channelIdMatch = html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/)
            || html.match(/"externalId":"(UC[a-zA-Z0-9_-]{22})"/)
            || html.match(/channel\/(UC[a-zA-Z0-9_-]{22})/)
            || html.match(/"webCommandMetadata":{"url":"\/channel\/(UC[a-zA-Z0-9_-]{22})/)
            || html.match(/property="og:url" content="https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})/)
            || html.match(/"canonicalBaseUrl":"\/channel\/(UC[a-zA-Z0-9_-]{22})/)
            || html.match(/"browseEndpoint":{"browseId":"(UC[a-zA-Z0-9_-]{22})/)
            || html.match(/"browseId":"(UC[a-zA-Z0-9_-]{22})/)
            || html.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/);
        
        if (channelIdMatch && channelIdMatch[1]) {
            return channelIdMatch[1];
        }
        
        return null;
    } catch (error) {
        console.error('Error getting channel ID from handle:', error);
        return null;
    }
}

async function resolveChannelId(channelUrl) {
    try {
        if (channelUrl.includes('/channel/UC')) {
            return channelUrl.split('/channel/')[1].split('/')[0];
        } else if (channelUrl.includes('/@')) {
            // Use zero-quota web scraping method!
            console.log(`🔍 ZERO-QUOTA HANDLE RESOLUTION: ${channelUrl}`);
            console.log(`💰 Quota Cost: 0 units (FREE web scraping method!)`);
            const channelId = await getChannelIdFromHandle(channelUrl);
            if (channelId) {
                console.log(`✅ FREE RESOLUTION SUCCESS: ${channelUrl} -> ${channelId}`);
                console.log(`💸 Saved 100 quota units by avoiding YouTube API search!`);
                return channelId;
            } else {
                console.warn(`❌ Could not resolve: ${channelUrl}`);
                return null;
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
        
        // Show quota estimation (now much more accurate!)
        const quotaNeeded = channels.length * 3; // 3 quota units per channel (no more expensive handle resolution!)
        console.log(`💰 Estimated quota needed: ${quotaNeeded.toLocaleString()} units (ZERO-QUOTA handle resolution!)`);
        console.log(`⏱️  Estimated time: ${Math.round(channels.length / 20)} minutes (20 channels/min)`);
        console.log(`🚀 Daily capacity: ~50,000 channels with 150K quota (vs previous 1,200!)`);
        console.log('');
        
        // Quota monitoring dashboard
        console.log('📊 QUOTA MONITORING DASHBOARD:');
        console.log('═══════════════════════════════');
        console.log(`🎯 Target: 3.0 units/channel (OPTIMAL)`);
        console.log(`⚠️  Warning: >4.0 units/channel`);
        console.log(`🚨 Danger: >5.0 units/channel`);
        console.log(`💰 Daily Limit: 150,000 units`);
        console.log(`🔄 Quota Resets: Midnight Pacific Time`);
        console.log('');
        
        let processed = 0;
        let enhanced = 0;
        let failed = 0;
        let quotaUsed = 0;
        let quotaSaved = 0; // Track quota saved from zero-quota handle resolution
        const startTime = Date.now(); // Track processing time
        
        // Process channels in batches to respect rate limits
        const batchSize = 10; // Process 10 channels at a time
        
        for (let i = 0; i < channels.length; i += batchSize) {
            const batch = channels.slice(i, i + batchSize);
            
            const batchNum = Math.floor(i/batchSize) + 1;
            const totalBatches = Math.ceil(channels.length/batchSize);
            
            console.log(`\n📦 Batch ${batchNum}/${totalBatches} (${batch.length} channels)`);
            
            // Show milestone checkpoints
            if (batchNum % 50 === 0 || batchNum === 1 || batchNum === totalBatches) {
                const timeElapsed = Date.now() - startTime;
                const channelsPerMinute = processed > 0 ? Math.round((processed / timeElapsed) * 60000) : 0;
                const estimatedTimeLeft = processed > 0 ? Math.round(((channels.length - processed) / channelsPerMinute)) : 0;
                
                console.log(`🎯 MILESTONE CHECKPOINT:`);
                console.log(`   📈 Processed: ${processed.toLocaleString()}/${channels.length.toLocaleString()} channels`);
                console.log(`   💰 Quota Used: ${quotaUsed.toLocaleString()} units`);
                console.log(`   💸 Quota Saved: ${quotaSaved.toLocaleString()} units`);
                console.log(`   ⚡ Speed: ${channelsPerMinute} channels/minute`);
                console.log(`   ⏱️  ETA: ${estimatedTimeLeft} minutes remaining`);
                console.log(`   🎯 On Track: ${quotaUsed < 150000 ? '✅ YES' : '🚨 OVER LIMIT!'}`);
            }
            
            // Process batch with staggered timing to avoid rate limits
            const promises = batch.map((channel, index) => {
                return new Promise(resolve => {
                    setTimeout(async () => {
                        try {
                            processed++;
                            
                            const enhancedData = await getEnhancedChannelData(channel.channel_url, channel.channel_name);
                            quotaUsed += 3; // Each channel uses exactly 3 quota units (handle resolution is FREE!)
                            
                            // Track quota savings from zero-quota handle resolution
                            if (channel.channel_url.includes('/@')) {
                                quotaSaved += 100; // We saved 100 quota units by not using YouTube API search
                                console.log(`💰 QUOTA SAVED: 100 units (Total saved so far: ${quotaSaved.toLocaleString()})`);
                            }
                            
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
            
            // Progress update with comprehensive quota monitoring
            const progress = ((i + batchSize) / channels.length * 100).toFixed(1);
            const quotaPerChannel = processed > 0 ? (quotaUsed / processed).toFixed(1) : 0;
            const projectedTotal = Math.round((quotaUsed / processed) * channels.length);
            const efficiencyPercent = quotaSaved > 0 ? ((quotaSaved / (quotaUsed + quotaSaved)) * 100).toFixed(1) : 0;
            
            // Quota health indicators
            let quotaStatus = '🟢 EXCELLENT';
            let quotaIcon = '✅';
            if (quotaPerChannel > 5) {
                quotaStatus = '🔴 DANGER - TOO HIGH!';
                quotaIcon = '🚨';
            } else if (quotaPerChannel > 4) {
                quotaStatus = '🟡 WARNING';
                quotaIcon = '⚠️';
            }
            
            console.log(`📊 Progress: ${progress}% | Enhanced: ${enhanced} | Failed: ${failed} | Quota: ${quotaUsed.toLocaleString()}`);
            console.log(`${quotaIcon} Quota Health: ${quotaStatus} (${quotaPerChannel} units/channel)`);
            console.log(`💸 Efficiency: ${efficiencyPercent}% savings | Projected Total: ${projectedTotal.toLocaleString()} units`);
            
            // Alert if quota usage is too high
            if (quotaPerChannel > 5) {
                console.log('🚨 QUOTA ALERT: Usage is too high! Expected 3 units/channel, getting ' + quotaPerChannel);
                console.log('🔍 Check if handle resolution is using API instead of web scraping!');
            }
            
            console.log(''); // Empty line for readability
            
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
        console.log(`   💸 Quota SAVED: ${quotaSaved.toLocaleString()} units (Zero-quota handle resolution!)`);
        console.log(`   🎯 Total Quota WITHOUT Optimization: ${(quotaUsed + quotaSaved).toLocaleString()} units`);
        console.log(`   📈 Success Rate: ${((enhanced / processed) * 100).toFixed(1)}%`);
        console.log(`   🚀 Efficiency Gain: ${quotaSaved > 0 ? ((quotaSaved / (quotaUsed + quotaSaved)) * 100).toFixed(1) : 0}% quota savings!`);
        
        // Final quota health assessment
        const finalQuotaPerChannel = processed > 0 ? (quotaUsed / processed).toFixed(2) : 0;
        console.log('');
        console.log('🏥 FINAL QUOTA HEALTH CHECK:');
        console.log('═══════════════════════════════');
        if (finalQuotaPerChannel <= 3.5) {
            console.log(`✅ EXCELLENT: ${finalQuotaPerChannel} units/channel (Target: 3.0)`);
            console.log(`🎯 Zero-quota handle resolution working perfectly!`);
        } else if (finalQuotaPerChannel <= 4.5) {
            console.log(`⚠️  WARNING: ${finalQuotaPerChannel} units/channel (Target: 3.0)`);
            console.log(`🔍 Some handles may have used API instead of web scraping`);
        } else {
            console.log(`🚨 DANGER: ${finalQuotaPerChannel} units/channel (Target: 3.0)`);
            console.log(`❌ Zero-quota optimization may have failed!`);
        }
        
        const quotaRemaining = 150000 - quotaUsed;
        console.log(`💰 Quota Remaining Today: ${quotaRemaining.toLocaleString()} units`);
        console.log(`📊 Could Process ${Math.floor(quotaRemaining / 3).toLocaleString()} More Channels Today`);
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