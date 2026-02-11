/**
 * Persist training cache to MongoDB instead of filesystem.
 * Uses shared connection pool (db.js).
 */
const { getDb } = require('../../db');

const COLLECTION_NAME = 'training_cache';

async function saveTrainingCache(cache) {
    try {
        var db = await getDb();
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
        console.log('✅ Training cache saved to MongoDB (' + cache.totalFiles + ' files)');
        return true;
    } catch (error) {
        console.error('Failed to save training cache to MongoDB:', error.message);
        return false;
    }
}

async function loadTrainingCache() {
    try {
        var db = await getDb();
        var cache = await db.collection(COLLECTION_NAME).findOne({ 
            type: 'skeleton-anatomy-v2' 
        });
        
        if (cache && cache.files && cache.files.length > 0) {
            console.log('✅ Loaded training cache from MongoDB: ' + cache.files.length + ' files (uploaded ' + cache.uploadedAt + ')');
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
    }
}

module.exports = { saveTrainingCache, loadTrainingCache };
