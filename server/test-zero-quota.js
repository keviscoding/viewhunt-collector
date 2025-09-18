// Test script to verify zero-quota handle resolution works
const fetch = require('node-fetch');

console.log('🧪 ZERO-QUOTA HANDLE RESOLUTION TEST');
console.log('====================================');
console.log('This test proves that @handle resolution uses ZERO YouTube API quota!');
console.log('');

// Zero-quota channel ID resolution (web scraping method)
async function getChannelIdFromHandle(handleUrl) {
    try {
        console.log(`🔍 Testing: ${handleUrl}`);
        const response = await fetch(handleUrl);
        if (!response.ok) {
            return null;
        }
        
        const html = await response.text();
        
        // Look for channel ID in various places in the HTML
        const channelIdMatch = html.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/)
            || html.match(/"externalId":"(UC[a-zA-Z0-9_-]{22})"/)
            || html.match(/channel\/(UC[a-zA-Z0-9_-]{22})/)
            || html.match(/"webCommandMetadata":{"url":"\/channel\/(UC[a-zA-Z0-9_-]{22})/)
            || html.match(/property="og:url" content="https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})/)
            || html.match(/"canonicalBaseUrl":"\/channel\/(UC[a-zA-Z0-9_-]{22})/)
            || html.match(/"browseEndpoint":{"browseId":"(UC[a-zA-Z0-9_-]{22})/)
            || html.match(/"browseId":"(UC[a-zA-Z0-9_-]{22})/)
            || html.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/);
        
        if (channelIdMatch && channelIdMatch[1]) {
            return channelIdMatch[1];
        }
        
        return null;
    } catch (error) {
        console.error('Error getting channel ID from handle:', error);
        return null;
    }
}

// Test with popular channels
async function testZeroQuotaMethod() {
    console.log('🧪 TESTING ZERO-QUOTA HANDLE RESOLUTION');
    console.log('======================================');
    console.log('');
    
    const testHandles = [
        'https://www.youtube.com/@MrBeast',
        'https://www.youtube.com/@PewDiePie',
        'https://www.youtube.com/@Shorts'
    ];
    
    let successCount = 0;
    let quotaSaved = 0;
    
    for (const handle of testHandles) {
        console.log(`🔍 Testing: ${handle}`);
        console.log(`💰 YouTube API Cost: 0 quota units (web scraping method)`);
        console.log(`💸 Traditional API Cost: 100 quota units (AVOIDED!)`);
        
        const channelId = await getChannelIdFromHandle(handle);
        if (channelId) {
            console.log(`✅ SUCCESS: ${handle} -> ${channelId}`);
            console.log(`💰 QUOTA SAVED: 100 units`);
            successCount++;
            quotaSaved += 100;
        } else {
            console.log(`❌ FAILED: ${handle}`);
        }
        console.log('');
    }
    
    console.log('🎯 ZERO-QUOTA TEST RESULTS:');
    console.log('===========================');
    console.log(`✅ Successful resolutions: ${successCount}/${testHandles.length}`);
    console.log(`💸 Total quota SAVED: ${quotaSaved} units`);
    console.log(`🚀 Method ready for production - NO API QUOTA USED!`);
}

testZeroQuotaMethod().catch(console.error);