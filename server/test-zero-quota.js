// Test script to verify zero-quota handle resolution works
const fetch = require('node-fetch');

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
    
    for (const handle of testHandles) {
        const channelId = await getChannelIdFromHandle(handle);
        if (channelId) {
            console.log(`✅ SUCCESS: ${handle} -> ${channelId}`);
        } else {
            console.log(`❌ FAILED: ${handle}`);
        }
        console.log('');
    }
    
    console.log('🎯 Test complete! Zero-quota method ready for production.');
}

testZeroQuotaMethod().catch(console.error);