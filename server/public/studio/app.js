// Studio App - Frontend Logic

let currentFormat = null;
let generationData = null;

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    initializeFormatSelection();
    initializeGenerator();
});

// Format Selection
function initializeFormatSelection() {
    const formatCards = document.querySelectorAll('.format-card:not(.coming-soon)');
    
    formatCards.forEach(card => {
        card.addEventListener('click', () => {
            const format = card.dataset.format;
            showGenerator(format);
        });
        
        const button = card.querySelector('.btn-primary');
        if (button) {
            button.addEventListener('click', (e) => {
                e.stopPropagation();
                const format = card.dataset.format;
                showGenerator(format);
            });
        }
    });
}

// Show Generator Interface
function showGenerator(format) {
    currentFormat = format;
    document.getElementById('format-selection').classList.add('hidden');
    document.getElementById('generator-interface').classList.remove('hidden');
    
    // Update title based on format
    const titles = {
        'skeleton-anatomy': 'Skeleton Anatomy Generator'
    };
    document.getElementById('format-title').textContent = titles[format] || 'Video Generator';
}

// Back to Formats
document.getElementById('back-to-formats')?.addEventListener('click', () => {
    document.getElementById('generator-interface').classList.add('hidden');
    document.getElementById('format-selection').classList.remove('hidden');
    resetGenerator();
});

// Initialize Generator Form
function initializeGenerator() {
    const form = document.getElementById('generation-form');
    
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        await handleGeneration();
    });
    
    // Generate Another button
    document.getElementById('generate-another')?.addEventListener('click', () => {
        resetGenerator();
    });
}

// Handle Video Generation
async function handleGeneration() {
    const topic = document.getElementById('topic').value;
    const style = document.getElementById('style').value;
    
    if (!topic.trim()) {
        alert('Please enter a topic');
        return;
    }
    
    // Show progress panel
    showProgress();
    
    try {
        // Step 1: Generate Script
        updateProgress('script', 'Generating script...');
        const scriptResponse = await fetch('/api/studio/generate/script', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getAuthToken()}`
            },
            body: JSON.stringify({
                format: currentFormat,
                topic: topic,
                style: style
            })
        });
        
        if (!scriptResponse.ok) {
            throw new Error('Failed to generate script');
        }
        
        const scriptData = await scriptResponse.json();
        completeProgress('script');
        
        // Step 2: Generate Images
        updateProgress('images', 'Creating visual assets...');
        const imagesResponse = await fetch('/api/studio/generate/images', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getAuthToken()}`
            },
            body: JSON.stringify({
                format: currentFormat,
                script: scriptData.script,
                style: style
            })
        });
        
        if (!imagesResponse.ok) {
            throw new Error('Failed to generate images');
        }
        
        const imagesData = await imagesResponse.json();
        completeProgress('images');
        
        // Step 3: Generate Voice
        updateProgress('voice', 'Recording voiceover...');
        const voiceResponse = await fetch('/api/studio/generate/voice', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getAuthToken()}`
            },
            body: JSON.stringify({
                format: currentFormat,
                script: scriptData.script
            })
        });
        
        if (!voiceResponse.ok) {
            throw new Error('Failed to generate voice');
        }
        
        const voiceData = await voiceResponse.json();
        completeProgress('voice');
        completeProgress('complete');
        
        // Store generation data
        generationData = {
            script: scriptData.script,
            images: imagesData.images,
            audio: voiceData.audioUrl,
            topic: topic
        };
        
        // Show output
        showOutput(generationData);
        
    } catch (error) {
        console.error('Generation error:', error);
        alert('Generation failed: ' + error.message);
        hideProgress();
    }
}

// Progress Management
function showProgress() {
    document.querySelector('.input-panel').classList.add('hidden');
    document.getElementById('output-panel').classList.add('hidden');
    document.getElementById('progress-panel').classList.remove('hidden');
    
    // Reset all steps
    document.querySelectorAll('.progress-step').forEach(step => {
        step.classList.remove('active', 'completed');
    });
}

function updateProgress(step, message) {
    const stepElement = document.querySelector(`[data-step="${step}"]`);
    if (stepElement) {
        stepElement.classList.add('active');
    }
    
    document.getElementById('progress-message').textContent = message;
}

function completeProgress(step) {
    const stepElement = document.querySelector(`[data-step="${step}"]`);
    if (stepElement) {
        stepElement.classList.remove('active');
        stepElement.classList.add('completed');
    }
}

function hideProgress() {
    document.getElementById('progress-panel').classList.add('hidden');
    document.querySelector('.input-panel').classList.remove('hidden');
}

// Show Output
function showOutput(data) {
    document.getElementById('progress-panel').classList.add('hidden');
    document.getElementById('output-panel').classList.remove('hidden');
    
    // Display script
    document.getElementById('script-output').textContent = data.script;
    
    // Display images
    const imagesGrid = document.getElementById('images-output');
    imagesGrid.innerHTML = '';
    data.images.forEach((imageUrl, index) => {
        const imageItem = document.createElement('div');
        imageItem.className = 'image-item';
        imageItem.innerHTML = `<img src="${imageUrl}" alt="Scene ${index + 1}">`;
        imagesGrid.appendChild(imageItem);
    });
    
    // Display audio
    const audioPlayer = document.getElementById('audio-player');
    audioPlayer.src = data.audio;
    
    // Setup download buttons
    setupDownloadButtons(data);
}

// Setup Download Buttons
function setupDownloadButtons(data) {
    // Copy script
    document.querySelector('[data-copy="script"]').onclick = () => {
        navigator.clipboard.writeText(data.script);
        alert('Script copied to clipboard!');
    };
    
    // Download images
    document.getElementById('download-images').onclick = async () => {
        for (let i = 0; i < data.images.length; i++) {
            await downloadFile(data.images[i], `scene-${i + 1}.png`);
        }
        alert('All images downloaded!');
    };
    
    // Download audio
    document.getElementById('download-audio').onclick = () => {
        downloadFile(data.audio, 'voiceover.mp3');
    };
}

// Download File Helper
async function downloadFile(url, filename) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        const blobUrl = window.URL.createObjectURL(blob);
        
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        window.URL.revokeObjectURL(blobUrl);
    } catch (error) {
        console.error('Download failed:', error);
        alert('Download failed. Please try again.');
    }
}

// Reset Generator
function resetGenerator() {
    document.getElementById('generation-form').reset();
    document.getElementById('output-panel').classList.add('hidden');
    document.getElementById('progress-panel').classList.add('hidden');
    document.querySelector('.input-panel').classList.remove('hidden');
    generationData = null;
}

// Get Auth Token (from localStorage or cookie)
function getAuthToken() {
    // Try localStorage first
    const token = localStorage.getItem('token');
    if (token) return token;
    
    // Try cookie
    const cookies = document.cookie.split(';');
    for (let cookie of cookies) {
        const [name, value] = cookie.trim().split('=');
        if (name === 'token') return value;
    }
    
    return null;
}

// Check if user is authenticated
function checkAuth() {
    const token = getAuthToken();
    if (!token) {
        window.location.href = '/app';
    }
}

// Check auth on load
checkAuth();
