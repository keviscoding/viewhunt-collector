/**
 * Shared MongoDB connection pool for studio modules.
 * 
 * Instead of creating a new MongoClient per function call,
 * this module maintains a single persistent connection with
 * a connection pool. All studio code should use getDb() to
 * get a database reference.
 * 
 * Connection pool defaults:
 *   - maxPoolSize: 5 (conservative for 256MB container)
 *   - minPoolSize: 1 (keep at least 1 connection warm)
 *   - maxIdleTimeMS: 30s (close idle connections quickly)
 *   - serverSelectionTimeoutMS: 5s (fail fast)
 */
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || process.env.V2_MONGO_URI || process.env.MONGO_URI;
const DB_NAME = 'viewhuntv2';

let client = null;
let db = null;
let connecting = null; // prevents multiple simultaneous connect attempts

async function getDb() {
    if (db) return db;

    // If another call is already connecting, wait for it
    if (connecting) {
        await connecting;
        return db;
    }

    connecting = (async () => {
        client = new MongoClient(MONGODB_URI, {
            maxPoolSize: 5,
            minPoolSize: 1,
            maxIdleTimeMS: 30000,
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 5000
        });
        await client.connect();
        db = client.db(DB_NAME);
        console.log('🔌 Studio DB pool connected (maxPoolSize: 5)');
    })();

    await connecting;
    connecting = null;
    return db;
}

/**
 * Get the raw MongoClient (needed for transactions).
 */
async function getClient() {
    if (!client) await getDb();
    return client;
}

/**
 * Graceful shutdown — call on process exit.
 */
async function closePool() {
    if (client) {
        await client.close();
        client = null;
        db = null;
        console.log('🔌 Studio DB pool closed');
    }
}

module.exports = { getDb, getClient, closePool };
