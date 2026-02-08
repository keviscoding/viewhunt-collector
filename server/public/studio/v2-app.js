// V2 Studio App — Skeleton Video Generator

let selectedGradient = 'smooth blue to teal gradient background';
let generationInProgress = false;
let currentScenes = [];
let directorMode = false;

document.addEventListener('DOMContentLoaded', () => {
    initGradients();
    initModeToggle();
    initGenerateButton();
    checkAuth();
});

// ==================== INIT ====================

function initGradients() {
    document.querySelectorAll('.gradient-swatch').forEach(el => {
        el.addEventListener('click', () => {
            document.querySelectorAll('.gradient-swatch').forEach(o => o.classList.remove('selected'));
            el.classList.add('selected');
            selectedGradient = el.dataset.gradient;
        });
    });
}

function initModeToggle() {
    const track = document.getElementById('mode-toggle');
    if (!track) return;
    
    const toggle = () => {
        directorMode = !directorMode;
        track.classList.toggle('on', directorMode);
        track.setAttribute('aria-checked', directorMode);
        document.getElementById('mode-name').textContent = directorMode ? 'Director Mode' : 'Auto Mode';
        document.getElementById('mode-desc').textContent = directorMode
            ? '— pick your favorite images, edit prompts, then generate videos'
            : '— generates everything in one go';
        
        const videosGroup = document.getElementById('generateVideos')?.closest('.form-group');
        if (videosGroup) videosGroup.style.display = directorMode ? 'none' : 'block';
        
        document.querySelector('#generate-btn .btn-text').textContent = directorMode ? 'Generate Scenes + Images' : 'Generate Video';
    };
    
    track.addEventListener('click', toggle);
    track.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
}

function initGenerateButton() {
    document.getElementById('generate-btn').addEventListener('click', async () => {
        const script = document.getElementById('script').value.trim();
        if (!script) return alert('Enter a script first');
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
    
    show('director-section');
    hide('config-section', 'results-section', 'progress-section');
    
    const container = document.getElementById('director-scenes');
    container.innerHTML = '<div class="director-loading">🤖 Claude is analyzing your script and reference frames...</div>';
    
    try {
        const res = await fetch('/api/studio/generate/scenes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getAuthToken()}` },
            body: JSON.stringify({ format: 'skeleton-anatomy', script, gradientColors: selectedGradient })
        });
        
        if (!res.ok) throw new Error(`Server error ${res.status}: ${await res.text()}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed to generate scenes');
        
        currentScenes = data.scenes;
        container.innerHTML = '';
        
        currentScenes.forEach((scene, i) => container.appendChild(createDirectorCard(scene, i)));
        
        // Action bar with download all + generate all
        const bar = document.createElement('div');
        bar.className = 'action-bar';
        bar.id = 'director-action-bar';
        bar.innerHTML = `
            <button class="btn btn-green" onclick="generateAllSelectedVideos()">🎥 Generate All Selected Videos</button>
            <button class="btn btn-primary" onclick="downloadAllDirectorVideos()" id="director-download-btn" style="display:none">📥 Download All Videos</button>
            <button class="btn btn-secondary" onclick="resetToConfig()">← Start Over</button>
        `;
        container.appendChild(bar);
        
        // Auto-generate 4 images per scene
        for (let i = 0; i < currentScenes.length; i++) {
            generateSceneImages(i, 4);
        }
        
    } catch (error) {
        console.error('Director generation error:', error);
        container.innerHTML = `<div class="director-error">❌ ${error.message}<br><button class="btn btn-secondary btn-sm" onclick="resetToConfig()" style="margin-top:1rem">Try Again</button></div>`;
    } finally {
        generationInProgress = false;
    }
}

function createDirectorCard(scene, index) {
    const card = document.createElement('div');
    card.className = 'scene-card';
    card.id = `scene-${index}`;
    
    card.innerHTML = `
        <div class="scene-head">
            <span class="scene-num">Scene ${scene.sceneNumber || index + 1}</span>
            <span class="scene-tag">${esc(scene.shotType || 'medium')}</span>
        </div>
        <p class="scene-script">"${esc(scene.scriptLine || '')}"</p>
        
        <div class="prompt-toggle" onclick="togglePrompt(this)">
            <span class="arrow">▶</span> Image Prompt
        </div>
        <div class="prompt-body"><p>${esc(scene.imagePrompt)}</p></div>
        
        <div class="prompt-toggle" onclick="togglePrompt(this)">
            <span class="arrow">▶</span> Video Prompt <span class="edit-hint">(editable)</span><span class="edited-badge" id="edited-badge-${index}">✏️</span>
        </div>
        <div class="prompt-body">
            <textarea class="video-prompt-editor" id="video-prompt-${index}" rows="3" data-original="${esc(scene.videoPrompt)}">${esc(scene.videoPrompt)}</textarea>
        </div>
        
        <div class="gallery" id="gallery-${index}">
            <div class="gallery-loading">🎨 Generating 4 variants...</div>
        </div>
        
        <div class="scene-controls">
            <button class="btn btn-secondary btn-sm" onclick="generateSceneImages(${index}, 4)">↻ More Images</button>
            <button class="btn-upload" id="upload-btn-${index}" onclick="triggerUpload(${index})" title="Upload your own image">+ Upload</button>
            <button class="btn btn-green btn-sm" onclick="generateSceneVideo(${index})" id="video-btn-${index}" disabled>🎥 Generate Video</button>
        </div>
        <input type="file" id="upload-input-${index}" accept="image/*" style="display:none" onchange="handleUpload(${index}, this)">
        
        <div class="video-result" id="video-result-${index}"></div>
    `;
    
    // Track edits
    const ta = card.querySelector(`#video-prompt-${index}`);
    ta.addEventListener('input', () => {
        const edited = ta.value.trim() !== ta.dataset.original;
        ta.classList.toggle('edited', edited);
        const badge = document.getElementById(`edited-badge-${index}`);
        if (badge) badge.classList.toggle('visible', edited);
    });
    
    // Drop zones
    setupDrop(card.querySelector(`#upload-btn-${index}`), index);
    setupDrop(card.querySelector(`#gallery-${index}`), index);
    
    return card;
}

function togglePrompt(el) {
    el.classList.toggle('open');
    const body = el.nextElementSibling;
    if (body) body.classList.toggle('open');
}

function setupDrop(el, idx) {
    if (!el) return;
    el.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.add('dragover'); });
    el.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.remove('dragover'); });
    el.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation(); el.classList.remove('dragover');
        const f = e.dataTransfer.files;
        if (f.length > 0 && f[0].type.startsWith('image/')) handleUpload(idx, { files: [f[0]], value: '' });
    });
}

async function generateSceneImages(sceneIndex, count) {
    const scene = currentScenes[sceneIndex];
    const gallery = document.getElementById(`gallery-${sceneIndex}`);
    const num = count || 4;
    
    const existing = gallery.querySelectorAll('.gallery-item:not(.gallery-regen)');
    if (existing.length === 0) {
        gallery.innerHTML = `<div class="gallery-loading">🎨 Generating ${num} variants...</div>`;
    } else {
        const regen = gallery.querySelector('.gallery-regen');
        if (regen) regen.innerHTML = '⏳';
    }
    
    try {
        const res = await fetch('/api/studio/generate/scene-images', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getAuthToken()}` },
            body: JSON.stringify({ format: 'skeleton-anatomy', imagePrompt: scene.imagePrompt, sceneNumber: scene.sceneNumber || sceneIndex + 1, count: num })
        });
        
        if (!res.ok) throw new Error(`Server error ${res.status}: ${await res.text()}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        
        if (existing.length === 0) gallery.innerHTML = '';
        else { const r = gallery.querySelector('.gallery-regen'); if (r) r.remove(); }
        
        data.images.forEach(img => {
            const w = document.createElement('div');
            w.className = 'gallery-item';
            if (img.error) {
                w.innerHTML = `<div class="gallery-error">❌<br><small>${img.error.substring(0, 30)}</small></div>`;
            } else {
                w.innerHTML = `<img src="${img.url}" alt="Variant" loading="lazy"><div class="gallery-check">✓</div>`;
                w.onclick = () => selectImage(sceneIndex, img.url, w);
                if (!scene._selectedImage) selectImage(sceneIndex, img.url, w);
            }
            gallery.appendChild(w);
        });
        
        const more = document.createElement('div');
        more.className = 'gallery-item gallery-regen';
        more.innerHTML = '↻<br><small>More</small>';
        more.onclick = () => generateSceneImages(sceneIndex, 4);
        gallery.appendChild(more);
        
    } catch (error) {
        console.error(`Scene ${sceneIndex + 1} image error:`, error);
        if (existing.length === 0) {
            gallery.innerHTML = `<div class="gallery-error">❌ ${error.message}<br><button class="btn btn-secondary btn-sm" onclick="generateSceneImages(${sceneIndex}, 4)" style="margin-top:0.5rem">Retry</button></div>`;
        }
    }
}

function selectImage(idx, url, el) {
    currentScenes[idx]._selectedImage = url;
    const gallery = document.getElementById(`gallery-${idx}`);
    gallery.querySelectorAll('.gallery-item').forEach(i => i.classList.remove('selected'));
    if (el) el.classList.add('selected');
    document.getElementById(`video-btn-${idx}`).disabled = false;
}

function triggerUpload(idx) { document.getElementById(`upload-input-${idx}`).click(); }

async function handleUpload(idx, input) {
    const file = input.files[0];
    if (!file) return;
    
    const gallery = document.getElementById(`gallery-${idx}`);
    const placeholder = document.createElement('div');
    placeholder.className = 'gallery-item';
    placeholder.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:0.75rem;color:var(--text-dim);text-align:center">⏳</div>';
    const regen = gallery.querySelector('.gallery-regen');
    if (regen) gallery.insertBefore(placeholder, regen); else gallery.appendChild(placeholder);
    
    try {
        const fd = new FormData();
        fd.append('image', file);
        const res = await fetch('/api/studio/upload-scene-image', { method: 'POST', headers: { 'Authorization': `Bearer ${getAuthToken()}` }, body: fd });
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Upload failed');
        
        placeholder.innerHTML = `<img src="${data.url}" alt="Custom" loading="lazy"><div class="gallery-check">✓</div><div class="custom-badge">📤</div>`;
        placeholder.onclick = () => selectImage(idx, data.url, placeholder);
        selectImage(idx, data.url, placeholder);
    } catch (err) {
        console.error('Upload error:', err);
        placeholder.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:0.7rem;color:var(--red)">❌</div>';
        setTimeout(() => placeholder.remove(), 2500);
    }
    
    if (input.tagName === 'INPUT') input.value = '';
}

async function generateSceneVideo(idx) {
    const scene = currentScenes[idx];
    const imageUrl = scene._selectedImage;
    if (!imageUrl) return alert('Select an image first');
    
    const ta = document.getElementById(`video-prompt-${idx}`);
    const videoPrompt = ta ? ta.value.trim() : scene.videoPrompt;
    
    const result = document.getElementById(`video-result-${idx}`);
    const btn = document.getElementById(`video-btn-${idx}`);
    btn.disabled = true; btn.textContent = '⏳ Generating...';
    result.innerHTML = '<div class="video-loading">🎥 Generating video (1-3 min)...</div>';
    
    try {
        const res = await fetch('/api/studio/generate/scene-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getAuthToken()}` },
            body: JSON.stringify({ format: 'skeleton-anatomy', imageUrl, videoPrompt, sceneNumber: scene.sceneNumber || idx + 1 })
        });
        if (!res.ok) throw new Error(`Server error ${res.status}: ${await res.text()}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        
        scene._videoUrl = data.videoUrl;
        result.innerHTML = `
            <video src="${data.videoUrl}" controls muted loop class="video-preview"></video>
            <div style="margin-top:0.5rem"><button class="btn btn-secondary btn-sm" onclick="generateSceneVideo(${idx})">↻ Regenerate</button></div>
        `;
        
        // Show download all button if any videos exist
        updateDirectorDownloadBtn();
        
    } catch (err) {
        console.error(`Scene ${idx + 1} video error:`, err);
        result.innerHTML = `<div class="video-error">❌ ${err.message}<br><button class="btn btn-secondary btn-sm" onclick="generateSceneVideo(${idx})" style="margin-top:0.35rem">Retry</button></div>`;
    } finally {
        btn.disabled = false; btn.textContent = '🎥 Generate Video';
    }
}

async function generateAllSelectedVideos() {
    const withImages = currentScenes.filter(s => s._selectedImage);
    if (withImages.length === 0) return alert('Select an image for at least one scene first');
    
    const cost = (withImages.length * 0.50).toFixed(2);
    if (!confirm(`Generate videos for ${withImages.length} scenes?\nEstimated cost: ~$${cost} (Kling 3 Omni Standard)`)) return;
    
    for (let i = 0; i < currentScenes.length; i++) {
        if (currentScenes[i]._selectedImage) generateSceneVideo(i);
    }
}

function updateDirectorDownloadBtn() {
    const btn = document.getElementById('director-download-btn');
    if (!btn) return;
    const hasVideos = currentScenes.some(s => s._videoUrl);
    btn.style.display = hasVideos ? 'inline-flex' : 'none';
}

async function downloadAllDirectorVideos() {
    const videos = currentScenes.filter(s => s._videoUrl);
    if (videos.length === 0) return alert('No videos generated yet');
    
    const btn = document.getElementById('director-download-btn');
    btn.disabled = true; btn.textContent = '⏳ Downloading...';
    
    for (let i = 0; i < videos.length; i++) {
        const scene = videos[i];
        try {
            await downloadFile(scene._videoUrl, `scene-${scene.sceneNumber || i + 1}.mp4`);
            if (i < videos.length - 1) await sleep(500);
        } catch (err) {
            console.error(`Download failed for scene ${scene.sceneNumber}:`, err);
        }
    }
    
    btn.disabled = false; btn.textContent = '📥 Download All Videos';
}

// ==================== AUTO MODE ====================

async function handleAutoGeneration(script, generateVideos) {
    generationInProgress = true;
    currentScenes = [];
    
    show('progress-section');
    hide('config-section', 'results-section', 'director-section');
    
    document.querySelectorAll('.progress-chip').forEach(c => { c.classList.remove('active', 'done', 'error'); });
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('scenes-container').innerHTML = '';
    
    try {
        const response = await fetch('/api/studio/generate/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getAuthToken()}` },
            body: JSON.stringify({ format: 'skeleton-anatomy', script, gradientColors: selectedGradient, generateVideos })
        });
        
        if (!response.ok) throw new Error('Failed to start generation');
        
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
                const m = line.match(/^event: (.+)\ndata: (.+)$/);
                if (!m) continue;
                handleStreamEvent(m[1], JSON.parse(m[2]), generateVideos);
            }
        }
    } catch (error) {
        console.error('Generation error:', error);
        updateMsg(`❌ Error: ${error.message}`);
        setTimeout(() => { if (confirm('Generation failed. Try again?')) resetToConfig(); }, 2000);
    } finally {
        generationInProgress = false;
    }
}

function handleStreamEvent(event, data, hasVideos) {
    switch (event) {
        case 'progress': handleProgress(data); break;
        case 'scene': handleSceneComplete(data, hasVideos); break;
        case 'complete': handleComplete(data); break;
        case 'error': updateMsg(`❌ ${data.error}`); break;
    }
}

function handleProgress(data) {
    const { step, status, message, completed, total } = data;
    setChip(step, status === 'completed' ? 'done' : 'active');
    
    // Update progress bar
    let pct = 0;
    if (step === 'claude') pct = status === 'completed' ? 25 : 10;
    else if (step === 'images') pct = status === 'completed' ? 60 : 25 + (completed && total ? (completed / total) * 35 : 0);
    else if (step === 'videos') pct = status === 'completed' ? 95 : 60 + (completed && total ? (completed / total) * 35 : 0);
    document.getElementById('progress-fill').style.width = pct + '%';
    
    updateMsg(message);
}

function handleSceneComplete(scene, hasVideos) {
    currentScenes.push(scene);
    show('results-section');
    const container = document.getElementById('scenes-container');
    const card = createAutoCard(scene, scene.sceneNumber, hasVideos);
    container.appendChild(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function handleComplete(data) {
    setChip('complete', 'done');
    document.getElementById('progress-fill').style.width = '100%';
    updateMsg('🎉 Generation complete!');
    currentScenes = data.scenes || currentScenes;
    generationInProgress = false;
    
    // Setup download all
    const dlBtn = document.getElementById('download-all-btn');
    if (dlBtn) {
        dlBtn.onclick = async () => {
            const videos = currentScenes.filter(s => s.videoUrl);
            if (videos.length === 0) return alert('No videos to download');
            dlBtn.disabled = true; dlBtn.textContent = '⏳ Downloading...';
            for (let i = 0; i < videos.length; i++) {
                try {
                    await downloadFile(videos[i].videoUrl, `scene-${videos[i].sceneNumber || i + 1}.mp4`);
                    if (i < videos.length - 1) await sleep(500);
                } catch (e) { console.error('Download error:', e); }
            }
            dlBtn.disabled = false; dlBtn.textContent = '📥 Download All Videos';
        };
    }
}

function createAutoCard(scene, num, hasVideos) {
    const card = document.createElement('div');
    card.className = 'auto-scene';
    const status = scene.videoUrl || !hasVideos ? 'ok' : 'pending';
    card.innerHTML = `
        <div class="scene-head">
            <span class="scene-num">Scene ${num}</span>
            <span class="badge badge-${status}">${status === 'ok' ? 'Complete' : 'Pending'}</span>
        </div>
        <p class="scene-script">"${esc(scene.scriptLine || scene.narration || '')}"</p>
        <div class="prompt-toggle" onclick="togglePrompt(this)"><span class="arrow">▶</span> Image Prompt</div>
        <div class="prompt-body"><p>${esc(scene.imagePrompt)}</p></div>
        <div class="prompt-toggle" onclick="togglePrompt(this)"><span class="arrow">▶</span> Video Prompt</div>
        <div class="prompt-body"><p>${esc(scene.videoPrompt || '')}</p></div>
        <div class="scene-media">
            <div class="media-box">${scene.imageUrl ? `<img src="${scene.imageUrl}" alt="Scene ${num}" loading="lazy">` : '<div class="media-placeholder">Loading...</div>'}</div>
            <div class="media-box">${scene.videoUrl ? `<video src="${scene.videoUrl}" controls muted loop></video>` : hasVideos ? '<div class="media-placeholder">Video generating...</div>' : '<div class="media-placeholder">Image only</div>'}</div>
        </div>
    `;
    return card;
}

// ==================== UTILITIES ====================

function setChip(step, state) {
    const el = document.querySelector(`.progress-chip[data-step="${step}"]`);
    if (!el) return;
    el.classList.remove('active', 'done', 'error');
    if (state) el.classList.add(state);
}

function updateMsg(msg) {
    const el = document.getElementById('progress-message');
    if (el) el.textContent = msg;
}

function show(...ids) { ids.forEach(id => document.getElementById(id)?.classList.remove('hidden')); }
function hide(...ids) { ids.forEach(id => document.getElementById(id)?.classList.add('hidden')); }

function resetToConfig() {
    show('config-section');
    hide('progress-section', 'results-section', 'director-section');
    currentScenes = [];
    generationInProgress = false;
}

function esc(text) {
    const d = document.createElement('div');
    d.textContent = text || '';
    return d.innerHTML;
}

function getAuthToken() {
    return localStorage.getItem('viewhunt_token') || localStorage.getItem('token') ||
        (document.cookie.split(';').find(c => c.trim().startsWith('token=')) || '').split('=')[1] || null;
}

function checkAuth() {
    if (!getAuthToken()) console.warn('No auth token — log in at /app first');
}

async function downloadFile(url, filename) {
    const res = await fetch(url);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
