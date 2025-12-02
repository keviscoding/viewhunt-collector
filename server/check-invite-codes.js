const { MongoClient } = require('mongodb');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

async function checkInviteCodes() {
    const MONGO_URI = process.env.V2_MONGO_URI || process.env.MONGO_URI;
    const client = new MongoClient(MONGO_URI);
    
    try {
        await client.connect();
        const db = client.db('viewhuntv2');
        
        console.log('✅ Connected to MongoDB\n');
        
        // Get all invite codes
        const inviteCodes = await db.collection('invite_codes').find({}).toArray();
        
        console.log(`📊 Total invite codes: ${inviteCodes.length}\n`);
        
        if (inviteCodes.length === 0) {
            console.log('⚠️  No invite codes found in database!');
            console.log('   Create one using the admin panel or API endpoint');
            return;
        }
        
        for (const code of inviteCodes) {
            console.log('═══════════════════════════════════════');
            console.log('Code:', code.code);
            console.log('Active:', code.active ? '✅ YES' : '❌ NO');
            console.log('Description:', code.description || 'N/A');
            console.log('Created:', code.created_at?.toLocaleDateString() || 'N/A');
            console.log('Expires:', code.expires_at ? code.expires_at.toLocaleDateString() : 'Never');
            console.log('Max Uses:', code.max_uses || 'Unlimited');
            console.log('Used Count:', code.used_count || 0);
            
            // Check if expired
            if (code.expires_at && new Date(code.expires_at) < new Date()) {
                console.log('⚠️  STATUS: EXPIRED');
            } else if (!code.active) {
                console.log('⚠️  STATUS: DEACTIVATED');
            } else if (code.max_uses && code.used_count >= code.max_uses) {
                console.log('⚠️  STATUS: USAGE LIMIT REACHED');
            } else {
                console.log('✅ STATUS: VALID');
            }
            
            if (code.used_by && code.used_by.length > 0) {
                console.log('\nUsed by:');
                code.used_by.forEach((user, i) => {
                    console.log(`  ${i + 1}. ${user.email} (${user.used_at?.toLocaleDateString()})`);
                });
            }
            console.log('');
        }
        
        // Test a specific code if provided
        const testCode = process.argv[2];
        if (testCode) {
            console.log('\n🔍 TESTING CODE:', testCode);
            console.log('═══════════════════════════════════════');
            
            const inviteCodeDoc = await db.collection('invite_codes').findOne({ 
                code: testCode,
                active: true,
                $or: [
                    { expires_at: { $exists: false } },
                    { expires_at: { $gt: new Date() } }
                ]
            });
            
            if (!inviteCodeDoc) {
                console.log('❌ Code NOT FOUND or INVALID');
                console.log('   Reasons:');
                console.log('   - Code does not exist');
                console.log('   - Code is deactivated (active: false)');
                console.log('   - Code is expired');
            } else {
                console.log('✅ Code is VALID!');
                console.log('   Can be used for registration');
                
                if (inviteCodeDoc.max_uses && inviteCodeDoc.used_count >= inviteCodeDoc.max_uses) {
                    console.log('   ⚠️  BUT usage limit reached!');
                }
            }
        }
        
    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        await client.close();
    }
}

// Run with: node server/check-invite-codes.js [CODE_TO_TEST]
checkInviteCodes();
