const { MongoClient } = require('mongodb');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// YouTube API configuration
const YOUTUBE_API_KEY = 'AIzaSyBOJg1zOs4STy1MJdqdiFKnKzAUyNa-LdU';
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

async function migrateChannels() {
    console.log('🚀 Starting channel migration to add average views...');
    
    const client = new MongoClient(process.env.MONGODB_URI);
    
    try {
        await client.connect();
        const db = client.db('viewhuntv2');
        
        // Get all channels that don't have average_views field yet
        const channels = await db.collection('channels').find({
            $or: [
                { average_views: { $exists: false } },
                { video_count: { $exists: false } },
                { total_views: { $exists: false } }
            ]
        }).toArray();
        
        console.log(`📊 Found ${channels.length} channels to migrate`);
        
        if (channels.length === 0) {
            console.log('✅ All channels already have the new fields!');
            return;
        }
        
        // Extract channel IDs from URLs
        const channelsWithIds = channels.map(channel => {
            const channelId = extractChannelId(channel.channel_url);
            return {
                ...channel,
                realChannelId: channelId
            };
        }).filter(ch => ch.realChannelId); // Only process channels with valid IDs
        
        console.log(`🔍 Processing ${channelsWithIds.length} channels with valid IDs`);
        
        // Process in batches of 50 (YouTube API limit)
        const batchSize = 50;
        let processed = 0;
        let updated = 0;
        
        for (let i = 0; i < channelsWithIds.length; i += batchSize) {
            const batch = channelsWithIds.slice(i, i + batchSize);
            const channelIds = batch.map(ch => ch.realChannelId);
            
            console.log(`📡 Fetching batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(channelsWithIds.length/batchSize)} (${batch.length} channels)...`);
            
            try {
                const response = await fetch(
                    `${YOUTUBE_API_BASE}/channels?part=statistics&id=${channelIds.join(',')}&key=${YOUTUBE_API_KEY}`
                );
                
                if (!response.ok) {
                    console.error(`❌ API Error for batch: ${response.status}`);
                    continue;
                }
                
                const data = await response.json();
                
                // Update each channel in this batch
                for (const item of data.items || []) {
                    const channel = batch.find(ch => ch.realChannelId === item.id);
                    if (!channel) continue;
                    
                    const totalViews = parseInt(item.statistics.viewCount || 0);
                    const videoCount = parseInt(item.statistics.videoCount || 0);
                    const averageViews = videoCount > 0 ? Math.round(totalViews / videoCount) : 0;
                    
                    // Update in database
                    await db.collection('channels').updateOne(
                        { _id: channel._id },
                        {
                            $set: {
                                total_views: totalViews,
                                video_count: videoCount,
                                average_views: averageViews,
                                updated_at: new Date()
                            }
                        }
                    );
                    
                    updated++;
                    console.log(`✅ ${channel.channel_name}: ${averageViews.toLocaleString()} avg views (${videoCount} videos)`);
                }
                
                processed += batch.length;
                console.log(`📈 Progress: ${processed}/${channelsWithIds.length} processed, ${updated} updated`);
                
                // Small delay to be nice to the API
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (error) {
                console.error(`❌ Error processing batch:`, error.message);
            }
        }
        
        console.log(`🎉 Migration complete! Updated ${updated} channels with average views data`);
        
    } catch (error) {
        console.error('❌ Migration failed:', error);
    } finally {
        await client.close();
    }
}

// Extract channel ID from various YouTube URL formats
function extractChannelId(url) {
    if (!url) return null;
    
    // Handle different YouTube URL formats
    const patterns = [
        /youtube\.com\/channel\/([a-zA-Z0-9_-]+)/,
        /youtube\.com\/c\/([a-zA-Z0-9_-]+)/,
        /youtube\.com\/user\/([a-zA-Z0-9_-]+)/,
        /youtube\.com\/@([a-zA-Z0-9_-]+)/
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) {
            return match[1];
        }
    }
    
    return null;
}

// Run the migration
migrateChannels().then(() => {
    console.log('🏁 Migration script finished');
    process.exit(0);
}).catch(error => {
    console.error('💥 Migration script failed:', error);
    process.exit(1);
});