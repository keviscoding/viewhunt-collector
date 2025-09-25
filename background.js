// YouTube Data API v3 configuration
const YOUTUBE_API_KEY = 'AIzaSyBOJg1zOs4STy1MJdqdiFKnKzAUyNa-LdU'; // Default API key
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

// YouTube API helper functions
function parseDuration(duration) {
    // Convert YouTube duration format (PT15S, PT1M30S) to seconds
    const match = duration.match(/PT(?:(\d+)M)?(?:(\d+)S)?/);
    const minutes = parseInt(match[1] || 0);
    const seconds = parseInt(match[2] || 0);
    return minutes * 60 + seconds;
}

// Zero-quota channel ID resolution (web scraping method)
async function getChannelIdFromHandle(handleUrl) {
    try {
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

async function resolveChannelId(channelUrl) {
    try {
        if (channelUrl.includes('/channel/UC')) {
            // Direct channel ID URL
            return channelUrl.split('/channel/')[1].split('/')[0];
        } else if (channelUrl.includes('/@')) {
            // Use zero-quota web scraping method!
            console.log(`ViewHunt: 🔍 ZERO-QUOTA HANDLE RESOLUTION: ${channelUrl}`);
            const channelId = await getChannelIdFromHandle(channelUrl);
            if (channelId) {
                console.log(`ViewHunt: ✅ FREE RESOLUTION SUCCESS: ${channelUrl} -> ${channelId}`);
                return channelId;
            } else {
                console.warn(`ViewHunt: ❌ Could not resolve: ${channelUrl}`);
                return null;
            }
        }
        return null;
    } catch (error) {
        console.error('Error resolving channel ID:', error);
        return null;
    }
}

// Default keywords
const DEFAULT_KEYWORDS = ['go', 'why', 'how', 'she', 'did', 'her', 'make', 'get', 'can', 'will', 'new', 'best', 'top', 'easy', 'quick', 'simple'];

// Remove this - we'll use the dynamic limit from popup instead

// State management
let state = {
    isProcessing: false,
    stopRequested: false,
    minViewThreshold: 0, // Default: no minimum view threshold
    lastUpdateTime: Date.now(), // Track last activity
    status: 'Idle',
    currentKeywordIndex: 0,
    activeTabId: null,
    results: [],
    processedChannelUrls: new Set(),
    apiKey: YOUTUBE_API_KEY,
    keywords: DEFAULT_KEYWORDS,
    addAsterisk: true,
    enhancedAnalysis: true, // Default to enabled
    totalProcessed: 0, // Track total channels processed across all batches
    batchSize: 500 // Process in batches of 500 channels (reduced for memory optimization)
};

// Broadcast state to all connected frontend instances
function broadcastState() {
    const currentBatchSize = state.results.length;
    const totalProcessed = state.totalProcessed;
    
    // Update timestamp for recovery mechanism
    state.lastUpdateTime = Date.now();
    
    const stateData = {
        status: state.status,
        isProcessing: state.isProcessing,
        results: state.results,
        totalProcessed: totalProcessed,
        currentBatchSize: currentBatchSize
    };
    
    console.log(`ViewHunt Background: Broadcasting state - ${currentBatchSize} in current batch, ${totalProcessed} total processed`);
    
    chrome.runtime.sendMessage({ 
        type: 'statusUpdate', 
        data: stateData 
    }).catch(e => {
        console.log("ViewHunt Background: Could not broadcast to popup (popup may be closed)");
    });
}

// Recovery mechanism - check if processing got stuck (simplified)
setInterval(() => {
    if (state.isProcessing && state.lastUpdateTime) {
        const timeSinceLastUpdate = Date.now() - state.lastUpdateTime;
        if (timeSinceLastUpdate > 120000) { // 2 minutes without updates
            console.log('ViewHunt Background: Processing appears stuck for 2+ minutes');
            state.isProcessing = false;
            state.status = 'Processing timed out. Click Start to retry.';
            broadcastState();
        }
    }
}, 60000); // Check every 60 seconds

// Keep service worker alive with periodic heartbeat
setInterval(() => {
    console.log('ViewHunt Background: Heartbeat - keeping service worker alive');
}, 25000); // Every 25 seconds

// Listen for messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('ViewHunt Background: Received message:', message.type || message.command);
    
    if (!message) {
        sendResponse({ success: false, error: 'Invalid message' });
        return;
    }
    
    if (message.command === 'start') {
        startProcessing().then(() => {
            sendResponse({ success: true });
        }).catch(error => {
            console.error('ViewHunt Background: Error starting:', error);
            sendResponse({ success: false, error: error.message });
        });
        return true; // Keep message channel open for async response
    } else if (message.command === 'stop') {
        stopProcessing().then(() => {
            sendResponse({ success: true });
        }).catch(error => {
            console.error('ViewHunt Background: Error stopping:', error);
            sendResponse({ success: false, error: error.message });
        });
        return true; // Keep message channel open for async response
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
        state.enhancedAnalysis = message.enhancedAnalysis; // Add enhanced analysis setting
        state.minViewThreshold = message.minViewThreshold || 0; // Add minimum view threshold
        chrome.storage.local.set({ 
            keywords: message.keywords.join(', '), // Store as string for popup compatibility
            addAsterisk: message.addAsterisk,
            maxChannels: message.maxChannels,
            scrollCount: message.scrollCount,
            enhancedAnalysis: message.enhancedAnalysis,
            minViewThreshold: message.minViewThreshold || 0
        });
        sendResponse({ success: true });
    } else if (message.command === 'save-enhanced-analysis') {
        state.enhancedAnalysis = message.enhancedAnalysis;
        chrome.storage.local.set({ 
            enhancedAnalysis: message.enhancedAnalysis
        });
        sendResponse({ success: true });
    } else if (message.type === 'scraping-complete') {
        handleScrapingComplete(message.data).then(() => {
            sendResponse({ success: true });
        }).catch(async (error) => {
            console.error('ViewHunt Background: Error handling scraping complete:', error);
            // Continue processing despite error
            try {
                await moveToNextKeyword();
                sendResponse({ success: true });
            } catch (moveError) {
                console.error('ViewHunt Background: Error moving to next keyword:', moveError);
                state.isProcessing = false;
                state.status = 'Processing stopped due to error. Click Start to retry.';
                await chrome.storage.local.set({ state: state });
                broadcastState();
                sendResponse({ success: false, error: error.message });
            }
        });
        return true; // Keep message channel open for async response
    } else if (message.type === 'scraping-status') {
        state.status = message.status;
        broadcastState();
        sendResponse({ success: true });
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
    
    try {
        await processNextKeyword();
    } catch (error) {
        console.error('ViewHunt Background: Error starting processing:', error);
        state.isProcessing = false;
        state.status = 'Error starting. Please try again.';
        await chrome.storage.local.set({ state: state });
        broadcastState();
    }
}

// Stop processing
async function stopProcessing() {
    console.log('ViewHunt Background: Stop requested...');
    state.stopRequested = true;
    state.status = 'Stopping...';
    
    await chrome.storage.local.set({ state: state });
    
    // Close tab when stopping to clean up
    if (state.activeTabId) {
        try {
            console.log(`ViewHunt Background: Closing tab ${state.activeTabId} after stop`);
            await chrome.tabs.remove(state.activeTabId);
        } catch (error) {
            console.log(`ViewHunt Background: Tab ${state.activeTabId} already closed or doesn't exist`);
        }
        state.activeTabId = null;
    }
    
    // Process any remaining results before stopping
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
                    await moveToNextKeyword();
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
                await moveToNextKeyword();
            }
        }, 3000);
        
    } catch (error) {
        console.error('ViewHunt Background: Error creating tab:', error);
        await moveToNextKeyword();
    }
}

// Process current batch and send to backend
async function processBatchAndSend() {
    if (state.results.length === 0) return;
    
    console.log(`ViewHunt Background: Processing batch of ${state.results.length} channels`);
    
    // Process subscriber data for current batch
    await processSubscriberData();
    
    // Enhanced analysis (if enabled)
    if (state.enhancedAnalysis) {
        console.log(`ViewHunt: Enhanced analysis is enabled, processing ${state.results.length} channels`);
        await processEnhancedAnalysis();
    } else {
        console.log(`ViewHunt: Enhanced analysis is disabled`);
    }
    
    // Filter channels that meet minimum threshold before sending to backend
    const qualifiedChannels = state.results.filter(channel => {
        const avgViews = channel.averageViews || 0;
        return avgViews >= (state.minViewThreshold || 0); // Use configurable threshold
    });
    
    const thresholdText = state.minViewThreshold > 0 ? `${(state.minViewThreshold/1000).toFixed(0)}K+` : 'all';
    console.log(`ViewHunt: Filtered ${state.results.length} channels to ${qualifiedChannels.length} qualified channels (${thresholdText} avg views)`);
    
    // Send to backend
    await sendToBackend(qualifiedChannels);
    
    // Update total count and clear current batch
    state.totalProcessed += state.results.length;
    console.log(`ViewHunt Background: Batch complete. Total processed so far: ${state.totalProcessed}`);
    
    // Clear results to free memory, but keep processedChannelUrls to avoid duplicates
    state.results = [];
}

// Move to next keyword
async function moveToNextKeyword() {
    // Close current tab to save memory (only keep 1 tab at a time)
    if (state.activeTabId) {
        try {
            console.log(`ViewHunt Background: Closing tab ${state.activeTabId} to save memory`);
            await chrome.tabs.remove(state.activeTabId);
        } catch (error) {
            console.log(`ViewHunt Background: Tab ${state.activeTabId} already closed or doesn't exist`);
        }
        state.activeTabId = null;
    }
    
    state.currentKeywordIndex++;
    
    // Save state before continuing
    await chrome.storage.local.set({ state: state });
    
    // Continue with next keyword after a short delay
    setTimeout(async () => {
        try {
            await processNextKeyword();
        } catch (error) {
            console.error('ViewHunt Background: Error processing next keyword:', error);
            // Reset processing state on error
            state.isProcessing = false;
            state.status = 'Error occurred. Click Start to retry.';
            await chrome.storage.local.set({ state: state });
            broadcastState();
        }
    }, 1000);
}

// Handle completed scraping data
async function handleScrapingComplete(data) {
    console.log(`ViewHunt Background: Received ${data.length} videos from content script`);
    
    // Add new unique videos to results array
    let newVideosCount = 0;
    data.forEach(video => {
        if (!state.processedChannelUrls.has(video.channelUrl)) {
            state.results.push(video);
            state.processedChannelUrls.add(video.channelUrl);
            newVideosCount++;
        }
    });
    
    console.log(`ViewHunt Background: Added ${newVideosCount} new unique videos. Total collected: ${state.results.length}`);
    
    // Check if we need to pause and process a batch
    if (state.results.length >= state.batchSize) {
        console.log(`ViewHunt Background: Reached batch size of ${state.results.length}/500. Pausing scraping to process batch and free memory.`);
        state.status = `Pausing scraping to process batch of ${state.results.length} channels...`;
        broadcastState();
        
        // Process the batch and send to backend
        await processBatchAndSend();
        
        // Update status and continue
        state.status = `Batch processed. Continuing scraping... (${state.totalProcessed} total processed)`;
        broadcastState();
    } else {
        // Update status with current progress
        state.status = `Scraping... ${state.results.length} collected, ${state.totalProcessed} processed`;
        broadcastState();
    }
    
    // Move to next keyword
    await moveToNextKeyword();
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
    
    // Filter channels that meet minimum threshold before sending to backend
    const qualifiedChannels = state.results.filter(channel => {
        const avgViews = channel.averageViews || 0;
        return avgViews >= (state.minViewThreshold || 0); // Use configurable threshold
    });
    
    const thresholdText = state.minViewThreshold > 0 ? `${(state.minViewThreshold/1000).toFixed(0)}K+` : 'all';
    console.log(`ViewHunt: Filtered ${state.results.length} channels to ${qualifiedChannels.length} qualified channels (${thresholdText} avg views)`);
    
    // Send data to backend server
    await sendToBackend(qualifiedChannels);
    
    broadcastState();
}

// Enhanced analysis using Apify API for accurate recent performance
async function processEnhancedAnalysis() {
    console.log(`ViewHunt Background: Starting YouTube API enhanced analysis for ${state.results.length} channels`);
    
    // Filter channels that should get enhanced analysis
    const channelsForEnhancement = state.results.filter(channel => {
        return shouldRunEnhancedAnalysis(channel);
    });
    
    console.log(`ViewHunt Background: ${channelsForEnhancement.length}/${state.results.length} channels qualify for enhanced analysis`);
    
    if (channelsForEnhancement.length === 0) {
        console.log('ViewHunt Background: No channels qualify for enhanced analysis');
        return;
    }
    
    // Process all qualifying channels (no more artificial limits!)
    const batchSize = 5; // Process 5 channels at a time
    
    for (let i = 0; i < channelsForEnhancement.length; i += batchSize) {
        if (state.stopRequested) break;
        
        const batch = channelsForEnhancement.slice(i, i + batchSize);
        state.status = `YouTube API analysis... (${Math.min(i + batchSize, channelsForEnhancement.length)}/${channelsForEnhancement.length})`;
        broadcastState();
        
        // Process batch in parallel
        const promises = batch.map(channel => getEnhancedChannelDataYouTube(channel));
        const results = await Promise.allSettled(promises);
        
        // Update channels with enhanced data
        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value) {
                const channel = batch[index];
                const enhancedData = result.value;
                
                // Find the channel in state.results and update it
                const channelIndex = state.results.findIndex(c => c.channelUrl === channel.channelUrl);
                if (channelIndex !== -1) {
                    console.log(`ViewHunt: Enhanced data for ${channel.channelName}: Recent Avg ${enhancedData.recentAverage}, ${enhancedData.recentShorts?.length} shorts`);
                    state.results[channelIndex] = {
                        ...state.results[channelIndex],
                        ...enhancedData,
                        enhanced: true
                    };
                }
            }
        });
        
        // Small delay between batches to respect rate limits
        if (i + batchSize < channelsForEnhancement.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    console.log(`ViewHunt Background: YouTube API enhanced analysis complete`);
}

// Determine if a channel should get enhanced analysis
function shouldRunEnhancedAnalysis(channel) {
    const subs = channel.subscriberCount || 0;
    const avgViews = channel.averageViews || 0;
    const ratio = channel.viewToSubRatio || 0;
    
    // PRIMARY FILTER: Configurable threshold for enhanced analysis
    if (avgViews < (state.minViewThreshold || 0)) {
        const thresholdText = state.minViewThreshold > 0 ? `${(state.minViewThreshold/1000).toFixed(0)}K` : '0';
        console.log(`ViewHunt: Skipping enhanced analysis for ${channel.channelName}: avgViews=${avgViews} < ${thresholdText}`);
        return false; // Skip enhanced analysis for channels under threshold
    }
    
    console.log(`ViewHunt: Channel ${channel.channelName} qualifies for enhanced analysis: avgViews=${avgViews}, subs=${subs}, ratio=${ratio}`);
    
    // SECONDARY FILTERS: Tiered filtering based on channel size
    if (subs < 100000) {
        // Small channels with high averages - likely viral outliers
        return ratio >= 1.0 && avgViews >= (state.minViewThreshold || 0);
    } else if (subs < 1000000) {
        // Medium channels with high averages - potential declining performance
        return ratio >= 0.5 && avgViews >= (state.minViewThreshold || 0);
    } else {
        // Large channels with high averages - consistency analysis
        return ratio >= 0.1 && avgViews >= (state.minViewThreshold || 0);
    }
}

// Get enhanced channel data using YouTube API directly
async function getEnhancedChannelDataYouTube(channel) {
    try {
        console.log(`ViewHunt: 🚀 YOUTUBE API - Getting data for ${channel.channelName}`);
        
        // Step 1: Resolve channel ID
        const channelId = await resolveChannelId(channel.channelUrl);
        if (!channelId) {
            console.warn(`ViewHunt: Could not resolve channel ID for ${channel.channelName}`);
            return null;
        }
        
        // Step 2: Get channel info and uploads playlist
        const channelResponse = await fetch(
            `${YOUTUBE_API_BASE}/channels?part=statistics,contentDetails,snippet&id=${channelId}&key=${state.apiKey}`
        );
        
        if (!channelResponse.ok) {
            console.warn(`ViewHunt: Channel API failed for ${channel.channelName}: ${channelResponse.status}`);
            return null;
        }
        
        const channelData = await channelResponse.json();
        if (!channelData.items || channelData.items.length === 0) {
            console.warn(`ViewHunt: No channel data found for ${channel.channelName}`);
            return null;
        }
        
        const channelInfo = channelData.items[0];
        const uploadsPlaylistId = channelInfo.contentDetails.relatedPlaylists.uploads;
        
        // Step 3: Get recent videos from uploads playlist
        const playlistResponse = await fetch(
            `${YOUTUBE_API_BASE}/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=30&key=${state.apiKey}`
        );
        
        if (!playlistResponse.ok) {
            console.warn(`ViewHunt: Playlist API failed for ${channel.channelName}: ${playlistResponse.status}`);
            return null;
        }
        
        const playlistData = await playlistResponse.json();
        if (!playlistData.items || playlistData.items.length === 0) {
            console.warn(`ViewHunt: No videos found for ${channel.channelName}`);
            return null;
        }
        
        const videoIds = playlistData.items.map(item => item.snippet.resourceId.videoId);
        
        // Step 4: Get video details and filter for shorts
        const videosResponse = await fetch(
            `${YOUTUBE_API_BASE}/videos?part=contentDetails,statistics,snippet&id=${videoIds.join(',')}&key=${state.apiKey}`
        );
        
        if (!videosResponse.ok) {
            console.warn(`ViewHunt: Videos API failed for ${channel.channelName}: ${videosResponse.status}`);
            return null;
        }
        
        const videosData = await videosResponse.json();
        
        // Filter for shorts only (duration ≤ 60 seconds)
        const shorts = videosData.items.filter(video => {
            const duration = video.contentDetails.duration;
            const seconds = parseDuration(duration);
            return seconds <= 60;
        }).slice(0, 10); // Take first 10 shorts
        
        if (shorts.length === 0) {
            console.warn(`ViewHunt: No shorts found for ${channel.channelName}`);
            return null;
        }
        
        // Step 5: Calculate enhanced metrics
        const viewCounts = shorts.map(short => parseInt(short.statistics.viewCount || 0));
        const recentAverage = Math.round(viewCounts.reduce((a, b) => a + b, 0) / viewCounts.length);
        
        // Step 6: Create recent shorts data with links
        const recentShorts = shorts.map(short => ({
            videoId: short.id,
            title: short.snippet.title,
            viewCount: parseInt(short.statistics.viewCount || 0),
            publishedAt: short.snippet.publishedAt,
            duration: short.contentDetails.duration,
            shortUrl: `https://youtube.com/shorts/${short.id}`,
            watchUrl: `https://youtube.com/watch?v=${short.id}`,
            thumbnailUrl: `https://img.youtube.com/vi/${short.id}/hqdefault.jpg`
        }));
        
        console.log(`ViewHunt: ✅ YOUTUBE API SUCCESS - ${channel.channelName}: Recent Avg ${recentAverage} from ${shorts.length} shorts`);
        
        return {
            enhanced: true,
            recentAverage: recentAverage,
            videosAnalyzed: shorts.length,
            recentShorts: recentShorts,
            lastUpdated: new Date().toISOString()
        };
        
    } catch (error) {
        console.error(`ViewHunt: YouTube API error for ${channel.channelName}:`, error);
        return null;
    }
}

// Legacy Apify function (keeping for fallback)
async function getEnhancedChannelData(channel, retryCount = 0) {
    const maxRetries = 1; // Reduce retries for speed
    const baseDelay = 500; // Reduce base delay
    
    try {
        // Add exponential backoff delay for retries
        if (retryCount > 0) {
            const delay = baseDelay * Math.pow(2, retryCount - 1);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000); // 20 second timeout
        
        const response = await fetch('https://viewhunt-backend-4fur6.ondigitalocean.app/api/channels/enhanced-analysis', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                channelUrl: channel.channelUrl,
                channelName: channel.channelName
            }),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            // Retry on 500 errors and rate limiting
            if ((response.status >= 500 || response.status === 429) && retryCount < maxRetries) {
                console.warn(`ViewHunt: Enhanced analysis failed for ${channel.channelName}: ${response.status}, retrying... (${retryCount + 1}/${maxRetries})`);
                return await getEnhancedChannelData(channel, retryCount + 1);
            }
            
            console.warn(`ViewHunt: Enhanced analysis failed for ${channel.channelName}: ${response.status}`);
            return null;
        }
        
        const enhancedData = await response.json();
        console.log(`ViewHunt: Enhanced analysis complete for ${channel.channelName}`);
        console.log(`ViewHunt: Enhanced data received:`, enhancedData);
        return enhancedData;
        
    } catch (error) {
        // Retry on network errors
        if ((error.name === 'AbortError' || error.message.includes('fetch')) && retryCount < maxRetries) {
            console.warn(`ViewHunt: Enhanced analysis error for ${channel.channelName}, retrying... (${retryCount + 1}/${maxRetries}):`, error.message);
            return await getEnhancedChannelData(channel, retryCount + 1);
        }
        
        console.warn(`ViewHunt: Enhanced analysis error for ${channel.channelName}:`, error);
        return null;
    }
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
    const result = await chrome.storage.local.get(['state', 'apiKey', 'keywords', 'addAsterisk', 'scrollCount', 'enhancedAnalysis']);
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
    if (result.enhancedAnalysis !== undefined) {
        state.enhancedAnalysis = result.enhancedAnalysis;
    }
});

// Load saved state on install
chrome.runtime.onInstalled.addListener(async () => {
    const result = await chrome.storage.local.get(['apiKey', 'keywords', 'addAsterisk', 'scrollCount', 'enhancedAnalysis']);
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
    if (result.enhancedAnalysis !== undefined) {
        state.enhancedAnalysis = result.enhancedAnalysis;
    }
});