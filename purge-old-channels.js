const { MongoClient } = require('mongodb');

// Database connection
const V2_MONGODB_URI = process.env.V2_MONGO_URI || process.env.MONGO_URI;

async function purgeOldChannels() {
    if (!V2_MONGODB_URI) {
        console.error('MongoDB URI not provided');
        process.exit(1);
    }

    const client = new MongoClient(V2_MONGODB_URI);
    
    try {
        await client.connect();
        const db = client.db('viewhuntv2');
        const collection = db.collection('channels');
        
        // Count total channels before purge
        const totalBefore = await collection.countDocuments();
        console.log(`Total channels before purge: ${totalBefore}`);
        
        // Count PENDING channels without enhanced data (keep approved channels safe)
        const nonEnhancedCount = await collection.countDocuments({
            status: 'pending', // Only target pending channels
            $or: [
                { enhanced: { $ne: true } },
                { enhanced: { $exists: false } },
                { recent_average: { $exists: false } }
            ]
        });
        console.log(`Pending channels without enhanced data: ${nonEnhancedCount}`);
        
        // Count approved channels (should be preserved)
        const approvedCount = await collection.countDocuments({ status: 'approved' });
        console.log(`Approved channels (will be preserved): ${approvedCount}`);
        
        // Purge ONLY pending channels without enhanced data
        const result = await collection.deleteMany({
            status: 'pending', // Only delete pending channels
            $or: [
                { enhanced: { $ne: true } },
                { enhanced: { $exists: false } },
                { recent_average: { $exists: false } }
            ]
        });
        
        console.log(`Deleted ${result.deletedCount} channels without enhanced data`);
        
        // Count remaining channels
        const totalAfter = await collection.countDocuments();
        console.log(`Total channels after purge: ${totalAfter}`);
        
        // Show sample of remaining channels
        const sampleChannels = await collection.find({ enhanced: true }).limit(5).toArray();
        console.log('\nSample remaining channels:');
        sampleChannels.forEach(channel => {
            console.log(`- ${channel.channel_name}: enhanced=${channel.enhanced}, recent_avg=${channel.recent_average}`);
        });
        
    } catch (error) {
        console.error('Error during purge:', error);
    } finally {
        await client.close();
    }
}

// Run the purge
purgeOldChannels();