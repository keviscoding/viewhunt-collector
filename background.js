// YouTube Data API v3 configuration
const YOUTUBE_API_KEY = 'AIzaSyBOJg1zOs4STy1MJdqdiFKnKzAUyNa-LdU'; // Default API key
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

// Default keywords
const DEFAULT_KEYWORDS = ['go', 'why', 'how', 'she', 'did', 'her', 'make', 'get', 'can', 'will', 'new', 'best', 'top', 'easy', 'quick', 'simple'];

// Remove this - we'll use the dynamic limit from popup instead

// State management
let state = {
    isProcessing: false,
    stopRequested: false,
    status: 'Idle',
    currentKeywordIndex: 0,
    activeTabId: null,
    results: [],
    processedChannelUrls: new Set(),
    apiKey: YOUTUBE_API_KEY,
    keywords: DEFAULT_KEYWORDS,
    addAsterisk: true,
    totalProcessed: 0, // Track total channels processed across all batches
    batchSize: 2000 // Process in batches of 2000 channels
};

// Broadcast state to all connected frontend instances
function broadcastState() {
    const currentBatchSize = state.results.length;
    const totalProcessed = state.totalProcessed + currentBatchSize;
    
    const stateData = {
        status: state.status,
        isProcessing: state.isProcessing,
        results: state.results,
        totalProcessed: totalProcessed // Include total count across all batches
    };
    
    console.log(`ViewHunt Background: Broadcasting state - ${currentBatchSize} in current batch, ${totalProcessed} total processed`);
    
    chrome.runtime.sendMessage({ 
        type: 'statusUpdate', 
        data: stateData 
    }).catch(e => {
        console.log("ViewHunt Background: Could not broadcast to popup (popup may be closed)");
    });
}

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('ViewHunt Background: Received message:', message.type || message.command);
    
    if (!message) {
        sendResponse({ success: false, error: 'Invalid message' });
        return;
    }
    
    if (message.command === 'start') {
        startProcessing();
        sendResponse({ success: true });
    } else if (message.command === 'stop') {
        stopProcessing();
        sendResponse({ success: true });
    } else if (message.command === 'get-status') {
        sendResponse({ 
            isProcessing: state.isProcessing, 
            status: state.status,
            results: state.results
        });
    } else if (message.command === 'get-results') {
        sendResponse({ results: state.results });
    } else if (message.command === 'save-api-key') {
        state.apiKey = message.apiKey;
        chrome.storage.local.set({ apiKey: message.apiKey });
        sendResponse({ success: true });
    } else if (message.command === 'save-keywords') {
        state.keywords = message.keywords; // Array of keywords
        state.addAsterisk = message.addAsterisk;
        state.maxChannels = message.maxChannels; // Add max channels limit
        state.scrollCount = message.scrollCount; // Add scroll count setting (can be null for unlimited)
        chrome.storage.local.set({ 
            keywords: message.keywords.join(', '), // Store as string for popup compatibility
            addAsterisk: message.addAsterisk,
            maxChannels: message.maxChannels,
            scrollCount: message.scrollCount
        });
        sendResponse({ success: true });
    } else if (message.type === 'scraping-complete') {
        handleScrapingComplete(message.data);
        sendResponse({ success: true });
    } else if (message.type === 'scraping-status') {
        state.status = message.status;
        broadcastState();
    } else {
        console.warn('ViewHunt Background: Unknown message:', message);
        sendResponse({ success: false, error: 'Unknown command' });
    }
});

// Start processing keywords
async function startProcessing() {
    if (state.isProcessing) return;
    
    console.log('ViewHunt Background: Starting processing...');
    state.isProcessing = true;
    state.stopRequested = false;
    state.currentKeywordIndex = 0;
    state.results = [];
    state.processedChannelUrls.clear();
    state.totalProcessed = 0; // Reset batch counter
    state.status = 'Starting processing...';
    
    await chrome.storage.local.set({ state: state });
    broadcastState();
    
    processNextKeyword();
}

// Stop processing
async function stopProcessing() {
    console.log('ViewHunt Background: Stop requested...');
    state.stopRequested = true;
    state.status = 'Stopping...';
    
    await chrome.storage.local.set({ state: state });
    
    // Keep tabs open - don't close them when stopping
    if (state.activeTabId) {
        console.log('ViewHunt Background: Keeping tab open after stop');
        state.activeTabId = null;
    }
    
    if (state.results.length > 0) {
        state.status = `Stopped. Processing final batch of ${state.results.length} channels...`;
        broadcastState();
        await processBatchAndSend();
    }
    
    state.isProcessing = false;
    const totalChannels = state.totalProcessed;
    state.status = totalChannels > 0 ? 
        `Stopped. Processed ${totalChannels} total channels.` : 
        'Stopped. No results found.';
    
    await chrome.storage.local.set({ state: state });
    broadcastState();
}

// Process next keyword
async function processNextKeyword() {
    if (state.stopRequested || state.currentKeywordIndex >= state.keywords.length) {
        console.log('ViewHunt Background: All keywords processed or stop requested');
        
        // Process any remaining results in final batch
        if (state.results.length > 0) {
            state.status = `Processing final batch of ${state.results.length} channels...`;
            broadcastState();
            await processBatchAndSend();
        }
        
        state.isProcessing = false;
        const totalChannels = state.totalProcessed;
        state.status = totalChannels > 0 ? 
            `Complete! Processed ${totalChannels} total channels.` : 
            'Complete. No results found.';
        
        await chrome.storage.local.set({ state: state });
        broadcastState();
        return;
    }
    
    const keyword = state.keywords[state.currentKeywordIndex];
    const searchKeyword = state.addAsterisk ? `*${keyword}*` : keyword;
    
    state.status = `Processing keyword: "${searchKeyword}" (${state.currentKeywordIndex + 1}/${state.keywords.length})`;
    await chrome.storage.local.set({ state: state });
    broadcastState();
    
    console.log(`ViewHunt Background: Processing keyword: ${searchKeyword}`);
    
    // Open YouTube search in new tab
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(searchKeyword)}`;
    
    try {
        const tab = await chrome.tabs.create({ url: searchUrl, active: true });
        state.activeTabId = tab.id;
        
        // Wait for tab to load and inject content script
        setTimeout(async () => {
            try {
                // Check if tab still exists before injecting
                const tabInfo = await chrome.tabs.get(tab.id).catch(() => null);
                if (!tabInfo || state.activeTabId !== tab.id) {
                    console.log(`ViewHunt Background: Tab ${tab.id} no longer exists or was replaced`);
                    moveToNextKeyword();
                    return;
                }
                
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['content.js']
                });
                console.log(`ViewHunt Background: Content script injected for keyword: ${searchKeyword}`);
            } catch (error) {
                console.error('ViewHunt Background: Error injecting content script:', error);
                // If injection fails, move to next keyword
                moveToNextKeyword();
            }
        }, 3000);
        
    } catch (error) {
        console.error('ViewHunt Background: Error creating tab:', error);
        moveToNextKeyword();
    }
}

// Process current batch and send to backend to prevent memory overload
async function processBatchAndSend() {
    if (state.results.length === 0) return;
    
    console.log(`ViewHunt Background: Processing batch of ${state.results.length} channels`);
    
    // Process subscriber data for current batch
    await processSubscriberData();
    
    // Send to backend
    await sendToBackend(state.results);
    
    // Update total count and clear current batch
    state.totalProcessed += state.results.length;
    console.log(`ViewHunt Background: Batch complete. Total processed so far: ${state.totalProcessed}`);
    
    // Clear results to free memory, but keep processedChannelUrls to avoid duplicates
    state.results = [];
    
    // Update status
    state.status = `Processed ${state.totalProcessed} channels so far. Continuing...`;
    broadcastState();
}

// Move to next keyword
function moveToNextKeyword() {
    // Keep tabs open - don't close them when moving to next keyword
    if (state.activeTabId) {
        console.log('ViewHunt Background: Keeping tab open, moving to next keyword');
        state.activeTabId = null;
    }
    
    state.currentKeywordIndex++;
    setTimeout(() => processNextKeyword(), 1000);
}

// Handle completed scraping data
async function handleScrapingComplete(data) {
    console.log(`ViewHunt Background: Received ${data.length} videos from content script`);
    
    // Add new unique videos
    let newVideosCount = 0;
    data.forEach(video => {
        if (!state.processedChannelUrls.has(video.channelUrl)) {
            state.results.push(video);
            state.processedChannelUrls.add(video.channelUrl);
            newVideosCount++;
        }
    });
    
    console.log(`ViewHunt Background: Added ${newVideosCount} new unique videos. Total: ${state.results.length}`);
    broadcastState();
    
    // Check if we need to process a batch to prevent memory overload
    if (state.results.length >= state.batchSize) {
        console.log(`ViewHunt Background: Processing batch of ${state.results.length} channels to prevent memory issues`);
        state.status = `Processing batch of ${state.results.length} channels...`;
        broadcastState();
        
        await processBatchAndSend();
    }
    
    // Move to next keyword
    moveToNextKeyword();
}

// Process subscriber data using YouTube API
async function processSubscriberData() {
    console.log(`ViewHunt Background: Starting API processing for ${state.results.length} videos`);
    
    // Get unique channels
    const uniqueChannels = new Map();
    state.results.forEach(video => {
        if (!uniqueChannels.has(video.channelUrl)) {
            uniqueChannels.set(video.channelUrl, {
                channelName: video.channelName,
                channelUrl: video.channelUrl,
                videos: []
            });
        }
        uniqueChannels.get(video.channelUrl).videos.push(video);
    });
    
    console.log(`ViewHunt Background: Processing ${uniqueChannels.size} unique channels`);
    
    // Process channels in batches to get subscriber counts
    const channelArray = Array.from(uniqueChannels.values());
    const batchSize = 10;
    
    for (let i = 0; i < channelArray.length; i += batchSize) {
        if (state.stopRequested) break;
        
        const batch = channelArray.slice(i, i + batchSize);
        state.status = `Resolving handles + getting subscriber data... (${Math.min(i + batchSize, channelArray.length)}/${channelArray.length})`;
        broadcastState();
        
        await processBatch(batch);
        await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
    }
    
    // Update results with subscriber data and calculate ratios
    state.results = [];
    for (let [channelUrl, channelInfo] of uniqueChannels) {
        for (let video of channelInfo.videos) {
            const subscriberCount = channelInfo.subscriberCount || 0;
            const viewToSubRatio = subscriberCount > 0 ? (video.viewCount / subscriberCount) : 0;
            
            state.results.push({
                channelName: channelInfo.channelName,
                channelUrl: channelInfo.channelUrl,
                videoTitle: video.videoTitle,
                viewCount: video.viewCount,
                subscriberCount: subscriberCount,
                viewToSubRatio: viewToSubRatio,
                avatarUrl: channelInfo.avatarUrl || null,
                // NEW: Add the channel-level statistics
                totalViews: channelInfo.totalViews || 0,
                videoCount: channelInfo.videoCount || 0,
                averageViews: channelInfo.averageViews || 0
            });
        }
    }
    
    // Sort by view-to-subscriber ratio (highest first)
    state.results.sort((a, b) => b.viewToSubRatio - a.viewToSubRatio);
    
    console.log(`ViewHunt Background: API processing complete. Final results: ${state.results.length}`);
    
    // Send data to backend server
    await sendToBackend(state.results);
    
    broadcastState();
}

// Send results to backend server
async function sendToBackend(results) {
    if (results.length === 0) {
        console.log('ViewHunt Background: No results to send to backend');
        return;
    }

    try {
        console.log(`ViewHunt Background: Sending ${results.length} channels to backend...`);
        
        const response = await fetch('https://viewhunt-backend-4fur6.ondigitalocean.app/api/channels/bulk', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                channels: results
            })
        });

        if (response.ok) {
            const result = await response.json();
            console.log(`ViewHunt Background: Successfully sent to backend - ${result.inserted} inserted, ${result.errors} errors`);
            state.status = `Complete! Found ${results.length} videos. Data sent to mobile app.`;
        } else {
            console.error('ViewHunt Background: Failed to send to backend:', response.status);
            state.status = `Complete! Found ${results.length} videos. (Backend sync failed)`;
        }
    } catch (error) {
        console.error('ViewHunt Background: Error sending to backend:', error);
        state.status = `Complete! Found ${results.length} videos. (Backend offline)`;
    }
    
    broadcastState();
}

// Get channel ID from handle URL (zero API quota) - improved accuracy
async function getChannelIdFromHandle(handleUrl) {
    try {
        const response = await fetch(handleUrl);
        const html = await response.text();
        
        // Method 1: Look for the canonical channel URL in meta tags (most reliable)
        let match = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[^"]+)"/);
        if (match) {
            console.log(`ViewHunt: Found canonical channel ID: ${match[1]}`);
            return match[1];
        }
        
        // Method 2: Look for channel ID in the page's JSON-LD structured data
        match = html.match(/"@type":"Person"[^}]*"identifier":"(UC[^"]+)"/);
        if (match) {
            console.log(`ViewHunt: Found channel ID in structured data: ${match[1]}`);
            return match[1];
        }
        
        // Method 3: Look for the channel ID in the ytInitialData (more specific)
        match = html.match(/ytInitialData[^{]*{[^}]*"channelId":"(UC[^"]+)"/);
        if (match) {
            console.log(`ViewHunt: Found channel ID in ytInitialData: ${match[1]}`);
            return match[1];
        }
        
        // Method 4: Look for channel ID in the page header metadata (fallback)
        match = html.match(/<meta property="og:url" content="https:\/\/www\.youtube\.com\/channel\/(UC[^"]+)"/);
        if (match) {
            console.log(`ViewHunt: Found channel ID in og:url: ${match[1]}`);
            return match[1];
        }
        
        // Method 5: Original method as final fallback (but log a warning)
        match = html.match(/"channelId":"(UC[^"]+)"/);
        if (match) {
            console.warn(`ViewHunt: Using fallback method for channel ID (may be inaccurate): ${match[1]}`);
            return match[1];
        }
        
        console.warn(`ViewHunt: Could not find channel ID for handle: ${handleUrl}`);
        return null;
    } catch (error) {
        console.warn(`ViewHunt: Error fetching handle ${handleUrl}:`, error);
        return null;
    }
}

// Process a batch of channels to get subscriber counts
async function processBatch(channels) {
    // Phase 1: Resolve handles to real channel IDs (zero API quota)
    console.log(`ViewHunt: Resolving ${channels.length} channel IDs...`);
    
    for (const channelInfo of channels) {
        // Extract real channel ID from URL
        if (channelInfo.channelUrl.includes('/@')) {
            // Handle URL - scrape to get real channel ID
            console.log(`ViewHunt: Resolving handle for ${channelInfo.channelName}`);
            channelInfo.realChannelId = await getChannelIdFromHandle(channelInfo.channelUrl);
            if (channelInfo.realChannelId) {
                console.log(`ViewHunt: ✅ ${channelInfo.channelName} -> ${channelInfo.realChannelId}`);
            } else {
                console.log(`ViewHunt: ❌ Could not resolve ${channelInfo.channelName}`);
            }
        } else if (channelInfo.channelUrl.includes('/channel/UC')) {
            // Direct channel ID URL
            const channelId = channelInfo.channelUrl.split('/channel/')[1].split('/')[0];
            if (channelId.startsWith('UC')) {
                channelInfo.realChannelId = channelId;
                console.log(`ViewHunt: ✅ Direct channel ID: ${channelInfo.channelName} -> ${channelId}`);
            }
        } else {
            console.log(`ViewHunt: ⏭️ Skipping unknown URL format: ${channelInfo.channelUrl}`);
        }
        
        // Small delay to be respectful
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Phase 2: Batch API call for channels with real IDs (cheap: 1 quota per 50 channels)
    const channelsWithIds = channels.filter(ch => ch.realChannelId);
    console.log(`ViewHunt API: Getting stats for ${channelsWithIds.length} channels with real IDs`);
    
    if (channelsWithIds.length > 0) {
        try {
            const channelIds = channelsWithIds.map(ch => ch.realChannelId);
            console.log(`ViewHunt API: Fetching stats for: ${channelIds.slice(0, 3).join(', ')}${channelIds.length > 3 ? '...' : ''}`);
            
            const response = await fetch(
                `${YOUTUBE_API_BASE}/channels?part=statistics,snippet&id=${channelIds.join(',')}&key=${state.apiKey}`
            );
            
            if (!response.ok) {
                const errorData = await response.json();
                console.error(`ViewHunt API: Error response:`, errorData);
                throw new Error(`API Error: ${errorData.error?.message || 'Unknown error'}`);
            }
            
            const data = await response.json();
            console.log(`ViewHunt API: Successfully received data for ${data.items?.length || 0}/${channelsWithIds.length} channels`);
            
            if (data.items) {
                data.items.forEach(item => {
                    const subscriberCount = parseInt(item.statistics.subscriberCount || 0);
                    const totalViews = parseInt(item.statistics.viewCount || 0);
                    const videoCount = parseInt(item.statistics.videoCount || 0);
                    const averageViews = videoCount > 0 ? Math.round(totalViews / videoCount) : 0;
                    const avatarUrl = item.snippet?.thumbnails?.default?.url || 
                                     item.snippet?.thumbnails?.medium?.url || 
                                     item.snippet?.thumbnails?.high?.url || null;
                    
                    const channelInfo = channelsWithIds.find(ch => ch.realChannelId === item.id);
                    if (channelInfo) {
                        channelInfo.subscriberCount = subscriberCount;
                        channelInfo.totalViews = totalViews;
                        channelInfo.videoCount = videoCount;
                        channelInfo.averageViews = averageViews;
                        channelInfo.avatarUrl = avatarUrl;
                        console.log(`ViewHunt API: ${channelInfo.channelName}: ${subscriberCount.toLocaleString()} subs, ${videoCount} videos, ${averageViews.toLocaleString()} avg views, Avatar: ${avatarUrl ? 'Yes' : 'No'}`);
                    }
                });
            }
            
        } catch (error) {
            console.error('ViewHunt API: Error fetching channel stats:', error);
            // Mark failed channels as 0 subscribers
            channelsWithIds.forEach(ch => {
                if (ch.subscriberCount === undefined) {
                    ch.subscriberCount = 0;
                }
            });
        }
    }
    
    // Mark channels without real IDs as 0 subscribers
    channels.filter(ch => !ch.realChannelId).forEach(ch => {
        ch.subscriberCount = 0;
    });
}

// Load saved state on startup
chrome.runtime.onStartup.addListener(async () => {
    const result = await chrome.storage.local.get(['state', 'apiKey', 'keywords', 'addAsterisk', 'scrollCount']);
    if (result.state) {
        state = { ...state, ...result.state };
        state.isProcessing = false; // Reset processing state on startup
    }
    if (result.apiKey) {
        state.apiKey = result.apiKey;
    }
    if (result.keywords) {
        // Parse stored string back to array
        state.keywords = result.keywords.split(',').map(k => k.trim()).filter(k => k.length > 0);
    }
    if (result.addAsterisk !== undefined) {
        state.addAsterisk = result.addAsterisk;
    }
    if (result.scrollCount !== undefined) {
        state.scrollCount = result.scrollCount;
    }
});

// Load saved state on install
chrome.runtime.onInstalled.addListener(async () => {
    const result = await chrome.storage.local.get(['apiKey', 'keywords', 'addAsterisk', 'scrollCount']);
    if (result.apiKey) {
        state.apiKey = result.apiKey;
    }
    if (result.keywords) {
        // Parse stored string back to array
        state.keywords = result.keywords.split(',').map(k => k.trim()).filter(k => k.length > 0);
    }
    if (result.addAsterisk !== undefined) {
        state.addAsterisk = result.addAsterisk;
    }
    if (result.scrollCount !== undefined) {
        state.scrollCount = result.scrollCount;
    }
});