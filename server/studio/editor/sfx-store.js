/**
 * SFX Store — Persists sound effect files in MongoDB.
 * Upload once, survives deploys forever.
 * 
 * Stores each SFX as a document with base64-encoded audio data.
 * On load, writes to temp disk for FFmpeg to use.
 * 
 * Uses shared connection pool (db.js).
 */
const { getDb } = require('../../studio/db');
const fs = require('fs');
const path = require('path');

var COLLECTION = 'sfx_files';
var LOCAL_DIR = path.join(__dirname, 'assets', 'sfx');

/**
 * Save an SFX file to MongoDB
 */
async function saveSfx(name, fileBuffer, originalName) {
    var ext = path.extname(originalName) || '.mp3';
    var db = await getDb();
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
}

/**
 * Load all SFX from MongoDB to local disk.
 * Returns object with paths: { hook: '/path/hook.mp3', transition: null, ... }
 */
async function loadAllSfx() {
    if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });
    var result = { hook: null, transition: null, riser: null, bgmusic: null };

    try {
        var db = await getDb();
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
    }

    return result;
}

/**
 * List SFX in MongoDB (for the GUI)
 */
async function listSfx() {
    try {
        var db = await getDb();
        var docs = await db.collection(COLLECTION).find({}, {
            projection: { name: 1, ext: 1, size: 1, uploadedAt: 1 }
        }).toArray();
        return docs.map(function(d) {
            return { name: d.name, filename: d.name + (d.ext || '.mp3'), size: d.size, uploadedAt: d.uploadedAt };
        });
    } catch (err) {
        console.warn('SFX list failed:', err.message);
        return [];
    }
}

module.exports = { saveSfx, loadAllSfx, listSfx };
