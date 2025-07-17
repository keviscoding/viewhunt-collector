
(async () => {
    console.log("ViewHunt: Content script injected and running.");

    const sendStatus = (status) => {
        try {
            chrome.runtime.sendMessage({ type: 'scraping-status', status: status });
        } catch (e) {
            console.warn("ViewHunt: Could not send status, extension context likely invalidated.", e);
        }
    };

    const parseViews = (viewStr) => {
        if (!viewStr) return 0;
        const text = viewStr.toLowerCase().replace(/views|,/g, '').trim();
        const num = parseFloat(text);
        if (isNaN(num)) return 0;
        if (text.includes('k')) return Math.round(num * 1000);
        if (text.includes('m')) return Math.round(num * 1000000);
        if (text.includes('b')) return Math.round(num * 1000000000);
        return Math.round(num);
    };

    try {
        sendStatus("Page loaded. Looking for Shorts filter...");
        
        // Wait a bit for the page to fully load
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Try to find and click the "Shorts" filter button with safer selectors
        let shortsButton = null;
        
        console.log("ViewHunt: Looking for chip cloud and filter buttons...");
        
        // Method 1: Look for the chip cloud container and find Shorts within it
        const chipCloud = document.querySelector('yt-chip-cloud-renderer');
        if (chipCloud) {
            console.log("ViewHunt: Found chip cloud, searching for Shorts chip...");
            
            // Find all chip renderers and look for the one containing "Shorts"
            const chips = chipCloud.querySelectorAll('yt-chip-cloud-chip-renderer');
            console.log(`ViewHunt: Found ${chips.length} filter chips`);
            
            for (let chip of chips) {
                const chipText = chip.textContent?.trim().toLowerCase();
                console.log(`ViewHunt: Checking chip: "${chipText}"`);
                
                if (chipText === 'shorts') {
                    console.log("ViewHunt: Found Shorts chip! Inspecting structure...");
                    console.log("ViewHunt: Chip HTML:", chip.outerHTML.substring(0, 200));
                    
                    // Try different selectors for the clickable element
                    shortsButton = chip.querySelector('a') ||
                                  chip.querySelector('button') ||
                                  chip.querySelector('[role="tab"]') ||
                                  chip.querySelector('.yt-spec-button-shape-next') ||
                                  chip; // Sometimes the chip itself is clickable
                    
                    console.log("ViewHunt: Found clickable element:", shortsButton?.tagName, shortsButton?.href || 'no href');
                    
                    if (shortsButton) {
                        break;
                    }
                }
            }
        }
        
        // Method 2: Direct search for Shorts links in the filter area
        if (!shortsButton) {
            console.log("ViewHunt: Trying direct link search...");
            
            // Look for links that contain the Shorts filter parameter
            const shortsLinks = document.querySelectorAll('a[href*="sp=EgIYAQ"]');
            console.log(`ViewHunt: Found ${shortsLinks.length} potential Shorts filter links`);
            
            for (let link of shortsLinks) {
                const linkText = link.textContent?.trim().toLowerCase();
                console.log(`ViewHunt: Checking link text: "${linkText}"`);
                
                if (linkText === 'shorts') {
                    shortsButton = link;
                    console.log("ViewHunt: Found Shorts link:", link.href);
                    break;
                }
            }
        }
        
        // Method 3: Broader search within the header area
        if (!shortsButton) {
            console.log("ViewHunt: Trying header area search...");
            
            const headerArea = document.querySelector('ytd-search-header-renderer') || 
                              document.querySelector('#header') ||
                              document.querySelector('[role="tablist"]');
            
            if (headerArea) {
                const allLinks = headerArea.querySelectorAll('a');
                console.log(`ViewHunt: Found ${allLinks.length} links in header area`);
                
                for (let link of allLinks) {
                    const linkText = link.textContent?.trim().toLowerCase();
                    if (linkText === 'shorts' && link.href.includes('youtube.com/results')) {
                        shortsButton = link;
                        console.log("ViewHunt: Found Shorts link in header:", link.href);
                        break;
                    }
                }
            }
        }
        
        if (shortsButton) {
            console.log("ViewHunt: Found Shorts filter button:", shortsButton.outerHTML.substring(0, 100));
            sendStatus("Found Shorts filter. Clicking to filter results...");
            
            // Check if it's already selected
            const isSelected = shortsButton.getAttribute('aria-selected') === 'true';
            console.log("ViewHunt: Shorts filter already selected:", isSelected);
            
            if (!isSelected) {
                // Scroll to the button first to make sure it's visible
                shortsButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await new Promise(resolve => setTimeout(resolve, 500));
                
                console.log("ViewHunt: Clicking Shorts filter button...");
                
                // Try multiple click methods to ensure it works
                shortsButton.click();
                
                // Also try dispatching a click event as backup
                shortsButton.dispatchEvent(new MouseEvent('click', {
                    bubbles: true,
                    cancelable: true,
                    view: window
                }));
                
                console.log("ViewHunt: Click events dispatched, waiting for page update...");
                
                // Wait for the page to update with Shorts filter
                await new Promise(resolve => setTimeout(resolve, 3000));
                
                // Verify the filter was applied
                const updatedButton = document.querySelector('yt-chip-cloud-chip-renderer button[aria-selected="true"]');
                const isNowSelected = updatedButton && updatedButton.textContent?.trim().toLowerCase() === 'shorts';
                console.log("ViewHunt: Shorts filter now active:", isNowSelected);
                
                if (isNowSelected) {
                    sendStatus("Shorts filter successfully applied. Starting scrolling...");
                } else {
                    sendStatus("Shorts filter may not have applied correctly. Proceeding anyway...");
                }
            } else {
                console.log("ViewHunt: Shorts filter already active, proceeding...");
                sendStatus("Shorts filter already active. Starting scrolling...");
            }
        } else {
            console.log("ViewHunt: Shorts filter button not found, proceeding with all results");
            sendStatus("Shorts filter not found. Proceeding with all results...");
        }
        
        // Reasonable scroll count
        const scrollCount = 30;
        const scrollDelay = 1500;
        let lastVideoCount = 0;
        let noNewVideosCount = 0;

        for (let i = 0; i < scrollCount; i++) {
            const { state } = await chrome.storage.local.get('state');
            if (state && state.stopRequested) {
                sendStatus("Stop detected. Halting scroll.");
                break;
            }

            sendStatus(`Scrolling (${i + 1}/${scrollCount})...`);
            
            // Scroll to bottom
            window.scrollTo(0, document.documentElement.scrollHeight);
            
            // Check if we're getting new videos (including Shorts)
            const currentVideoCount = document.querySelectorAll('ytd-video-renderer, ytd-reel-item-renderer').length;
            
            if (currentVideoCount === lastVideoCount) {
                noNewVideosCount++;
                
                // If no new videos for 3 consecutive scrolls, probably reached the end
                if (noNewVideosCount >= 3) {
                    console.log("ViewHunt: Likely reached end of results for this keyword.");
                    sendStatus(`Keyword exhausted - found ${currentVideoCount} videos total.`);
                    break;
                }
            } else {
                noNewVideosCount = 0;
                console.log(`ViewHunt: Found ${currentVideoCount - lastVideoCount} new videos`);
            }
            
            lastVideoCount = currentVideoCount;
            await new Promise(resolve => setTimeout(resolve, scrollDelay));
        }
        
        sendStatus("Scrolling complete. Extracting video data...");

        const results = [];
        
        // Extract both regular videos and shorts
        const videoItems = document.querySelectorAll('ytd-video-renderer, ytd-reel-item-renderer');
        console.log(`ViewHunt: Found ${videoItems.length} video items (including Shorts).`);

        videoItems.forEach((video, index) => {
            try {
                // Selectors for both regular videos and Shorts
                const titleElement = video.querySelector('a#video-title') ||
                                   video.querySelector('a[title]') ||
                                   video.querySelector('h3 a') ||
                                   video.querySelector('span#video-title') ||
                                   video.querySelector('.reel-item-endpoint');

                const channelElement = video.querySelector('ytd-channel-name a') ||
                                     video.querySelector('a[href*="/channel/"]') ||
                                     video.querySelector('a[href*="/@"]') ||
                                     video.querySelector('.yt-simple-endpoint[href*="/channel/"]') ||
                                     video.querySelector('.yt-simple-endpoint[href*="/@"]');

                const viewsElement = video.querySelector('#metadata-line span.inline-metadata-item') ||
                                   video.querySelector('.inline-metadata-item') ||
                                   video.querySelector('span[aria-label*="view"]') ||
                                   video.querySelector('.reel-item-metadata span');

                const videoTitle = titleElement?.title || titleElement?.textContent?.trim() || 'N/A';
                const channelName = channelElement?.textContent?.trim() || 'N/A';
                const channelUrl = channelElement?.href || 'N/A';
                const viewCountText = viewsElement?.textContent || '0 views';
                const viewCount = parseViews(viewCountText);

                if (channelName !== 'N/A' && channelUrl !== 'N/A' && viewCount >= 0) {
                     results.push({
                        channelName,
                        channelUrl,
                        viewCount,
                        videoTitle,
                    });
                }
            } catch (itemError) {
                console.warn(`ViewHunt: Error processing video item ${index}:`, itemError);
            }
        });

        console.log(`ViewHunt: Successfully extracted data for ${results.length} videos.`);
        
        sendStatus(`Extraction complete. Found ${results.length} videos. Sending to background script...`);
        
        // Send results to background script
        try {
            chrome.runtime.sendMessage({ type: 'scraping-complete', data: results }, (response) => {
                if (chrome.runtime.lastError) {
                    console.error("ViewHunt: Error sending results to background:", chrome.runtime.lastError.message);
                } else {
                    console.log("ViewHunt: Successfully sent results to background script.");
                }
            });
        } catch (sendError) {
            console.error("ViewHunt: Failed to send message to background script:", sendError);
        }

    } catch (error) {
        console.error("ViewHunt: Error in content script:", error);
        sendStatus(`Error: ${error.message}. See console for details.`);
        chrome.runtime.sendMessage({ type: 'scraping-complete', data: [] });
    }
})();
