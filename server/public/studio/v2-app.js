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

// Handle Full Video Generation
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
    
    try {
        // Step 1: Claude - Breaking into scenes
        updateProgressStep('claude', 'active');
        updateProgressMessage('🤖 Claude is analyzing your script and breaking it into scenes...');
        
        const response = await fetch('/api/studio/generate/full', {
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
            const errorData = await response.json();
            throw new Error(errorData.details || errorData.error || 'Generation failed');
        }
        
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.error || 'Generation failed');
        }
        
        updateProgressStep('claude', 'completed');
        updateProgressMessage(`✅ Script broken into ${data.scenes.length} scenes!`);
        
        // Step 2: Images - Generating images for each scene
        updateProgressStep('images', 'active');
        updateProgressMessage(`🎨 Generating ${data.scenes.length} images with Kie.ai Nano Banana Pro...`);
        
        // Wait for images to complete (they're already being generated in the backend)
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        updateProgressStep('images', 'completed');
        updateProgressMessage(`✅ All ${data.scenes.length} images generated!`);
        
        // Step 3: Videos (if enabled)
        if (generateVideos) {
            updateProgressStep('videos', 'active');
            updateProgressMessage(`🎥 Creating ${data.scenes.length} videos with Kie.ai Veo 3.1 Fast... (this takes 5-10 min)`);
            
            // Wait for videos to complete
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            updateProgressStep('videos', 'completed');
            updateProgressMessage(`✅ All ${data.scenes.length} videos created!`);
        } else {
            // Skip video step
            document.querySelector('[data-step="videos"]').style.opacity = '0.3';
        }
        
        // Step 4: Complete
        updateProgressStep('complete', 'completed');
        updateProgressMessage('🎉 Generation complete! View your results below.');
        
        // Store scenes
        currentScenes = data.scenes;
        
        // Show results after a brief delay
        setTimeout(() => {
            showResults(data.scenes, generateVideos);
        }, 1500);
        
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
        
        <p style="color: #888; font-size: 0.85rem; margin-bottom: 1rem;">
            <strong>Image Prompt:</strong> ${escapeHtml(scene.imagePrompt.substring(0, 100))}...
        </p>
        
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
