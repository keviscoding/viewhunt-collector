import { MongoClient, ObjectId } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

// YouTube API configuration
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const MONGODB_URI = process.env.MONGO_URI;

// Admin user ID (nwalikelv@gmail.com)
const ADMIN_EMAIL = 'nwalikelv@gmail.com';

// Channel URLs to add
const channelUrls = [
    'https://www.youtube.com/@TyranitarShortz/shorts',
    'https://www.youtube.com/@creepyammy',
    'https://www.youtube.com/@EarthlyYT',
    'https://www.youtube.com/@AstroMax0/shorts',
    'https://www.youtube.com/@ClipCognize',
    'https://www.youtube.com/@SwiftPrep',
    'https://www.youtube.com/@Mr.Moments-d9e',
    'https://www.youtube.com/@MoodPops',
    'https://www.youtube.com/@Zoomifyz',
    'https://www.youtube.com/@KuboxRBLX/shorts',
    'https://www.youtube.com/@FACTOPHIDIA5',
    'https://www.youtube.com/@TheDailyFactsBoy',
    'https://www.youtube.com/@GMOoff',
    'https://www.youtube.com/@MoonlightFlim777',
    'https://www.youtube.com/@chillvibeoasis/shorts',
    'https://www.youtube.com/@MindDoop',
    'https://www.youtube.com/@meowmeowzar13',
    'https://www.youtube.com/@camozy',
    'https://www.youtube.com/@ArunStoriez',
    'https://www.youtube.com/@InfisDiary',
    'https://www.youtube.com/@dearmomentvh',
    'https://www.youtube.com/@StrangeSeconds19',
    'https://www.youtube.com/@safariclips',
    'https://www.youtube.com/@ZaviixEdits',
    'https://www.youtube.com/@neptunes8/shorts',
    'https://www.youtube.com/@CopyMaster11',
    'https://www.youtube.com/@Larewayne',
    'https://www.youtube.com/@yasoproduction',
    'https://www.youtube.com/@Fast_lane0',
    'https://www.youtube.com/@FingersFacts',
    'https://www.youtube.com/@JouMotivation',
    'https://www.youtube.com/@Oddsyyy',
    'https://www.youtube.com/@madnessranks',
    'https://www.youtube.com/@LovingPets/shorts',
    'https://www.youtube.com/@Puppy-Fever',
    'https://www.youtube.com/@Beggydone/shorts',
    'https://www.youtube.com/channel/UC5QESDRf1F0v1Ig8KHpCVCQ'
];

// Extract channel handle or ID from URL
function extractChannelIdentifier(url) {
    if (url.includes('/@')) {
        const match = url.match(/@([^\/]+)/);
        return match ? match[1] : null;
    } else if (url.includes('/channel/')) {
        const match = url.match(/channel\/([^\/]+)/);
        return match ? match[1] : null;
    }
    return null;
}

// Get channel data from YouTube API
async function getChannelData(channelIdentifier) {
    try {
        let searchUrl;
        if (channelIdentifier.startsWith('UC')) {
            // Channel ID
            searchUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelIdentifier}&key=${YOUTUBE_API_KEY}`;
        } else {
            // Channel handle
            searchUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&forHandle=${channelIdentifier}&key=${YOUTUBE_API_KEY}`;
        }

        const response = await fetch(searchUrl);
        const data = await response.json();

        if (data.items && data.items.length > 0) {
            const channel = data.items[0];
            return {
                channelId: channel.id,
                channelName: channel.snippet.title,
                channelUrl: `https://www.youtube.com/channel/${channel.id}`,
                subscriberCount: parseInt(channel.statistics.subscriberCount) || 0,
                videoCount: parseInt(channel.statistics.videoCount) || 0,
                totalViews: parseInt(channel.statistics.viewCount) || 0,
                avatarUrl: channel.snippet.thumbnails?.default?.url || null,
                description: channel.snippet.description || ''
            };
        }
        return null;
    } catch (error) {
        console.error(`Error fetching channel data for ${channelIdentifier}:`, error);
        return null;
    }
}

// Get recent videos for a channel to calculate shorts percentage and get sample video
async function getChannelVideos(channelId) {
    try {
        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channelId}&type=video&order=date&maxResults=50&key=${YOUTUBE_API_KEY}`;
        const response = await fetch(searchUrl);
        const data = await response.json();

        if (data.items && data.items.length > 0) {
            // Get video details to check duration (shorts are < 60 seconds)
            const videoIds = data.items.map(item => item.id.videoId).join(',');
            const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${videoIds}&key=${YOUTUBE_API_KEY}`;
            const detailsResponse = await fetch(detailsUrl);
            const detailsData = await detailsResponse.json();

            let shortsCount = 0;
            let sampleVideo = null;
            let maxViews = 0;

            detailsData.items.forEach((video, index) => {
                const duration = video.contentDetails.duration;
                const viewCount = parseInt(video.statistics.viewCount) || 0;

                // Check if it's a short (duration < 60 seconds)
                const isShort = parseDuration(duration) < 60;
                if (isShort) {
                    shortsCount++;
                }

                // Get the video with most views as sample
                if (viewCount > maxViews) {
                    maxViews = viewCount;
                    sampleVideo = {
                        videoId: video.id,
                        title: data.items[index].snippet.title,
                        viewCount: viewCount,
                        thumbnailUrl: data.items[index].snippet.thumbnails?.high?.url || 
                                     `https://img.youtube.com/vi/${video.id}/hqdefault.jpg`,
                        videoUrl: `https://www.youtube.com/watch?v=${video.id}`
                    };
                }
            });

            const shortsPercentage = (shortsCount / detailsData.items.length) * 100;
            const averageViews = detailsData.items.reduce((sum, video) => 
                sum + (parseInt(video.statistics.viewCount) || 0), 0) / detailsData.items.length;

            return {
                shortsPercentage: Math.round(shortsPercentage),
                averageViews: Math.round(averageViews),
                sampleVideo
            };
        }

        return { shortsPercentage: 0, averageViews: 0, sampleVideo: null };
    } catch (error) {
        console.error(`Error fetching videos for channel ${channelId}:`, error);
        return { shortsPercentage: 0, averageViews: 0, sampleVideo: null };
    }
}

// Parse YouTube duration format (PT1M30S) to seconds
function parseDuration(duration) {
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;
    
    const hours = parseInt(match[1]) || 0;
    const minutes = parseInt(match[2]) || 0;
    const seconds = parseInt(match[3]) || 0;
    
    return hours * 3600 + minutes * 60 + seconds;
}

async function main() {
    console.log('Starting manual channel addition process...');
    
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db('viewhuntv2');

    // Get admin user
    const adminUser = await db.collection('users').findOne({ email: ADMIN_EMAIL });
    if (!adminUser) {
        console.error('Admin user not found!');
        return;
    }
    console.log(`Found admin user: ${adminUser.display_name}`);

    // Create "New Niches" collection if it doesn't exist
    let newNichesCollection = await db.collection('collections').findOne({
        user_id: adminUser._id,
        name: 'New Niches'
    });

    if (!newNichesCollection) {
        const collectionResult = await db.collection('collections').insertOne({
            user_id: adminUser._id,
            name: 'New Niches',
            description: 'Manually curated new niche channels',
            is_public: false,
            created_at: new Date(),
            updated_at: new Date()
        });
        newNichesCollection = { _id: collectionResult.insertedId, name: 'New Niches' };
        console.log('Created "New Niches" collection');
    }

    const addedChannels = [];
    const collectionChannelIds = [];

    for (const url of channelUrls) {
        console.log(`\nProcessing: ${url}`);
        
        const channelIdentifier = extractChannelIdentifier(url);
        if (!channelIdentifier) {
            console.log(`Could not extract channel identifier from: ${url}`);
            continue;
        }

        // Check if channel already exists
        const existingChannel = await db.collection('channels').findOne({
            channel_url: { $regex: channelIdentifier, $options: 'i' }
        });

        if (existingChannel) {
            console.log(`Channel already exists: ${existingChannel.channel_name}`);
            collectionChannelIds.push(existingChannel._id);
            continue;
        }

        // Get channel data from YouTube API
        const channelData = await getChannelData(channelIdentifier);
        if (!channelData) {
            console.log(`Could not fetch data for: ${channelIdentifier}`);
            continue;
        }

        console.log(`Found channel: ${channelData.channelName} (${channelData.subscriberCount} subs)`);

        // Get video data
        const videoData = await getChannelVideos(channelData.channelId);

        // Calculate view-to-subscriber ratio
        const viewToSubRatio = channelData.subscriberCount > 0 ? 
            (videoData.averageViews / channelData.subscriberCount) : 0;

        // Create channel document
        const channelDoc = {
            channel_name: channelData.channelName,
            channel_url: channelData.channelUrl,
            video_title: videoData.sampleVideo?.title || 'Sample Video',
            view_count: videoData.sampleVideo?.viewCount || videoData.averageViews,
            subscriber_count: channelData.subscriberCount,
            view_to_sub_ratio: viewToSubRatio,
            avatar_url: channelData.avatarUrl,
            video_url: videoData.sampleVideo?.videoUrl || null,
            thumbnail_url: videoData.sampleVideo?.thumbnailUrl || null,
            total_views: channelData.totalViews,
            video_count: channelData.videoCount,
            average_views: videoData.averageViews,
            shorts_percentage: videoData.shortsPercentage,
            status: 'approved',
            approved_by: adminUser._id,
            approved_at: new Date(),
            first_approval_time: new Date(),
            approval_count: 1,
            created_at: new Date(),
            updated_at: new Date()
        };

        // Insert channel
        const result = await db.collection('channels').insertOne(channelDoc);
        addedChannels.push({
            _id: result.insertedId,
            name: channelData.channelName,
            subs: channelData.subscriberCount,
            ratio: viewToSubRatio.toFixed(2)
        });
        collectionChannelIds.push(result.insertedId);

        console.log(`✅ Added: ${channelData.channelName} (Ratio: ${viewToSubRatio.toFixed(2)})`);

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Add all channels to the "New Niches" collection
    if (collectionChannelIds.length > 0) {
        const collectionChannels = collectionChannelIds.map(channelId => ({
            collection_id: newNichesCollection._id,
            channel_id: channelId,
            added_at: new Date()
        }));

        await db.collection('collection_channels').insertMany(collectionChannels);

        // Update collection channel count
        await db.collection('collections').updateOne(
            { _id: newNichesCollection._id },
            { 
                $set: { 
                    channel_count: collectionChannelIds.length,
                    updated_at: new Date()
                }
            }
        );

        console.log(`\n📚 Added ${collectionChannelIds.length} channels to "New Niches" collection`);
    }

    console.log(`\n🎉 Process complete!`);
    console.log(`📊 Summary:`);
    console.log(`- Total channels processed: ${channelUrls.length}`);
    console.log(`- New channels added: ${addedChannels.length}`);
    console.log(`- Channels in "New Niches" collection: ${collectionChannelIds.length}`);

    if (addedChannels.length > 0) {
        console.log(`\n🏆 Top channels by view-to-sub ratio:`);
        addedChannels
            .sort((a, b) => parseFloat(b.ratio) - parseFloat(a.ratio))
            .slice(0, 5)
            .forEach((channel, index) => {
                console.log(`${index + 1}. ${channel.name} - ${channel.subs.toLocaleString()} subs (${channel.ratio} ratio)`);
            });
    }

    await client.close();
}

main().catch(console.error);