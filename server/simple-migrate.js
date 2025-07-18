const { MongoClient } = require('mongodb');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// YouTube API configuration
const YOUTUBE_API_KEY = 'AIzaSyBOJg1zOs4STy1MJdqdiFKnKzAUyNa-LdU';
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

async function simpleMigration() {
    console.log('🚀 Starting SIMPLE channel migration...');
    
    const client = new MongoClient(process.env.MONGODB_URI);
    
    try {
        await client.connect();
        const db = client.db('viewhuntv2');
        
        // Get ALL channels
        const channels = await db.collection('channels').find({}).toArray();
        console.log(`📊 Found ${channels.length} total channels`);
        
        let updated = 0;
        let processed = 0;
        
        // Process channels one by one with handles
        for (const channel of channels) {
            processed++;
            
            if (processed % 50 === 0) {
                console.log(`📈 Progress: ${processed}/${channels.length} processed, ${updated} updated`);
            }
            
            try {
                // Extract handle from URL
                const handle = extractHandle(channel.channel_url);
                if (!handle) continue;
                
                // Call YouTube API for this specific channel
                const response = await fetch(
                    `${YOUTUBE_API_BASE}/channels?part=statistics&forHandle=${handle}&key=${YOUTUBE_API_KEY}`
                );
                
                if (!response.ok) continue;
                
                const data = await response.json();
                if (!data.items || data.items.length === 0) continue;
                
                const item = data.items[0];
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
                
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
                
            } catch (error) {
                console.error(`❌ Error processing ${channel.channel_name}:`, error.message);
            }
        }
        
        console.log(`🎉 Simple migration complete! Updated ${updated}/${processed} channels`);
        
    } catch (error) {
        console.error('❌ Migration failed:', error);
    } finally {
        await client.close();
    }
}

// Extract handle from YouTube URL
function extractHandle(url) {
    if (!url) return null;
    
    // Handle @username format
    const match = url.match(/youtube\.com\/@([^/?]+)/);
    if (match) {
        return match[1];
    }
    
    return null;
}

// Run the migration
simpleMigration().then(() => {
    console.log('🏁 Simple migration finished');
    process.exit(0);
}).catch(error => {
    console.error('💥 Simple migration failed:', error);
    process.exit(1);
});