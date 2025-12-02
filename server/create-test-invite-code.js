const { MongoClient } = require('mongodb');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function createTestInviteCode() {
    const MONGO_URI = process.env.V2_MONGO_URI || process.env.MONGO_URI;
    const client = new MongoClient(MONGO_URI);
    
    try {
        await client.connect();
        const db = client.db('viewhuntv2');
        
        console.log('✅ Connected to MongoDB\n');
        
        // Create a test invite code
        const inviteCode = 'VH-TEST01';
        
        // Check if it already exists
        const existing = await db.collection('invite_codes').findOne({ code: inviteCode });
        if (existing) {
            console.log('⚠️  Code already exists:', inviteCode);
            console.log('   Active:', existing.active);
            console.log('   Used:', existing.used_count || 0);
            return;
        }
        
        const inviteCodeDoc = {
            code: inviteCode,
            description: 'Test invite code',
            created_at: new Date(),
            expires_at: null, // Never expires
            max_uses: null, // Unlimited uses
            used_count: 0,
            used_by: [],
            active: true
        };
        
        await db.collection('invite_codes').insertOne(inviteCodeDoc);
        
        console.log('🎉 TEST INVITE CODE CREATED!\n');
        console.log('═══════════════════════════════════════');
        console.log('Code:', inviteCode);
        console.log('Description:', inviteCodeDoc.description);
        console.log('Expires:', 'Never');
        console.log('Max Uses:', 'Unlimited');
        console.log('Active:', '✅ YES');
        console.log('═══════════════════════════════════════\n');
        console.log('✅ Users can now register with this code!');
        console.log('   Try registering at: https://viewhunt.app/app');
        
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await client.close();
    }
}

createTestInviteCode();
