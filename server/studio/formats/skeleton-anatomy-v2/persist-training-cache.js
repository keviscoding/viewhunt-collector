/**
 * Persist training cache to MongoDB instead of filesystem
 * This solves the ephemeral filesystem issue on DigitalOcean
 */

const { MongoClient } = require('mongodb');
require('dotenv').config();

const MONGODB_URI = process.env.V2_MONGO_URI || process.env.MONGO_URI;
const COLLECTION_NAME = 'training_cache';

async function saveTrainingCache(cache) {
    const client = new MongoClient(MONGODB_URI);
    try {
        await client.connect();
        const db = client.db('viewhuntv2');
        
        // Upsert the cache (only one document needed)
        await db.collection(COLLECTION_NAME).updateOne(
            { type: 'skeleton-anatomy-v2' },
            { 
                $set: {
                    type: 'skeleton-anatomy-v2',
                    ...cache,
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        );
        
        console.log('✅ Training cache saved to MongoDB');
        return true;
    } catch (error) {
        console.error('Failed to save training cache to MongoDB:', error);
        return false;
    } finally {
        await client.close();
    }
}

async function loadTrainingCache() {
    const client = new MongoClient(MONGODB_URI);
    try {
        await client.connect();
        const db = client.db('viewhuntv2');
        
        const cache = await db.collection(COLLECTION_NAME).findOne({ 
            type: 'skeleton-anatomy-v2' 
        });
        
        if (cache) {
            console.log(`✅ Loaded training cache from MongoDB: ${cache.images?.length || 0} images, ${cache.videos?.length || 0} videos`);
            return cache;
        }
        
        console.warn('⚠️  No training cache found in MongoDB');
        return null;
    } catch (error) {
        console.error('Failed to load training cache from MongoDB:', error);
        return null;
    } finally {
        await client.close();
    }
}

module.exports = { saveTrainingCache, loadTrainingCache };
