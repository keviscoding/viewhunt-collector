/**
 * Persist training cache to MongoDB instead of filesystem
 * This solves the ephemeral filesystem issue on DigitalOcean
 */

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.V2_MONGO_URI || process.env.MONGO_URI;
const COLLECTION_NAME = 'training_cache';

async function saveTrainingCache(cache) {
    if (!MONGODB_URI) {
        console.error('No MongoDB URI configured — cannot save training cache');
        return false;
    }
    const client = new MongoClient(MONGODB_URI);
    try {
        await client.connect();
        const db = client.db('viewhuntv2');
        
        await db.collection(COLLECTION_NAME).updateOne(
            { type: 'skeleton-anatomy-v2' },
            { 
                $set: {
                    type: 'skeleton-anatomy-v2',
                    uploadedAt: cache.uploadedAt,
                    totalFiles: cache.totalFiles,
                    files: cache.files,
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        );
        
        console.log(`✅ Training cache saved to MongoDB (${cache.totalFiles} files)`);
        return true;
    } catch (error) {
        console.error('Failed to save training cache to MongoDB:', error.message);
        return false;
    } finally {
        await client.close();
    }
}

async function loadTrainingCache() {
    if (!MONGODB_URI) {
        console.warn('No MongoDB URI configured — cannot load training cache');
        return null;
    }
    const client = new MongoClient(MONGODB_URI);
    try {
        await client.connect();
        const db = client.db('viewhuntv2');
        
        const cache = await db.collection(COLLECTION_NAME).findOne({ 
            type: 'skeleton-anatomy-v2' 
        });
        
        if (cache && cache.files && cache.files.length > 0) {
            console.log(`✅ Loaded training cache from MongoDB: ${cache.files.length} files (uploaded ${cache.uploadedAt})`);
            return { 
                uploadedAt: cache.uploadedAt, 
                totalFiles: cache.totalFiles, 
                files: cache.files 
            };
        }
        
        console.warn('⚠️  No training cache found in MongoDB');
        return null;
    } catch (error) {
        console.error('Failed to load training cache from MongoDB:', error.message);
        return null;
    } finally {
        await client.close();
    }
}

module.exports = { saveTrainingCache, loadTrainingCache };
