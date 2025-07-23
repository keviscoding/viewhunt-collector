const startButton = document.getElementById('start-button');
const stopButton = document.getElementById('stop-button');
const downloadButton = document.getElementById('download-button');
const statusDisplay = document.getElementById('status-display');
const resultsCount = document.getElementById('results-count');

// API key elements
const apiKeyInput = document.getElementById('api-key');
const saveApiKeyButton = document.getElementById('save-api-key');
const apiStatus = document.getElementById('api-status');

// Keywords elements
const keywordsInput = document.getElementById('keywords-input');
const saveKeywordsButton = document.getElementById('save-keywords');
const keywordsStatus = document.getElementById('keywords-status');
const addAsteriskCheckbox = document.getElementById('add-asterisk');

// Default keywords for first-time users
const DEFAULT_KEYWORDS = 'go, why, how, she, did, her, make, get, can, will, new, best, top, easy, quick, simple, first, last, most, good, bad, old, big, small, high, low, fast, slow, hot, cold, yes, no, here, there, when, where, what, who, all, some, many, few, more, less, same, different, right, wrong, true, false, open, close, start, stop, come, take, give, find, know, think, feel, look, see, hear, say, tell, ask, try, use, work, play, help, need, want, like, love, hate, buy, sell, move, stay, live, die, born, grow, learn, teach, read, write, speak, listen, walk, run, jump, sit, stand, sleep, wake, eat, drink, happy, sad, angry, calm, excited, bored, tired, fresh, clean, dirty, safe, dangerous, free, busy, ready, done, young, mature, early, late';

// Update UI based on current state from background script
const updateUI = (state) => {
    if (!state) return;
    
    statusDisplay.textContent = state.status || 'Idle';
    
    // Update results count - show queue and total processed
    const queueSize = state.queueSize || 0;
    const totalCount = state.totalProcessed || 0;
    const isProcessing = state.isProcessing || state.isQueueProcessing;
    
    if (isProcessing && (queueSize > 0 || totalCount > 0)) {
        if (queueSize > 0 && totalCount > 0) {
            resultsCount.textContent = `${queueSize} in queue, ${totalCount} processed`;
        } else if (queueSize > 0) {
            resultsCount.textContent = `${queueSize} channels in processing queue`;
        } else {
            resultsCount.textContent = `${totalCount} channels processed`;
        }
    } else if (totalCount > 0) {
        resultsCount.textContent = `${totalCount} total channels processed`;
    } else {
        resultsCount.textContent = `0 channels collected`;
    }
    
    // Update button states
    if (isProcessing) {
        startButton.disabled = true;
        stopButton.disabled = false;
        downloadButton.disabled = true; // Disable download while processing
    } else {
        startButton.disabled = false;
        stopButton.disabled = true;
        downloadButton.disabled = totalCount === 0; // Enable download based on total processed
    }
};

// Load saved API key
const loadApiKey = async () => {
    try {
        const result = await chrome.storage.local.get('apiKey');
        if (result.apiKey) {
            apiKeyInput.value = result.apiKey;
            apiStatus.textContent = 'API key loaded';
            apiStatus.className = 'api-status success';
        } else {
            // Show default API key is pre-configured
            apiKeyInput.value = 'AIzaSyBOJg1zOs4STy1MJdqdiFKnKzAUyNa-LdU';
            apiStatus.textContent = 'Default API key pre-configured';
            apiStatus.className = 'api-status success';
        }
    } catch (error) {
        console.error('Error loading API key:', error);
        apiStatus.textContent = 'Error loading API key';
        apiStatus.className = 'api-status error';
    }
};

// Load saved keywords and settings
const loadKeywords = async () => {
    try {
        const result = await chrome.storage.local.get(['keywords', 'addAsterisk', 'maxChannels', 'scrollCount']);
        if (result.keywords) {
            keywordsInput.value = result.keywords;
            keywordsStatus.textContent = `${result.keywords.split(',').length} keywords loaded`;
            keywordsStatus.className = 'keywords-status success';
        } else {
            // Set default keywords for first-time users
            keywordsInput.value = DEFAULT_KEYWORDS;
            keywordsStatus.textContent = 'Default keywords loaded (click Save to confirm)';
            keywordsStatus.className = 'keywords-status success';
        }
        
        // Load asterisk preference
        if (result.addAsterisk !== undefined) {
            addAsteriskCheckbox.checked = result.addAsterisk;
        } else {
            addAsteriskCheckbox.checked = true; // Default to true
        }
        
        // Load max channels limit
        if (result.maxChannels) {
            document.getElementById('max-channels').value = result.maxChannels;
        }
        
        // Load scroll count (only if user has set a custom value)
        if (result.scrollCount && result.scrollCount !== 30) {
            document.getElementById('scroll-count').value = result.scrollCount;
        }
    } catch (error) {
        console.error('Error loading keywords:', error);
        keywordsStatus.textContent = 'Error loading keywords';
        keywordsStatus.className = 'keywords-status error';
    }
};

// Save API key
const saveApiKey = () => {
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        apiStatus.textContent = 'Please enter an API key';
        apiStatus.className = 'api-status error';
        return;
    }
    
    chrome.runtime.sendMessage({ command: 'save-api-key', apiKey: apiKey }, (response) => {
        if (chrome.runtime.lastError) {
            console.error('Error saving API key:', chrome.runtime.lastError.message);
            apiStatus.textContent = 'Error saving API key';
            apiStatus.className = 'api-status error';
        } else if (response && response.success) {
            apiStatus.textContent = 'API key saved successfully';
            apiStatus.className = 'api-status success';
        } else {
            apiStatus.textContent = 'Failed to save API key';
            apiStatus.className = 'api-status error';
        }
    });
};

// Save keywords
const saveKeywords = () => {
    const keywordsText = keywordsInput.value.trim();
    if (!keywordsText) {
        keywordsStatus.textContent = 'Please enter keywords';
        keywordsStatus.className = 'keywords-status error';
        return;
    }
    
    // Parse and clean keywords
    const keywords = keywordsText.split(',').map(k => k.trim()).filter(k => k.length > 0);
    
    if (keywords.length === 0) {
        keywordsStatus.textContent = 'No valid keywords found';
        keywordsStatus.className = 'keywords-status error';
        return;
    }
    
    const cleanKeywords = keywords.join(', ');
    const addAsterisk = addAsteriskCheckbox.checked;
    const maxChannels = parseInt(document.getElementById('max-channels').value) || null;
    const scrollCountInput = document.getElementById('scroll-count').value.trim();
    const scrollCount = scrollCountInput ? parseInt(scrollCountInput) : null;
    
    chrome.runtime.sendMessage({ 
        command: 'save-keywords', 
        keywords: keywords, // Send array, not string
        addAsterisk: addAsterisk,
        maxChannels: maxChannels,
        scrollCount: scrollCount
    }, (response) => {
        if (chrome.runtime.lastError) {
            console.error('Error saving keywords:', chrome.runtime.lastError.message);
            keywordsStatus.textContent = 'Error saving keywords';
            keywordsStatus.className = 'keywords-status error';
        } else if (response && response.success) {
            const limitText = maxChannels ? ` (limit: ${maxChannels})` : '';
            const scrollText = scrollCount ? ` (${scrollCount} scrolls)` : ' (scroll to bottom)';
            keywordsStatus.textContent = `${keywords.length} keywords saved successfully${limitText}${scrollText}`;
            keywordsStatus.className = 'keywords-status success';
        } else {
            keywordsStatus.textContent = 'Failed to save keywords';
            keywordsStatus.className = 'keywords-status error';
        }
    });
};

// Listen for clicks
startButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({ command: 'start' });
});

stopButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({ command: 'stop' });
});

downloadButton.addEventListener('click', () => {
    chrome.runtime.sendMessage({ command: 'get-results' }, (response) => {
        if (chrome.runtime.lastError) {
            console.error("Download failed:", chrome.runtime.lastError.message);
            statusDisplay.textContent = 'Download failed. Extension context invalidated.';
            return;
        }
        
        if (response && response.results && response.results.length > 0) {
            downloadCSV(response.results);
            statusDisplay.textContent = `Downloaded ${response.results.length} results to CSV.`;
        } else {
            statusDisplay.textContent = 'No results to download.';
        }
    });
});

// CSV download function
function downloadCSV(data) {
    if (!data || data.length === 0) {
        console.warn("No data to download");
        return;
    }

    const headers = ['Channel Name', 'Subscriber Count', 'Video Views', 'View/Sub Ratio', 'Channel URL', 'Video Title'];
    const csvRows = [headers.join(',')];

    const escapeCsvField = (field) => {
        if (field === null || field === undefined) return '""';
        const stringField = String(field);
        if (stringField.includes(',') || stringField.includes('"') || stringField.includes('\n')) {
            return `"${stringField.replace(/"/g, '""')}"`;
        }
        return stringField;
    };

    // Sort by view-to-subscriber ratio (highest first)
    const sortedData = [...data].sort((a, b) => b.viewToSubRatio - a.viewToSubRatio);

    for (const row of sortedData) {
        const subscriberDisplay = row.subscriberCount > 0 ? row.subscriberCount : 'N/A';
        const ratioDisplay = row.viewToSubRatio > 0 ? row.viewToSubRatio.toFixed(2) : 'N/A';

        const values = [
            escapeCsvField(row.channelName),
            subscriberDisplay,
            row.viewCount,
            ratioDisplay,
            escapeCsvField(row.channelUrl),
            escapeCsvField(row.videoTitle),
        ];
        csvRows.push(values.join(','));
    }

    const csvString = csvRows.join('\n');
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    
    // Create download link
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `viewhunt_results_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

saveApiKeyButton.addEventListener('click', saveApiKey);
saveKeywordsButton.addEventListener('click', saveKeywords);

// Allow Enter key to save API key
apiKeyInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        saveApiKey();
    }
});

// Auto-save keywords when asterisk option changes
addAsteriskCheckbox.addEventListener('change', () => {
    if (keywordsInput.value.trim()) {
        saveKeywords();
    }
});

// Listen for status updates from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'statusUpdate') {
        updateUI(message.data);
    }
});

// Request initial state when popup opens
document.addEventListener('DOMContentLoaded', () => {
    // Load API key and keywords
    loadApiKey();
    loadKeywords();
    
    // Then get current state
    chrome.runtime.sendMessage({ command: 'get-status' }, (response) => {
        if (chrome.runtime.lastError) {
            console.warn("Could not get state:", chrome.runtime.lastError.message);
            updateUI({ isProcessing: false, status: 'Ready to start.', results: [] });
        } else {
            updateUI(response);
        }
    });
});
