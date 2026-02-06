// V2 Studio App - Skeleton Video Generator with Claude + Kie.ai

let selectedGradient = 'smooth blue to teal gradient background';
let generationInProgress = false;
let currentScenes = [];

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    initializeGradientSelector();
    initializeGenerateButton();
    checkAuth();
});

// Gradient Selector
function initializeGradientSelector() {
    const gradientOptions = document.querySelectorAll('.gradient-option');
    
    gradientOptions.forEach(option => {
        option.addEventListener('click', () => {
            // Remove selected class from all
            gradientOptions.forEach(opt => opt.classList.remove('selected'));
            
            // Add selected class to clicked option
            option.classList.add('selected');
            
            // Store selected gradient
            selectedGradient = option.dataset.gradient;
            console.log('Selected gradient:', selectedGradient);
        });
    });
}

// Generate Button Handler
function initializeGenerateButton() {
    const generateBtn = document.getElementById('generate-btn');
    const scriptInput = document.getElementById('script');
    const generateVideosCheckbox = document.getElementById('generateVideos');
    
    generateBtn.addEventListener('click', async () => {
        const script = scriptInput.value.trim();
        
        if (!script) {
            alert('Please enter a video script');
            return;
        }
        
        if (generationInProgress) {
            alert('Generation already in progress. Please wait...');
            return;
        }
        
        const generateVideos = generateVideosCheckbox.checked;
        
        await handleFullGeneration(script, generateVideos);
    });
}

// Handle Full Video Generation with Real-Time Streaming
async function handleFullGeneration(script, generateVideos) {
    generationInProgress = true;
    currentScenes = [];
    
    // Hide config, show progress
    document.getElementById('config-section').classList.add('hidden');
    document.getElementById('progress-section').classList.remove('hidden');
    document.getElementById('results-section').classList.add('hidden');
    
    // Reset progress steps
    document.querySelectorAll('.progress-step').forEach(step => {
        step.classList.remove('active', 'completed');
    });
    
    // Clear previous results
    document.getElementById('scenes-container').innerHTML = '';
    
    try {
        // Use EventSource for Server-Sent Events
        const eventSource = new EventSource(`/api/studio/generate/stream?${new URLSearchParams({
            format: 'skeleton-anatomy',
            script: script,
            gradientColors: selectedGradient,
            generateVideos: generateVideos
        })}`);
        
        // This won't work with POST, so let's use fetch with streaming instead
        const response = await fetch('/api/studio/generate/stream', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${getAuthToken()}`
            },
            body: JSON.stringify({
                format: 'skeleton-anatomy',
                script: script,
                gradientColors: selectedGradient,
                generateVideos: generateVideos
            })
        });
        
        if (!response.ok) {
            throw new Error('Failed to start generation stream');
        }
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        while (true) {
            const { done, value } = await reader.read();
            
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            
            // Process complete SSE messages
            const lines = buffer.split('\n\n');
            buffer = lines.pop(); // Keep incomplete message in buffer
            
            for (const line of lines) {
                if (!line.trim()) continue;
                
                const eventMatch = line.match(/^event: (.+)\ndata: (.+)$/);
                if (!eventMatch) continue;
                
                const [, event, dataStr] = eventMatch;
                const data = JSON.parse(dataStr);
                
                handleStreamEvent(event, data, generateVideos);
            }
        }
        
    } catch (error) {
        console.error('Generation error:', error);
        updateProgressMessage(`❌ Error: ${error.message}`);
        
        // Show error and allow retry
        setTimeout(() => {
            if (confirm('Generation failed. Would you like to try again?')) {
                resetToConfig();
            }
        }, 2000);
    } finally {
        generationInProgress = false;
    }
}

// Handle streaming events
function handleStreamEvent(event, data, hasVideos) {
    console.log('Stream event:', event, data);
    
    switch (event) {
        case 'progress':
            handleProgressUpdate(data);
            break;
            
        case 'scene':
            handleSceneComplete(data, hasVideos);
            break;
            
        case 'complete':
            handleGenerationComplete(data, hasVideos);
            break;
            
        case 'error':
            throw new Error(data.error || 'Generation failed');
    }
}

// Handle progress updates
function handleProgressUpdate(data) {
    const { step, status, message, completed, total } = data;
    
    if (step === 'claude') {
        if (status === 'processing') {
            updateProgressStep('claude', 'active');
            updateProgressMessage('🤖 ' + message);
        } else if (status === 'completed') {
            updateProgressStep('claude', 'completed');
            updateProgressMessage('✅ ' + message);
        }
    } else if (step === 'images') {
        updateProgressStep('images', 'active');
        if (completed && total) {
            updateProgressMessage(`🎨 ${message} (${completed}/${total})`);
        } else {
            updateProgressMessage('🎨 ' + message);
        }
        
        if (status === 'completed') {
            updateProgressStep('images', 'completed');
        }
    } else if (step === 'videos') {
        updateProgressStep('videos', 'active');
        if (completed && total) {
            updateProgressMessage(`🎥 ${message} (${completed}/${total})`);
        } else {
            updateProgressMessage('🎥 ' + message);
        }
        
        if (status === 'completed') {
            updateProgressStep('videos', 'completed');
            if (data.cost) {
                updateProgressMessage(`✅ ${message} - Cost: $${data.cost.toFixed(2)}`);
            }
        }
    }
}

// Handle scene completion - show immediately
function handleSceneComplete(scene, hasVideos) {
    currentScenes.push(scene);
    
    // Show results section if not already visible
    const resultsSection = document.getElementById('results-section');
    if (resultsSection.classList.contains('hidden')) {
        resultsSection.classList.remove('hidden');
    }
    
    // Add scene card to container
    const container = document.getElementById('scenes-container');
    const sceneCard = createSceneCard(scene, scene.sceneNumber, hasVideos);
    container.appendChild(sceneCard);
    
    // Scroll to the new scene
    sceneCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Handle generation complete
function handleGenerationComplete(data, hasVideos) {
    updateProgressStep('complete', 'completed');
    updateProgressMessage('🎉 Generation complete! All results shown below.');
    
    // Store all scenes
    currentScenes = data.scenes || currentScenes;
    
    generationInProgress = false;
}
            }
        }, 2000);
    } finally {
        generationInProgress = false;
    }
}

// Update Progress Step
function updateProgressStep(step, status) {
    const stepElement = document.querySelector(`[data-step="${step}"]`);
    if (!stepElement) return;
    
    // Remove all status classes
    stepElement.classList.remove('active', 'completed');
    
    // Add new status
    if (status === 'active') {
        stepElement.classList.add('active');
        stepElement.style.opacity = '1';
    } else if (status === 'completed') {
        stepElement.classList.add('completed');
        stepElement.style.opacity = '1';
    }
}

// Update Progress Message
function updateProgressMessage(message) {
    const messageElement = document.getElementById('progress-message');
    if (messageElement) {
        messageElement.textContent = message;
    }
}

// Show Results
function showResults(scenes, hasVideos) {
    // Hide progress, show results
    document.getElementById('progress-section').classList.add('hidden');
    document.getElementById('results-section').classList.remove('hidden');
    
    // Render scenes
    const scenesContainer = document.getElementById('scenes-container');
    scenesContainer.innerHTML = '';
    
    scenes.forEach((scene, index) => {
        const sceneCard = createSceneCard(scene, index + 1, hasVideos);
        scenesContainer.appendChild(sceneCard);
    });
    
    // Setup download buttons
    setupDownloadButtons(scenes, hasVideos);
}

// Create Scene Card
function createSceneCard(scene, sceneNumber, hasVideos) {
    const card = document.createElement('div');
    card.className = 'scene-card';
    
    const statusClass = scene.videoUrl || !hasVideos ? 'status-complete' : 'status-pending';
    const statusText = scene.videoUrl || !hasVideos ? 'Complete' : 'Pending';
    
    card.innerHTML = `
        <div class="scene-header">
            <h3>Scene ${sceneNumber}</h3>
            <span class="scene-status ${statusClass}">${statusText}</span>
        </div>
        
        <p style="color: #666; margin-bottom: 0.5rem; font-size: 0.9rem;">
            <strong>Narration:</strong> ${escapeHtml(scene.narration)}
        </p>
        
        <div style="color: #888; font-size: 0.85rem; margin-bottom: 1rem;">
            <details style="margin-bottom: 0.5rem;">
                <summary style="cursor: pointer; color: #666; font-weight: bold;">📸 Image Prompt</summary>
                <p style="margin-top: 0.5rem; padding: 0.5rem; background: #f5f5f5; border-radius: 4px; white-space: pre-wrap;">
                    ${escapeHtml(scene.imagePrompt)}
                </p>
            </details>
            <details>
                <summary style="cursor: pointer; color: #666; font-weight: bold;">🎬 Video Prompt</summary>
                <p style="margin-top: 0.5rem; padding: 0.5rem; background: #f5f5f5; border-radius: 4px; white-space: pre-wrap;">
                    ${escapeHtml(scene.videoPrompt || 'No video prompt')}
                </p>
            </details>
        </div>
        
        <div class="scene-media">
            <div class="media-preview">
                ${scene.imageUrl ? 
                    `<img src="${scene.imageUrl}" alt="Scene ${sceneNumber} Image" loading="lazy">` :
                    `<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #999;">Loading...</div>`
                }
            </div>
            
            <div class="media-preview">
                ${scene.videoUrl ? 
                    `<video src="${scene.videoUrl}" controls muted loop>
                        Your browser does not support video playback.
                    </video>` :
                    hasVideos ?
                        `<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #999;">Video generating...</div>` :
                        `<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: #999;">Image only</div>`
                }
            </div>
        </div>
    `;
    
    return card;
}

// Setup Download Buttons
function setupDownloadButtons(scenes, hasVideos) {
    const downloadAllBtn = document.getElementById('download-all-btn');
    const generateAnotherBtn = document.getElementById('generate-another-btn');
    
    // Download all videos
    downloadAllBtn.onclick = async () => {
        if (!hasVideos) {
            alert('No videos to download. You generated images only.');
            return;
        }
        
        downloadAllBtn.disabled = true;
        downloadAllBtn.textContent = '⏳ Downloading...';
        
        try {
            for (let i = 0; i < scenes.length; i++) {
                const scene = scenes[i];
                if (scene.videoUrl) {
                    await downloadFile(scene.videoUrl, `scene-${i + 1}.mp4`);
                    await new Promise(resolve => setTimeout(resolve, 500)); // Small delay between downloads
                }
            }
            
            alert(`✅ Downloaded ${scenes.length} videos!`);
        } catch (error) {
            console.error('Download error:', error);
            alert('Some downloads may have failed. Please try again.');
        } finally {
            downloadAllBtn.disabled = false;
            downloadAllBtn.textContent = '📥 Download All Videos';
        }
    };
    
    // Generate another
    generateAnotherBtn.onclick = () => {
        resetToConfig();
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
        console.error('Download failed for', filename, error);
        throw error;
    }
}

// Reset to Configuration
function resetToConfig() {
    document.getElementById('config-section').classList.remove('hidden');
    document.getElementById('progress-section').classList.add('hidden');
    document.getElementById('results-section').classList.add('hidden');
    
    // Clear script input
    document.getElementById('script').value = '';
    
    // Reset scenes
    currentScenes = [];
    generationInProgress = false;
}

// HTML Escape Helper
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Get Auth Token
function getAuthToken() {
    // Try viewhunt_token first (used by /app)
    let token = localStorage.getItem('viewhunt_token');
    if (token) return token;
    
    // Try token (fallback)
    token = localStorage.getItem('token');
    if (token) return token;
    
    // Try cookie as last resort
    const cookies = document.cookie.split(';');
    for (let cookie of cookies) {
        const [name, value] = cookie.trim().split('=');
        if (name === 'token' || name === 'viewhunt_token') return value;
    }
    
    return null;
}

// Check Authentication
function checkAuth() {
    const token = getAuthToken();
    if (!token) {
        console.warn('No auth token found - you may need to log in at /app first');
        // Don't redirect immediately - let user try to use the page
        // The API will return 401 if auth is actually required
        return false;
    }
    return true;
}

// Add CSS for progress steps
const style = document.createElement('style');
style.textContent = `
    .progress-step {
        opacity: 0.3;
        transition: all 0.3s ease;
    }
    
    .progress-step.active {
        opacity: 1;
        animation: pulse 1.5s ease-in-out infinite;
    }
    
    .progress-step.completed {
        opacity: 1;
    }
    
    .progress-step.completed .step-icon {
        transform: scale(1.2);
    }
    
    @keyframes pulse {
        0%, 100% { transform: scale(1); }
        50% { transform: scale(1.1); }
    }
    
    .hidden {
        display: none !important;
    }
    
    .btn-generate {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        border: none;
        padding: 1rem 2rem;
        border-radius: 8px;
        font-size: 1.1rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.3s ease;
        width: 100%;
        margin-top: 1rem;
    }
    
    .btn-generate:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 20px rgba(102, 126, 234, 0.4);
    }
    
    .btn-generate:disabled {
        opacity: 0.6;
        cursor: not-allowed;
        transform: none;
    }
    
    .btn-primary, .btn-secondary {
        padding: 0.75rem 1.5rem;
        border-radius: 8px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s ease;
        border: none;
        font-size: 1rem;
    }
    
    .btn-primary {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
    }
    
    .btn-primary:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 20px rgba(102, 126, 234, 0.4);
    }
    
    .btn-secondary {
        background: white;
        color: #667eea;
        border: 2px solid #667eea;
    }
    
    .btn-secondary:hover {
        background: #f8f9ff;
    }
    
    .progress-panel {
        background: white;
        border-radius: 12px;
        padding: 2rem;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    }
    
    .progress-steps {
        display: flex;
        justify-content: space-between;
        margin-bottom: 2rem;
        gap: 1rem;
    }
    
    .progress-step {
        flex: 1;
        text-align: center;
    }
    
    .step-icon {
        font-size: 2rem;
        margin-bottom: 0.5rem;
        transition: transform 0.3s ease;
    }
    
    .step-label {
        font-size: 0.9rem;
        color: #666;
        font-weight: 500;
    }
    
    .progress-message {
        text-align: center;
        font-size: 1.1rem;
        color: #333;
        font-weight: 500;
        padding: 1rem;
        background: #f8f9ff;
        border-radius: 8px;
    }
`;
document.head.appendChild(style);
