// V2 Studio App - Skeleton Video Generator with Director Mode

let selectedGradient = 'smooth blue to teal gradient background';
let generationInProgress = false;
let currentScenes = [];
let directorMode = false; // false = auto, true = director

document.addEventListener('DOMContentLoaded', () => {
    initializeGradientSelector();
    initializeGenerateButton();
    initializeModeToggle();
    checkAuth();
});

function initializeGradientSelector() {
    document.querySelectorAll('.gradient-option').forEach(option => {
        option.addEventListener('click', () => {
            document.querySelectorAll('.gradient-option').forEach(o => o.classList.remove('selected'));
            option.classList.add('selected');
            selectedGradient = option.dataset.gradient;
        });
    });
}

function initializeModeToggle() {
    const toggle = document.getElementById('mode-toggle');
    if (toggle) {
        toggle.addEventListener('change', (e) => {
            directorMode = e.target.checked;
            document.getElementById('mode-label').textContent = directorMode ? '🎬 Director Mode' : '⚡ Auto Mode';
            document.getElementById('mode-desc').textContent = directorMode 
                ? 'Review images per scene, pick favorites, generate videos one by one'
                : 'Fully automatic — generates everything in one go';
            
            // Show/hide director-specific options
            document.getElementById('director-options').style.display = directorMode ? 'block' : 'none';
            document.getElementById('generateVideos').parentElement.parentElement.style.display = directorMode ? 'none' : 'block';
        });
    }
}

function initializeGenerateButton() {
    document.getElementById('generate-btn').addEventListener('click', async () => {
        const script = document.getElementById('script').value.trim();
        if (!script) return alert('Please enter a video script');
        if (generationInProgress) return alert('Generation already in progress');
        
        if (directorMode) {
            await handleDirectorGeneration(script);
        } else {
            await handleAutoGeneration(script, document.getElementById('generateVideos').checked);
        }
    });
}

// ==================== DIRECTOR MODE ====================

async function handleDirectorGeneration(script) {
    generationInProgress = true;
    currentScenes = [];
    
    document.getElementById('config-section').classList.add('hidden');
    document.getElementById('director-section').classList.remove('hidden');
    document.getElementById('results-section').classList.add('hidden');
    document.getElementById('progress-section').classList.add('hidden');
    
    const container = document.getElementById('director-scenes');
    container.innerHTML = '<div class="director-loading">🤖 Opus 4.5 is analyzing your script and reference frames...</div>';
    
    try {
        // Step 1: Get scene prompts from Claude
        const res = await fetch('/api/studio/generate/scenes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getAuthToken()}` },
            body: JSON.stringify({ format: 'skeleton-anatomy', script, gradientColors: selectedGradient })
        });
        
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Server error ${res.status}: ${errText}`);
        }
        
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed to generate scenes');
        
        currentScenes = data.scenes;
        container.innerHTML = '';
        
        console.log(`Director mode: received ${currentScenes.length} scenes`);
        
        // Render each scene card with controls
        const imagesPerScene = parseInt(document.getElementById('images-per-scene')?.value || '2');
        
        currentScenes.forEach((scene, i) => {
            const card = createDirectorSceneCard(scene, i);
            container.appendChild(card);
        });
        
        // Add bottom action bar
        const actionBar = document.createElement('div');
        actionBar.className = 'director-actions';
        actionBar.innerHTML = `
            <button class="btn-primary" onclick="generateAllSelectedVideos()">🎥 Generate All Selected Videos</button>
            <button class="btn-secondary" onclick="generateAllImages()">🎨 Generate All Images (${imagesPerScene} each)</button>
            <button class="btn-secondary" onclick="resetToConfig()">← Back</button>
        `;
        container.appendChild(actionBar);
        
    } catch (error) {
        console.error('Director generation error:', error);
        container.innerHTML = `<div class="director-error">❌ ${error.message}<br><button class="btn-secondary" onclick="resetToConfig()" style="margin-top:1rem">Try Again</button></div>`;
    } finally {
        generationInProgress = false;
    }
}

function createDirectorSceneCard(scene, index) {
    const card = document.createElement('div');
    card.className = 'director-card';
    card.id = `scene-${index}`;
    card.dataset.sceneIndex = index;
    
    card.innerHTML = `
        <div class="director-card-header">
            <h3>Scene ${scene.sceneNumber || index + 1}</h3>
            <span class="scene-badge">${scene.shotType || 'medium'}</span>
        </div>
        <p class="scene-script-line">"${escapeHtml(scene.scriptLine || '')}"</p>
        <details class="prompt-details">
            <summary>📸 Image Prompt</summary>
            <p>${escapeHtml(scene.imagePrompt)}</p>
        </details>
        <details class="prompt-details">
            <summary>🎬 Video Prompt</summary>
            <p>${escapeHtml(scene.videoPrompt)}</p>
        </details>
        
        <div class="image-gallery" id="gallery-${index}">
            <div class="gallery-placeholder">Click "Generate Images" to create variants</div>
        </div>
        
        <div class="director-card-controls">
            <button class="btn-sm btn-primary" onclick="generateSceneImages(${index})">🎨 Generate Images</button>
            <button class="btn-sm btn-accent" onclick="generateSceneVideo(${index})" id="video-btn-${index}" disabled>🎥 Generate Video</button>
            <label class="multishot-toggle" title="Use first+last frame for smoother transitions">
                <input type="checkbox" id="multishot-${index}"> Multi-shot
            </label>
        </div>
        
        <div class="video-result" id="video-result-${index}"></div>
    `;
    
    return card;
}

async function generateSceneImages(sceneIndex) {
    const scene = currentScenes[sceneIndex];
    const gallery = document.getElementById(`gallery-${sceneIndex}`);
    const count = parseInt(document.getElementById('images-per-scene')?.value || '2');
    
    gallery.innerHTML = `<div class="gallery-loading">🎨 Generating ${count} image variants...</div>`;
    
    try {
        console.log(`Generating ${count} images for scene ${sceneIndex + 1}...`);
        const res = await fetch('/api/studio/generate/scene-images', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getAuthToken()}` },
            body: JSON.stringify({
                format: 'skeleton-anatomy',
                imagePrompt: scene.imagePrompt,
                sceneNumber: scene.sceneNumber || sceneIndex + 1,
                count
            })
        });
        
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Server error ${res.status}: ${errText}`);
        }
        
        const data = await res.json();
        console.log(`Scene ${sceneIndex + 1} images response:`, data);
        if (!data.success) throw new Error(data.error);
        
        gallery.innerHTML = '';
        
        data.images.forEach((img, i) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'gallery-item';
            
            if (img.error) {
                wrapper.innerHTML = `<div class="gallery-error">❌ Failed<br><small>${img.error}</small></div>`;
            } else {
                wrapper.innerHTML = `<img src="${img.url}" alt="Variant ${i + 1}" loading="lazy">`;
                wrapper.onclick = () => selectImage(sceneIndex, img.url, wrapper);
                
                // Auto-select first successful image
                if (!scene._selectedImage) {
                    selectImage(sceneIndex, img.url, wrapper);
                }
            }
            
            gallery.appendChild(wrapper);
        });
        
        // Add regenerate button
        const regenBtn = document.createElement('div');
        regenBtn.className = 'gallery-item gallery-regen';
        regenBtn.innerHTML = '🔄<br><small>More</small>';
        regenBtn.onclick = () => generateSceneImages(sceneIndex);
        gallery.appendChild(regenBtn);
        
    } catch (error) {
        console.error(`Scene ${sceneIndex + 1} image error:`, error);
        gallery.innerHTML = `<div class="gallery-error">❌ ${error.message}<br><button class="btn-sm btn-secondary" onclick="generateSceneImages(${sceneIndex})" style="margin-top:0.5rem">Retry</button></div>`;
    }
}

function selectImage(sceneIndex, imageUrl, element) {
    currentScenes[sceneIndex]._selectedImage = imageUrl;
    
    // Update visual selection
    const gallery = document.getElementById(`gallery-${sceneIndex}`);
    gallery.querySelectorAll('.gallery-item').forEach(item => item.classList.remove('selected'));
    if (element) element.classList.add('selected');
    
    // Enable video button
    document.getElementById(`video-btn-${sceneIndex}`).disabled = false;
}

async function generateSceneVideo(sceneIndex) {
    const scene = currentScenes[sceneIndex];
    const imageUrl = scene._selectedImage;
    if (!imageUrl) return alert('Select an image first');
    
    const videoResult = document.getElementById(`video-result-${sceneIndex}`);
    const btn = document.getElementById(`video-btn-${sceneIndex}`);
    btn.disabled = true;
    btn.textContent = '⏳ Generating...';
    videoResult.innerHTML = '<div class="video-loading">🎥 Generating video (1-3 min)...</div>';
    
    const multishot = document.getElementById(`multishot-${sceneIndex}`)?.checked;
    
    // For multi-shot, use next scene's selected image as last_image
    let lastImageUrl = null;
    if (multishot && sceneIndex < currentScenes.length - 1) {
        lastImageUrl = currentScenes[sceneIndex + 1]?._selectedImage || null;
        if (!lastImageUrl) {
            videoResult.innerHTML = '<div class="video-loading">⚠️ Multi-shot needs the next scene\'s image selected first. Generating without it...</div>';
        }
    }
    
    try {
        console.log(`Generating video for scene ${sceneIndex + 1}...`);
        const res = await fetch('/api/studio/generate/scene-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getAuthToken()}` },
            body: JSON.stringify({
                format: 'skeleton-anatomy',
                imageUrl,
                videoPrompt: scene.videoPrompt,
                sceneNumber: scene.sceneNumber || sceneIndex + 1,
                lastImageUrl
            })
        });
        
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Server error ${res.status}: ${errText}`);
        }
        
        const data = await res.json();
        console.log(`Scene ${sceneIndex + 1} video response:`, data);
        if (!data.success) throw new Error(data.error);
        
        scene._videoUrl = data.videoUrl;
        videoResult.innerHTML = `
            <video src="${data.videoUrl}" controls muted loop class="video-preview"></video>
            <button class="btn-sm btn-secondary" onclick="generateSceneVideo(${sceneIndex})">🔄 Regenerate</button>
        `;
        
    } catch (error) {
        console.error(`Scene ${sceneIndex + 1} video error:`, error);
        videoResult.innerHTML = `<div class="video-error">❌ ${error.message}<br><button class="btn-sm btn-secondary" onclick="generateSceneVideo(${sceneIndex})">Retry</button></div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = '🎥 Generate Video';
    }
}

async function generateAllImages() {
    const count = parseInt(document.getElementById('images-per-scene')?.value || '2');
    for (let i = 0; i < currentScenes.length; i++) {
        generateSceneImages(i); // Fire all in parallel
    }
}

async function generateAllSelectedVideos() {
    const scenesWithImages = currentScenes.filter(s => s._selectedImage);
    if (scenesWithImages.length === 0) return alert('Generate and select images first');
    
    if (!confirm(`Generate videos for ${scenesWithImages.length} scenes? Estimated cost: ~$${(scenesWithImages.length * 0.64).toFixed(2)}`)) return;
    
    for (let i = 0; i < currentScenes.length; i++) {
        if (currentScenes[i]._selectedImage) {
            generateSceneVideo(i); // Fire all in parallel
        }
    }
}

// ==================== AUTO MODE (existing behavior) ====================

async function handleAutoGeneration(script, generateVideos) {
    generationInProgress = true;
    currentScenes = [];
    
    document.getElementById('config-section').classList.add('hidden');
    document.getElementById('progress-section').classList.remove('hidden');
    document.getElementById('results-section').classList.add('hidden');
    document.getElementById('director-section').classList.add('hidden');
    
    document.querySelectorAll('.progress-step').forEach(s => s.classList.remove('active', 'completed'));
    document.getElementById('scenes-container').innerHTML = '';
    
    try {
        const response = await fetch('/api/studio/generate/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getAuthToken()}` },
            body: JSON.stringify({ format: 'skeleton-anatomy', script, gradientColors: selectedGradient, generateVideos })
        });
        
        if (!response.ok) throw new Error('Failed to start generation stream');
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop();
            
            for (const line of lines) {
                if (!line.trim()) continue;
                const eventMatch = line.match(/^event: (.+)\ndata: (.+)$/);
                if (!eventMatch) continue;
                const [, event, dataStr] = eventMatch;
                handleStreamEvent(event, JSON.parse(dataStr), generateVideos);
            }
        }
    } catch (error) {
        console.error('Generation error:', error);
        updateProgressMessage(`❌ Error: ${error.message}`);
        setTimeout(() => { if (confirm('Generation failed. Try again?')) resetToConfig(); }, 2000);
    } finally {
        generationInProgress = false;
    }
}

function handleStreamEvent(event, data, hasVideos) {
    switch (event) {
        case 'progress': handleProgressUpdate(data); break;
        case 'scene': handleSceneComplete(data, hasVideos); break;
        case 'complete': handleGenerationComplete(data); break;
        case 'error': updateProgressMessage(`❌ ${data.error}`); break;
    }
}

function handleProgressUpdate(data) {
    const { step, status, message, completed, total } = data;
    if (step === 'claude') {
        updateProgressStep('claude', status === 'completed' ? 'completed' : 'active');
        updateProgressMessage((status === 'completed' ? '✅ ' : '🤖 ') + message);
    } else if (step === 'images') {
        updateProgressStep('images', status === 'completed' ? 'completed' : 'active');
        updateProgressMessage(`🎨 ${message}${completed && total ? ` (${completed}/${total})` : ''}`);
    } else if (step === 'videos') {
        updateProgressStep('videos', status === 'completed' ? 'completed' : 'active');
        updateProgressMessage(`🎥 ${message}${completed && total ? ` (${completed}/${total})` : ''}`);
    }
}

function handleSceneComplete(scene, hasVideos) {
    currentScenes.push(scene);
    document.getElementById('results-section').classList.remove('hidden');
    const container = document.getElementById('scenes-container');
    const card = createAutoSceneCard(scene, scene.sceneNumber, hasVideos);
    container.appendChild(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function handleGenerationComplete(data) {
    updateProgressStep('complete', 'completed');
    updateProgressMessage('🎉 Generation complete!');
    currentScenes = data.scenes || currentScenes;
    generationInProgress = false;
}

function createAutoSceneCard(scene, num, hasVideos) {
    const card = document.createElement('div');
    card.className = 'scene-card';
    card.innerHTML = `
        <div class="scene-header"><h3>Scene ${num}</h3><span class="scene-status ${scene.videoUrl || !hasVideos ? 'status-complete' : 'status-pending'}">${scene.videoUrl || !hasVideos ? 'Complete' : 'Pending'}</span></div>
        <p class="scene-script-line">"${escapeHtml(scene.scriptLine || scene.narration || '')}"</p>
        <details class="prompt-details"><summary>📸 Image Prompt</summary><p>${escapeHtml(scene.imagePrompt)}</p></details>
        <details class="prompt-details"><summary>🎬 Video Prompt</summary><p>${escapeHtml(scene.videoPrompt || '')}</p></details>
        <div class="scene-media">
            <div class="media-preview">${scene.imageUrl ? `<img src="${scene.imageUrl}" alt="Scene ${num}" loading="lazy">` : '<div class="media-placeholder">Loading...</div>'}</div>
            <div class="media-preview">${scene.videoUrl ? `<video src="${scene.videoUrl}" controls muted loop></video>` : hasVideos ? '<div class="media-placeholder">Video generating...</div>' : '<div class="media-placeholder">Image only</div>'}</div>
        </div>
    `;
    return card;
}

// ==================== SHARED UTILITIES ====================

function updateProgressStep(step, status) {
    const el = document.querySelector(`[data-step="${step}"]`);
    if (!el) return;
    el.classList.remove('active', 'completed');
    el.classList.add(status);
    el.style.opacity = status ? '1' : '0.3';
}

function updateProgressMessage(msg) {
    const el = document.getElementById('progress-message');
    if (el) el.textContent = msg;
}

function resetToConfig() {
    document.getElementById('config-section').classList.remove('hidden');
    ['progress-section', 'results-section', 'director-section'].forEach(id => {
        document.getElementById(id)?.classList.add('hidden');
    });
    currentScenes = [];
    generationInProgress = false;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

function getAuthToken() {
    return localStorage.getItem('viewhunt_token') || localStorage.getItem('token') || 
        (document.cookie.split(';').find(c => c.trim().startsWith('token=')) || '').split('=')[1] || null;
}

function checkAuth() {
    if (!getAuthToken()) console.warn('No auth token found - log in at /app first');
}
