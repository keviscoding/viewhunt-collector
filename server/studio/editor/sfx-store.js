/**
 * SFX Store — Persists sound effect files in MongoDB.
 * Upload once, survives deploys forever.
 * 
 * Stores each SFX as a document with base64-encoded audio data.
 * On load, writes to temp disk for FFmpeg to use.
 */
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

var MONGODB_URI = process.env.MONGODB_URI || process.env.V2_MONGO_URI || process.env.MONGO_URI;
var COLLECTION = 'sfx_files';
var DB_NAME = 'viewhuntv2';
var LOCAL_DIR = path.join(__dirname, 'assets', 'sfx');

/**
 * Save an SFX file to MongoDB
 * @param {string} name - SFX name (hook, transition, riser)
 * @param {Buffer} fileBuffer - The audio file data
 * @param {string} originalName - Original filename for extension
 */
async function saveSfx(name, fileBuffer, originalName) {
    if (!MONGODB_URI) throw new Error('No MongoDB URI configured');

    var ext = path.extname(originalName) || '.mp3';
    var client = new MongoClient(MONGODB_URI);
    try {
        await client.connect();
        var db = client.db(DB_NAME);
        await db.collection(COLLECTION).updateOne(
            { name: name },
            {
                $set: {
                    name: name,
                    ext: ext,
                    data: fileBuffer.toString('base64'),
                    size: fileBuffer.length,
                    uploadedAt: new Date()
                }
            },
            { upsert: true }
        );
        console.log('✅ SFX "' + name + '" saved to MongoDB (' + (fileBuffer.length / 1024).toFixed(0) + 'KB)');

        // Also write locally so it's immediately available
        if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });
        fs.writeFileSync(path.join(LOCAL_DIR, name + ext), fileBuffer);

        return true;
    } finally {
        await client.close();
    }
}

/**
 * Load all SFX from MongoDB to local disk.
 * Call this on startup or before assembly.
 * Returns object with paths: { hook: '/path/hook.mp3', transition: null, ... }
 */
async function loadAllSfx() {
    if (!MONGODB_URI) {
        console.warn('No MongoDB URI — SFX not available');
        return { hook: null, transition: null, riser: null };
    }

    if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });

    var result = { hook: null, transition: null, riser: null };
    var client = new MongoClient(MONGODB_URI);
    try {
        await client.connect();
        var db = client.db(DB_NAME);
        var docs = await db.collection(COLLECTION).find({}).toArray();

        for (var i = 0; i < docs.length; i++) {
            var doc = docs[i];
            if (!doc.data || !doc.name) continue;
            var filePath = path.join(LOCAL_DIR, doc.name + (doc.ext || '.mp3'));
            fs.writeFileSync(filePath, Buffer.from(doc.data, 'base64'));
            result[doc.name] = filePath;
            console.log('  🔊 SFX "' + doc.name + '" loaded from MongoDB (' + (doc.size / 1024).toFixed(0) + 'KB)');
        }

        var loaded = Object.keys(result).filter(function(k) { return result[k]; });
        if (loaded.length > 0) {
            console.log('✅ SFX loaded: ' + loaded.join(', '));
        } else {
            console.log('🔇 No SFX in MongoDB yet');
        }
    } catch (err) {
        console.warn('SFX load from MongoDB failed:', err.message);
    } finally {
        await client.close();
    }

    return result;
}

/**
 * List SFX in MongoDB (for the GUI)
 */
async function listSfx() {
    if (!MONGODB_URI) return [];
    var client = new MongoClient(MONGODB_URI);
    try {
        await client.connect();
        var db = client.db(DB_NAME);
        var docs = await db.collection(COLLECTION).find({}, {
            projection: { name: 1, ext: 1, size: 1, uploadedAt: 1 }
        }).toArray();
        return docs.map(function(d) {
            return { name: d.name, filename: d.name + (d.ext || '.mp3'), size: d.size, uploadedAt: d.uploadedAt };
        });
    } catch (err) {
        console.warn('SFX list failed:', err.message);
        return [];
    } finally {
        await client.close();
    }
}

module.exports = { saveSfx, loadAllSfx, listSfx };
