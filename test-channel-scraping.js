// Test script to see if we can scrape YouTube channel video data
// Run this with: node test-channel-scraping.js

import https from 'https';
import http from 'http';
import zlib from 'zlib';

// Test with a few different channel types
const testChannels = [
    'https://www.youtube.com/@MrBeast/videos',           // Handle format
    'https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA/videos', // Channel ID format
    'https://www.youtube.com/@PewDiePie/videos',         // Another handle
];

async function fetchChannelPage(url, maxRedirects = 3) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Cache-Control': 'max-age=0',
            }
        };

        const req = client.get(url, options, (res) => {
            // Handle redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                if (maxRedirects > 0) {
                    console.log(`Following redirect to: ${res.headers.location}`);
                    return fetchChannelPage(res.headers.location, maxRedirects - 1)
                        .then(resolve)
                        .catch(reject);
                } else {
                    return reject(new Error('Too many redirects'));
                }
            }
            
            let data = '';
            
            // Handle gzip compression
            let stream = res;
            if (res.headers['content-encoding'] === 'gzip') {
                stream = res.pipe(zlib.createGunzip());
            }
            
            stream.on('data', (chunk) => {
                data += chunk;
            });
            
            stream.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: data
                });
            });
        });
        
        req.on('error', (err) => {
            reject(err);
        });
        
        req.setTimeout(15000, () => {
            req.abort();
            reject(new Error('Request timeout'));
        });
    });
}

function extractVideoData(html) {
    console.log('\n=== ANALYZING HTML CONTENT ===');
    console.log('HTML length:', html.length);
    console.log('Contains ytInitialData:', html.includes('ytInitialData'));
    console.log('Contains "var ytInitialData":', html.includes('var ytInitialData'));
    console.log('Contains "window.ytInitialData":', html.includes('window.ytInitialData'));
    
    // Let's see what we actually got
    console.log('\n=== FIRST 1000 CHARACTERS ===');
    console.log(html.substring(0, 1000));
    console.log('\n=== LAST 500 CHARACTERS ===');
    console.log(html.substring(html.length - 500));
    
    // Look for different patterns where video data might be stored
    const patterns = [
        /var ytInitialData = ({.*?});/s,
        /window\["ytInitialData"\] = ({.*?});/s,
        /ytInitialData":\s*({.*?}),\s*"ytInitialPlayerResponse"/s,
        /"contents":\s*({.*?"videoRenderer".*?})/s,
    ];
    
    let videoData = [];
    
    for (let i = 0; i < patterns.length; i++) {
        console.log(`\nTrying pattern ${i + 1}...`);
        const match = html.match(patterns[i]);
        
        if (match) {
            console.log(`✅ Pattern ${i + 1} matched! Data length:`, match[1].length);
            
            try {
                const data = JSON.parse(match[1]);
                console.log('✅ Successfully parsed JSON');
                
                // Try to find video data in the parsed object
                const videos = findVideosInObject(data);
                if (videos.length > 0) {
                    console.log(`✅ Found ${videos.length} videos in pattern ${i + 1}`);
                    videoData = videos;
                    break;
                }
            } catch (parseError) {
                console.log(`❌ Failed to parse JSON from pattern ${i + 1}:`, parseError.message);
            }
        } else {
            console.log(`❌ Pattern ${i + 1} did not match`);
        }
    }
    
    // If JSON parsing fails, try regex extraction
    if (videoData.length === 0) {
        console.log('\n=== TRYING REGEX EXTRACTION ===');
        videoData = extractWithRegex(html);
    }
    
    return videoData;
}

function findVideosInObject(obj, path = '') {
    let videos = [];
    
    if (typeof obj !== 'object' || obj === null) {
        return videos;
    }
    
    // Look for video renderer objects
    if (obj.videoRenderer) {
        const video = extractVideoFromRenderer(obj.videoRenderer);
        if (video) {
            videos.push(video);
        }
    }
    
    // Look for rich item renderer (newer format)
    if (obj.richItemRenderer && obj.richItemRenderer.content && obj.richItemRenderer.content.videoRenderer) {
        const video = extractVideoFromRenderer(obj.richItemRenderer.content.videoRenderer);
        if (video) {
            videos.push(video);
        }
    }
    
    // Recursively search in arrays and objects
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            const newPath = path ? `${path}.${key}` : key;
            const childVideos = findVideosInObject(obj[key], newPath);
            videos = videos.concat(childVideos);
        }
    }
    
    return videos;
}

function extractVideoFromRenderer(videoRenderer) {
    try {
        const title = videoRenderer.title?.runs?.[0]?.text || 
                     videoRenderer.title?.simpleText || 
                     'Unknown Title';
        
        const videoId = videoRenderer.videoId;
        
        // Try to get view count from different possible locations
        let viewCount = 0;
        const viewCountText = videoRenderer.viewCountText?.simpleText || 
                             videoRenderer.viewCountText?.runs?.[0]?.text ||
                             videoRenderer.shortViewCountText?.simpleText ||
                             videoRenderer.shortViewCountText?.runs?.[0]?.text ||
                             '0 views';
        
        viewCount = parseViews(viewCountText);
        
        // Get published time
        const publishedTime = videoRenderer.publishedTimeText?.simpleText || 
                             videoRenderer.publishedTimeText?.runs?.[0]?.text ||
                             'Unknown';
        
        return {
            title,
            videoId,
            viewCount,
            viewCountText,
            publishedTime,
            url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null
        };
    } catch (error) {
        console.log('Error extracting video from renderer:', error.message);
        return null;
    }
}

function extractWithRegex(html) {
    console.log('Trying regex extraction for video data...');
    
    const videos = [];
    
    // Look for video IDs and view counts in the HTML
    const videoIdPattern = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
    const viewCountPattern = /"viewCountText":\s*{"simpleText":"([^"]+)"}/g;
    
    let videoIdMatch;
    const videoIds = [];
    while ((videoIdMatch = videoIdPattern.exec(html)) !== null) {
        videoIds.push(videoIdMatch[1]);
    }
    
    let viewCountMatch;
    const viewCounts = [];
    while ((viewCountMatch = viewCountPattern.exec(html)) !== null) {
        viewCounts.push(viewCountMatch[1]);
    }
    
    console.log(`Found ${videoIds.length} video IDs and ${viewCounts.length} view counts`);
    
    // Match them up (this is approximate)
    const minLength = Math.min(videoIds.length, viewCounts.length, 10); // Limit to first 10
    for (let i = 0; i < minLength; i++) {
        videos.push({
            videoId: videoIds[i],
            viewCountText: viewCounts[i],
            viewCount: parseViews(viewCounts[i]),
            url: `https://www.youtube.com/watch?v=${videoIds[i]}`,
            title: `Video ${i + 1}` // We don't have titles from regex
        });
    }
    
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

function calculateDistributionMetrics(videos) {
    if (videos.length === 0) return null;
    
    const viewCounts = videos.map(v => v.viewCount).sort((a, b) => b - a);
    const mean = viewCounts.reduce((a, b) => a + b) / viewCounts.length;
    
    // Calculate median
    const median = viewCounts[Math.floor(viewCounts.length / 2)];
    
    // Calculate trimmed mean (remove highest and lowest)
    let trimmedMean = mean;
    if (viewCounts.length >= 3) {
        const trimmed = viewCounts.slice(1, -1);
        trimmedMean = trimmed.reduce((a, b) => a + b) / trimmed.length;
    }
    
    // Calculate consistency score
    const variance = viewCounts.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / viewCounts.length;
    const stdDev = Math.sqrt(variance);
    const coefficientOfVariation = mean > 0 ? stdDev / mean : 0;
    const consistencyScore = Math.max(0, 100 - (coefficientOfVariation * 100));
    
    return {
        totalVideos: videos.length,
        viewCounts,
        mean: Math.round(mean),
        median: Math.round(median),
        trimmedMean: Math.round(trimmedMean),
        consistencyScore: Math.round(consistencyScore),
        coefficientOfVariation: coefficientOfVariation.toFixed(3),
        range: `${Math.min(...viewCounts).toLocaleString()} - ${Math.max(...viewCounts).toLocaleString()}`
    };
}

async function testChannel(url) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`TESTING: ${url}`);
    console.log(`${'='.repeat(80)}`);
    
    try {
        console.log('Fetching channel page...');
        const response = await fetchChannelPage(url);
        
        console.log('Response status:', response.statusCode);
        console.log('Content-Type:', response.headers['content-type']);
        console.log('Content-Length:', response.headers['content-length']);
        
        if (response.statusCode !== 200) {
            console.log('❌ Non-200 status code');
            return;
        }
        
        console.log('✅ Successfully fetched page');
        
        // Extract video data
        const videos = extractVideoData(response.body);
        
        if (videos.length === 0) {
            console.log('❌ No videos found');
            return;
        }
        
        console.log(`\n✅ FOUND ${videos.length} VIDEOS:`);
        
        // Show first few videos
        videos.slice(0, 7).forEach((video, index) => {
            console.log(`${index + 1}. ${video.title}`);
            console.log(`   Views: ${video.viewCount.toLocaleString()} (${video.viewCountText})`);
            console.log(`   Published: ${video.publishedTime}`);
            console.log(`   URL: ${video.url}`);
            console.log('');
        });
        
        // Calculate distribution metrics
        const metrics = calculateDistributionMetrics(videos.slice(0, 7));
        if (metrics) {
            console.log('📊 DISTRIBUTION METRICS (Last 7 videos):');
            console.log(`   Mean: ${metrics.mean.toLocaleString()}`);
            console.log(`   Median: ${metrics.median.toLocaleString()}`);
            console.log(`   Trimmed Mean: ${metrics.trimmedMean.toLocaleString()}`);
            console.log(`   Consistency Score: ${metrics.consistencyScore}/100`);
            console.log(`   Coefficient of Variation: ${metrics.coefficientOfVariation}`);
            console.log(`   Range: ${metrics.range}`);
        }
        
        return {
            success: true,
            videoCount: videos.length,
            videos: videos.slice(0, 7),
            metrics
        };
        
    } catch (error) {
        console.log('❌ Error:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

async function runTests() {
    console.log('🧪 YOUTUBE CHANNEL SCRAPING TEST');
    console.log('Testing if we can extract recent video view counts from channel pages...\n');
    
    const results = [];
    
    for (const url of testChannels) {
        const result = await testChannel(url);
        results.push({ url, result });
        
        // Wait between requests to be respectful
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    
    const successful = results.filter(r => r.result && r.result.success);
    console.log(`✅ Successful: ${successful.length}/${results.length}`);
    
    if (successful.length > 0) {
        console.log('\n🎉 WEB SCRAPING IS FEASIBLE!');
        console.log('We can extract recent video data from YouTube channel pages.');
        console.log('This would give us the last 7 videos with view counts for distribution analysis.');
        console.log('\nNext steps:');
        console.log('1. Integrate this into the extension background script');
        console.log('2. Add it as an optional enhancement step');
        console.log('3. Calculate better metrics using distribution data');
    } else {
        console.log('\n❌ Web scraping may not be reliable');
        console.log('YouTube might be blocking or the page structure has changed');
    }
}

// Run the test
runTests().catch(console.error);