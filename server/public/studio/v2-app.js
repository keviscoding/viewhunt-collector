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
            <button class="btn btn-primary" onclick="assembleVideo()" id="director-assemble-btn" style="display:none">🎬 Assemble Final Video</button>
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
                // Don't create individual error cards — just skip failed variants
                return;
            } else {
                w.innerHTML = `<img src="${img.url}" alt="Variant" loading="lazy"><div class="gallery-check">✓</div>`;
                w.onclick = () => selectImage(sceneIndex, img.url, w);
                if (!scene._selectedImage) selectImage(sceneIndex, img.url, w);
            }
            gallery.appendChild(w);
        });
        
        // If ALL images failed, show one single error message
        var successCount = data.images.filter(function(img) { return !img.error; }).length;
        if (successCount === 0) {
            var errEl = document.createElement('div');
            errEl.className = 'gallery-error';
            errEl.innerHTML = 'Generation failed · <a href="#" onclick="event.preventDefault();generateSceneImages(' + sceneIndex + ', 4)" style="color:var(--accent);text-decoration:underline">Retry</a>';
            gallery.appendChild(errEl);
        }
        
        const more = document.createElement('div');
        more.className = 'gallery-item gallery-regen';
        more.innerHTML = '↻<br><small>More</small>';
        more.onclick = () => generateSceneImages(sceneIndex, 4);
        gallery.appendChild(more);
        
    } catch (error) {
        console.error(`Scene ${sceneIndex + 1} image error:`, error);
        if (existing.length === 0) {
            gallery.innerHTML = '<div class="gallery-error">Generation failed · <a href="#" onclick="event.preventDefault();generateSceneImages(' + sceneIndex + ', 4)" style="color:var(--accent);text-decoration:underline">Retry</a></div>';
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
        result.innerHTML = '<div class="video-error">Failed · <a href="#" onclick="event.preventDefault();generateSceneVideo(' + idx + ')" style="color:var(--accent);text-decoration:underline">Retry</a></div>';
    } finally {
        btn.disabled = false; btn.textContent = '🎥 Generate Video';
    }
}

async function generateAllSelectedVideos() {
    const withImages = currentScenes.filter(s => s._selectedImage);
    if (withImages.length === 0) return alert('Select an image for at least one scene first');
    
    const cost = (withImages.length * 0.35).toFixed(2);
    if (!confirm(`Generate videos for ${withImages.length} scenes?\nEstimated cost: ~$${cost} (Kie.ai Kling 2.6)`)) return;
    
    for (let i = 0; i < currentScenes.length; i++) {
        if (currentScenes[i]._selectedImage) generateSceneVideo(i);
    }
}

function updateDirectorDownloadBtn() {
    const btn = document.getElementById('director-download-btn');
    const assembleBtn = document.getElementById('director-assemble-btn');
    if (!btn) return;
    const hasVideos = currentScenes.some(s => s._videoUrl);
    btn.style.display = hasVideos ? 'inline-flex' : 'none';
    if (assembleBtn) assembleBtn.style.display = hasVideos ? 'inline-flex' : 'none';
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


// ==================== VIDEO ASSEMBLY ====================

async function submitAssemblyJob(scenesWithVideo, videoUrlKey) {
    var script = document.getElementById('script').value.trim();
    if (!script) { alert('Script is required'); return null; }
    var payload = scenesWithVideo.map(function(s) {
        return {
            sceneNumber: s.sceneNumber, scriptLine: s.scriptLine,
            shotType: s.shotType, imagePrompt: s.imagePrompt,
            videoPrompt: s.videoPrompt, videoUrl: s[videoUrlKey]
        };
    });
    var res = await fetch('/api/studio/assemble', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() },
        body: JSON.stringify({ script: script, scenes: payload })
    });
    if (!res.ok) {
        var err = await res.json().catch(function() { return {}; });
        throw new Error(err.error || 'Server error ' + res.status);
    }
    var data = await res.json();
    return data.jobId;
}

async function pollAssemblyJob(jobId, resultDiv) {
    var msgs = {
        queued: '⏳ Waiting in queue...',
        generating_voiceover: '🎙️ Generating voiceover...',
        analyzing_edit_points: '🧠 Analyzing edit points...',
        assembling_video: '🎬 Assembling video (1-3 min)...'
    };
    var failCount = 0;
    while (true) {
        await sleep(3000);
        try {
            var res = await fetch('/api/studio/assemble/status/' + jobId, {
                headers: { 'Authorization': 'Bearer ' + getAuthToken() }
            });
            if (!res.ok) {
                failCount++;
                if (failCount >= 10) throw new Error('Lost connection to server');
                resultDiv.innerHTML = '<div class="assembly-progress">⏳ Reconnecting... (' + failCount + '/10)</div>';
                continue;
            }
            failCount = 0;
            var d = await res.json();
            if (d.status === 'complete' && d.result) return d.result;
            if (d.status === 'failed') throw new Error(d.error || 'Assembly failed');
            var msg = msgs[d.status] || d.message || 'Processing...';
            if (d.position > 1) msg = 'Position ' + d.position + ' in queue. ' + msg;
            resultDiv.innerHTML = '<div class="assembly-progress">' + msg + '</div>';
        } catch (err) {
            if (err.message === 'Lost connection to server' || err.message.includes('Assembly failed')) throw err;
            failCount++;
            if (failCount >= 10) throw new Error('Lost connection to server');
            resultDiv.innerHTML = '<div class="assembly-progress">⏳ Reconnecting... (' + failCount + '/10)</div>';
        }
    }
}

function renderAssemblyResult(container, result, retryFnName) {
    var dur = (result && result.duration) ? result.duration.toFixed(1) : '?';
    var hooks = (result && result.hookClips != null) ? result.hookClips : '?';
    var segs = (result && result.bodySegments != null) ? result.bodySegments : '?';
    var url = (result && result.videoUrl) ? result.videoUrl : '';
    container.innerHTML = '<div class="assembly-progress">' +
        '<div style="margin-bottom:1rem">✅ Final video (' + dur + 's) — ' +
        hooks + ' hook clips, ' + segs + ' body segments</div>' +
        '<video src="' + url + '" controls autoplay muted loop ' +
        'style="width:100%;max-width:360px;border-radius:12px;margin-bottom:0.75rem"></video>' +
        '<div><button class="btn btn-green btn-sm" onclick="downloadFile(\'' +
        url + '\', \'final-video.mp4\')">📥 Download</button> ' +
        '<button class="btn btn-secondary btn-sm" onclick="' + retryFnName +
        '()">↻ Re-assemble</button></div></div>';
}

async function assembleAutoVideo() {
    var scenes = currentScenes.filter(function(s) { return s.videoUrl; });
    if (scenes.length === 0) return alert('No videos generated yet');
    if (!confirm('Assemble final video from ' + scenes.length + ' scenes?\nEstimated time: 2-4 minutes.')) return;
    var btn = document.getElementById('auto-assemble-btn');
    btn.disabled = true; btn.textContent = '⏳ Submitting...';
    var rd = document.getElementById('auto-assembly-result');
    rd.innerHTML = '<div class="assembly-progress">🎬 Submitting job...</div>';
    try {
        var jobId = await submitAssemblyJob(scenes, 'videoUrl');
        if (!jobId) return;
        btn.textContent = '⏳ Processing...';
        var result = await pollAssemblyJob(jobId, rd);
        renderAssemblyResult(rd, result, 'assembleAutoVideo');
    } catch (err) {
        console.error('Assembly error:', err);
        rd.innerHTML = '<div class="assembly-progress" style="color:var(--red)">❌ ' + err.message + '</div>';
    } finally {
        btn.disabled = false; btn.textContent = '🎬 Assemble Final Video';
    }
}

async function assembleVideo() {
    var scenes = currentScenes.filter(function(s) { return s._videoUrl; });
    if (scenes.length === 0) return alert('Generate videos first');
    if (!confirm('Assemble final video from ' + scenes.length + ' scenes?\nEstimated time: 2-4 minutes.')) return;
    var btn = document.getElementById('director-assemble-btn');
    btn.disabled = true; btn.textContent = '⏳ Submitting...';
    var old = document.getElementById('assembly-progress');
    if (old) old.remove();
    var bar = document.getElementById('director-action-bar');
    var rd = document.createElement('div');
    rd.id = 'assembly-progress'; rd.className = 'assembly-progress';
    rd.innerHTML = '🎬 Submitting job...';
    bar.parentNode.insertBefore(rd, bar.nextSibling);
    try {
        var jobId = await submitAssemblyJob(scenes, '_videoUrl');
        if (!jobId) return;
        btn.textContent = '⏳ Processing...';
        var result = await pollAssemblyJob(jobId, rd);
        renderAssemblyResult(rd, result, 'assembleVideo');
    } catch (err) {
        console.error('Assembly error:', err);
        rd.innerHTML = '<div style="color:var(--red)">❌ ' + err.message + '</div>';
    } finally {
        btn.disabled = false; btn.textContent = '🎬 Assemble Final Video';
    }
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
    
    // Show assemble button if we have videos
    const hasVideos = currentScenes.some(s => s.videoUrl);
    const assembleBtn = document.getElementById('auto-assemble-btn');
    if (assembleBtn && hasVideos) assembleBtn.style.display = 'inline-flex';
    
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

// ==================== SFX MANAGEMENT ====================

var sfxAudioEl = null;

function toggleSfxPanel() {
    var toggle = document.getElementById('sfx-toggle');
    var body = document.getElementById('sfx-body');
    toggle.classList.toggle('open');
    body.classList.toggle('open');
    if (body.classList.contains('open')) loadSfxStatus();
}

function loadSfxStatus() {
    fetch('/api/studio/sfx', {
        headers: { 'Authorization': 'Bearer ' + getAuthToken() }
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
        var files = data.sfx || [];
        var types = ['hook', 'transition', 'riser', 'bgmusic'];
        for (var i = 0; i < types.length; i++) {
            var t = types[i];
            var found = files.find(function(f) { return f.startsWith(t + '.'); });
            var statusEl = document.getElementById('sfx-status-' + t);
            var playBtn = document.getElementById('sfx-play-' + t);
            if (found) {
                statusEl.textContent = '✓ ' + found;
                statusEl.className = 'sfx-status uploaded';
                playBtn.disabled = false;
            } else {
                statusEl.textContent = 'Not uploaded';
                statusEl.className = 'sfx-status';
                playBtn.disabled = true;
            }
        }
    })
    .catch(function(err) { console.warn('SFX status load failed:', err); });
}

async function uploadSfx(type, input) {
    var file = input.files[0];
    if (!file) return;

    var ext = file.name.split('.').pop();
    var renamedFile = new File([file], type + '.' + ext, { type: file.type });

    var statusEl = document.getElementById('sfx-status-' + type);
    statusEl.textContent = '⏳ Uploading...';
    statusEl.className = 'sfx-status';

    try {
        var fd = new FormData();
        fd.append('sfx', renamedFile);
        var res = await fetch('/api/studio/upload-sfx', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + getAuthToken() },
            body: fd
        });
        if (!res.ok) throw new Error('Upload failed: ' + res.status);
        var data = await res.json();
        if (!data.success) throw new Error(data.error || 'Upload failed');

        statusEl.textContent = '✓ ' + data.filename;
        statusEl.className = 'sfx-status uploaded';
        document.getElementById('sfx-play-' + type).disabled = false;
    } catch (err) {
        console.error('SFX upload error:', err);
        statusEl.textContent = 'Upload failed';
        statusEl.className = 'sfx-status';
    }

    input.value = '';
}

function playSfx(type) {
    if (sfxAudioEl) { sfxAudioEl.pause(); sfxAudioEl = null; }
    var statusEl = document.getElementById('sfx-status-' + type);
    var filename = (statusEl.textContent || '').replace('✓ ', '').trim();
    if (!filename) return;

    sfxAudioEl = new Audio('/api/studio/sfx/' + filename);
    var btn = document.getElementById('sfx-play-' + type);
    btn.textContent = '⏸';
    sfxAudioEl.play();
    sfxAudioEl.onended = function() { btn.textContent = '▶'; sfxAudioEl = null; };
    sfxAudioEl.onerror = function() { btn.textContent = '▶'; sfxAudioEl = null; };
}
