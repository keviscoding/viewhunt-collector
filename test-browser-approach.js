// Test if we can use the Chrome extension's existing content script approach
// to get channel video data

console.log('🧪 TESTING BROWSER-BASED CHANNEL SCRAPING');
console.log('This simulates what we could do in the Chrome extension...\n');

// Simulate what the extension could do:
// 1. Navigate to a channel's videos page
// 2. Use DOM scraping (like content.js does for search results)
// 3. Extract recent video data

const testChannels = [
    'https://www.youtube.com/@MrBeast/videos',
    'https://www.youtube.com/@PewDiePie/videos',
    'https://www.youtube.com/@MarkRober/videos'
];

// This is what we could inject into a channel page
const channelScrapingScript = `
// This would run in the browser context (like content.js)
function scrapeChannelVideos() {
    console.log('ViewHunt: Scraping channel videos...');
    
    const videos = [];
    
    // Look for video elements on the channel page
    const videoSelectors = [
        'ytd-rich-item-renderer',           // Main video items
        'ytd-grid-video-renderer',          // Grid view videos
        'ytd-video-renderer',               // List view videos
        '#contents ytd-rich-item-renderer'  // Specific container
    ];
    
    let videoElements = [];
    for (const selector of videoSelectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
            console.log(\`Found \${elements.length} videos with selector: \${selector}\`);
            videoElements = Array.from(elements);
            break;
        }
    }
    
    console.log(\`Total video elements found: \${videoElements.length}\`);
    
    // Extract data from each video (limit to first 10 for testing)
    videoElements.slice(0, 10).forEach((video, index) => {
        try {
            // Title selectors
            const titleElement = video.querySelector('a#video-title') ||
                                video.querySelector('h3 a') ||
                                video.querySelector('[id="video-title"]') ||
                                video.querySelector('a[title]');
            
            // View count selectors  
            const viewsElement = video.querySelector('#metadata-line span') ||
                               video.querySelector('.inline-metadata-item') ||
                               video.querySelector('[aria-label*="view"]') ||
                               video.querySelector('span[aria-label*="view"]');
            
            // Published time selectors
            const timeElement = video.querySelector('#metadata-line span:last-child') ||
                              video.querySelector('.inline-metadata-item:last-child');
            
            const title = titleElement?.textContent?.trim() || titleElement?.title || 'Unknown Title';
            const videoUrl = titleElement?.href || '';
            const viewsText = viewsElement?.textContent?.trim() || '0 views';
            const publishedTime = timeElement?.textContent?.trim() || 'Unknown';
            
            // Parse view count
            const viewCount = parseViews(viewsText);
            
            if (title && title !== 'Unknown Title' && viewCount >= 0) {
                videos.push({
                    title,
                    videoUrl,
                    viewsText,
                    viewCount,
                    publishedTime,
                    index
                });
            }
        } catch (error) {
            console.warn(\`Error processing video \${index}:\`, error);
        }
    });
    
    return videos;
}

function parseViews(viewStr) {
    if (!viewStr) return 0;
    const text = viewStr.toLowerCase().replace(/views|,/g, '').trim();
    const num = parseFloat(text);
    if (isNaN(num)) return 0;
    if (text.includes('k')) return Math.round(num * 1000);
    if (text.includes('m')) return Math.round(num * 1000000);
    if (text.includes('b')) return Math.round(num * 1000000000);
    return Math.round(num);
}

// Run the scraping
const results = scrapeChannelVideos();
console.log('Scraping results:', results);
`;

console.log('📋 PROPOSED EXTENSION ENHANCEMENT:');
console.log('=====================================');
console.log('Instead of direct HTTP scraping, we can enhance the Chrome extension to:');
console.log('');
console.log('1. After getting channel URLs from search results (current method)');
console.log('2. For promising channels, open their /videos page in a background tab');
console.log('3. Inject a content script to scrape the recent videos');
console.log('4. Extract view counts for the last 7 videos');
console.log('5. Calculate distribution-aware metrics');
console.log('');

console.log('🔧 IMPLEMENTATION APPROACH:');
console.log('============================');
console.log('');
console.log('// In background.js - add this function:');
console.log(`
async function getChannelVideoDetails(channelUrl) {
    try {
        // Open channel videos page in background
        const tab = await chrome.tabs.create({ 
            url: channelUrl + '/videos', 
            active: false 
        });
        
        // Wait for page to load
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Inject scraping script
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            function: scrapeChannelVideos
        });
        
        // Close the tab
        await chrome.tabs.remove(tab.id);
        
        return results[0].result;
    } catch (error) {
        console.error('Error getting channel details:', error);
        return [];
    }
}
`);

console.log('');
console.log('📊 ENHANCED METRICS CALCULATION:');
console.log('=================================');
console.log(`
function calculateEnhancedMetrics(videos) {
    if (videos.length === 0) return null;
    
    const viewCounts = videos.map(v => v.viewCount).sort((a, b) => b - a);
    const recentCount = Math.min(7, viewCounts.length);
    const recent7 = viewCounts.slice(0, recentCount);
    
    const mean = recent7.reduce((a, b) => a + b) / recent7.length;
    const median = recent7[Math.floor(recent7.length / 2)];
    
    // Trimmed mean (remove highest and lowest)
    let trimmedMean = mean;
    if (recent7.length >= 3) {
        const trimmed = recent7.slice(1, -1);
        trimmedMean = trimmed.reduce((a, b) => a + b) / trimmed.length;
    }
    
    // Consistency score (lower coefficient of variation = more consistent)
    const variance = recent7.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / recent7.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = mean > 0 ? stdDev / mean : 0;
    const consistencyScore = Math.max(0, 100 - (coefficientOfVariation * 100));
    
    return {
        recentVideoCount: recentCount,
        averageViews: Math.round(mean),
        medianViews: Math.round(median),
        trimmedMeanViews: Math.round(trimmedMean),
        consistencyScore: Math.round(consistencyScore),
        isConsistent: consistencyScore > 70, // Flag for high consistency
        viewRange: \`\${Math.min(...recent7).toLocaleString()} - \${Math.max(...recent7).toLocaleString()}\`
    };
}
`);

console.log('');
console.log('✅ ADVANTAGES OF THIS APPROACH:');
console.log('================================');
console.log('• Zero YouTube API quota usage');
console.log('• Works with existing extension architecture');
console.log('• Can get exact view counts for recent videos');
console.log('• Provides distribution-aware metrics');
console.log('• Only processes promising channels (saves time)');
console.log('• Uses same DOM scraping techniques that already work');
console.log('');

console.log('⚠️  CONSIDERATIONS:');
console.log('===================');
console.log('• Adds some processing time (3-5 seconds per channel)');
console.log('• Should only be used for channels that pass initial filters');
console.log('• Need to handle rate limiting (don\'t open too many tabs)');
console.log('• Should be optional/configurable by user');
console.log('');

console.log('🎯 RECOMMENDED IMPLEMENTATION STRATEGY:');
console.log('=======================================');
console.log('1. Keep current method as primary filter (fast, low quota)');
console.log('2. Add "Enhanced Analysis" option in popup');
console.log('3. For channels with good ratios, optionally get detailed data');
console.log('4. Show both metrics in UI: "Quick: 2M avg | Detailed: 45K median (High consistency)"');
console.log('5. Let users choose between speed vs accuracy');
console.log('');

console.log('Would you like me to implement this enhanced approach in your extension?');