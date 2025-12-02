const { MongoClient } = require('mongodb');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function debugInviteCode() {
    const MONGO_URI = process.env.V2_MONGO_URI || process.env.MONGO_URI;
    const client = new MongoClient(MONGO_URI);
    
    try {
        await client.connect();
        const db = client.db('viewhuntv2');
        
        const code = 'VH-TEST01';
        
        // Get the raw document
        const doc = await db.collection('invite_codes').findOne({ code: code });
        
        console.log('Raw document:');
        console.log(JSON.stringify(doc, null, 2));
        
        console.log('\n\nField types:');
        console.log('active type:', typeof doc.active, '| value:', doc.active);
        console.log('expires_at type:', typeof doc.expires_at, '| value:', doc.expires_at);
        console.log('expires_at exists:', doc.hasOwnProperty('expires_at'));
        
        // Test the exact query from registration
        console.log('\n\nTesting registration query...');
        const testQuery = { 
            code: code,
            active: true,
            $or: [
                { expires_at: { $exists: false } },
                { expires_at: null },
                { expires_at: { $gt: new Date() } }
            ]
        };
        
        console.log('Query:', JSON.stringify(testQuery, null, 2));
        
        const result = await db.collection('invite_codes').findOne(testQuery);
        console.log('\nResult:', result ? '✅ FOUND' : '❌ NOT FOUND');
        
        if (!result) {
            // Test each condition separately
            console.log('\n\nTesting conditions separately:');
            
            const test1 = await db.collection('invite_codes').findOne({ code: code });
            console.log('1. Code exists:', test1 ? '✅' : '❌');
            
            const test2 = await db.collection('invite_codes').findOne({ code: code, active: true });
            console.log('2. Code + active=true:', test2 ? '✅' : '❌');
            
            const test3 = await db.collection('invite_codes').findOne({ 
                code: code, 
                expires_at: { $exists: false } 
            });
            console.log('3. Code + expires_at not exists:', test3 ? '✅' : '❌');
            
            const test4 = await db.collection('invite_codes').findOne({ 
                code: code,
                active: true,
                expires_at: { $exists: false }
            });
            console.log('4. Code + active + expires_at not exists:', test4 ? '✅' : '❌');
        }
        
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await client.close();
    }
}

debugInviteCode();
