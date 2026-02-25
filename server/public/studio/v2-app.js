// V2 Studio App — Skeleton Video Generator

let selectedGradient = 'smooth blue to teal gradient background';
let generationInProgress = false;
let currentScenes = [];
let directorMode = false;
let isAdmin = false;
let videoModel = 'wan';

document.addEventListener('DOMContentLoaded', () => {
    initGradients();
    initModeToggle();
    initGenerateButton();
    checkAuth();
    loadCreditBalance();
});

// ==================== INIT ====================

// Helper: check for credit errors (402) in API responses — shows graceful inline banner
async function handleCreditError(res) {
    if (res.status === 402) {
        var data = await res.json();
        showCreditBanner(data.cost || 0, data.totalAvailable || 0);
        loadCreditBalance();
        throw new Error('__credit_error__');
    }
}

// Show a graceful credit shortage banner instead of ugly alert
function showCreditBanner(needed, have) {
    // Remove any existing banner
    var old = document.getElementById('credit-banner');
    if (old) old.remove();

    var banner = document.createElement('div');
    banner.id = 'credit-banner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:1000;padding:1rem 1.25rem;background:linear-gradient(135deg,#1a1025,#2d1a3e);border-bottom:1px solid rgba(124,106,239,0.3);display:flex;align-items:center;justify-content:center;gap:1rem;flex-wrap:wrap;animation:slideDown 0.3s ease';
    banner.innerHTML =
        '<div style="display:flex;align-items:center;gap:0.5rem">' +
            '<span style="font-size:1.2rem">💎</span>' +
            '<span style="font-size:0.9rem;color:#e8e8ed">You need <b style="color:#7c6aef">' + needed + '</b> credits but have <b style="color:#f87171">' + have + '</b></span>' +
        '</div>' +
        '<div style="display:flex;gap:0.5rem">' +
            '<button onclick="showCreditDetails();document.getElementById(\'credit-banner\').remove()" style="padding:0.4rem 0.8rem;border-radius:6px;border:none;background:#7c6aef;color:white;font-weight:600;font-size:0.82rem;cursor:pointer;font-family:inherit">Buy Credits</button>' +
            '<button onclick="this.parentNode.parentNode.remove()" style="padding:0.4rem 0.6rem;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#8b8b9e;font-size:0.82rem;cursor:pointer;font-family:inherit">Dismiss</button>' +
        '</div>';
    document.body.prepend(banner);

    // Auto-dismiss after 8 seconds
    setTimeout(function() { var b = document.getElementById('credit-banner'); if (b) b.remove(); }, 8000);
}

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
        
        updateGenerateButtonCost();
    };
    
    track.addEventListener('click', toggle);
    track.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
}

function updateGenerateButtonCost() {
    var btn = document.querySelector('#generate-btn .btn-text');
    if (!btn) return;
    if (directorMode) {
        // Director: script (5) + images (~12 scenes × 0.5) = ~11 credits
        btn.textContent = 'Generate Scenes + Images · ~11 💎';
    } else {
        var withVideos = document.getElementById('generateVideos')?.checked;
        if (withVideos) {
            // Auto with videos: script (5) + images (12×0.5) + videos (12×5) + assembly (2) = ~73
            btn.textContent = 'Generate Video · ~73 💎';
        } else {
            // Auto images only: script (5) + images (12×0.5) = ~11
            btn.textContent = 'Generate Images Only · ~11 💎';
        }
    }
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
    
    // Update cost when video checkbox changes
    var videosCb = document.getElementById('generateVideos');
    if (videosCb) videosCb.addEventListener('change', updateGenerateButtonCost);
    
    // Set initial button cost
    updateGenerateButtonCost();
    
    // Word count tracker
    var scriptEl = document.getElementById('script');
    var wcHint = document.getElementById('word-count-hint');
    if (scriptEl && wcHint) {
        scriptEl.addEventListener('input', function() {
            var words = scriptEl.value.trim().split(/\s+/).filter(function(w) { return w.length > 0; }).length;
            var color = (words >= 150 && words <= 220) ? '#22c55e' : (words > 220 ? '#f59e0b' : 'var(--text-muted)');
            wcHint.style.color = color;
            wcHint.textContent = words + ' word' + (words !== 1 ? 's' : '') + (words >= 150 && words <= 220 ? ' ✓' : '');
        });
    }
}

// ==================== DIRECTOR MODE ====================

async function handleDirectorGeneration(script) {
    generationInProgress = true;
    currentScenes = [];
    
    show('director-section', 'generation-warning');
    hide('config-section', 'results-section', 'progress-section');
    
    const container = document.getElementById('director-scenes');
    container.innerHTML = '<div class="director-loading">🤖 Analyzing your script and reference frames...</div>';
    
    try {
        const res = await fetch('/api/studio/generate/scenes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getAuthToken()}` },
            body: JSON.stringify({ format: 'skeleton-anatomy', script, gradientColors: selectedGradient })
        });
        
        await handleCreditError(res);
        if (!res.ok) throw new Error(`Server error ${res.status}: ${await res.text()}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed to generate scenes');
        
        currentScenes = data.scenes;
        container.innerHTML = '';
        
        currentScenes.forEach((scene, i) => container.appendChild(createDirectorCard(scene, i)));
        
        // Refresh credit balance after scene generation
        loadCreditBalance();
        
        // Action bar with download all + generate all
        const bar = document.createElement('div');
        bar.className = 'action-bar';
        bar.id = 'director-action-bar';
        bar.innerHTML = `
            <button class="btn btn-green" onclick="generateAllSelectedVideos()">🎥 Generate All Videos</button>
            <button class="btn btn-primary" onclick="assembleVideo()" id="director-assemble-btn" style="display:none">🎬 Assemble · 2 💎</button>
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
        hide('generation-warning');
        if (error.message !== '__credit_error__') {
            container.innerHTML = `<div class="director-error">❌ ${error.message}<br><button class="btn btn-secondary btn-sm" onclick="resetToConfig()" style="margin-top:1rem">Try Again</button></div>`;
        } else {
            container.innerHTML = '<div class="director-error"><button class="btn btn-secondary btn-sm" onclick="resetToConfig()" style="margin-top:1rem">← Back</button></div>';
        }
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
            <button class="btn btn-secondary btn-sm" onclick="generateSceneImages(${index}, 4)">↻ More Images · 2 💎</button>
            <button class="btn-upload" id="upload-btn-${index}" onclick="triggerUpload(${index})" title="Upload your own image">+ Upload</button>
            <button class="btn btn-green btn-sm" onclick="generateSceneVideo(${index})" id="video-btn-${index}" disabled>🎥 Generate Video · 5 💎</button>
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
        
        await handleCreditError(res);
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
        
        // Refresh credit balance
        loadCreditBalance();
        
        // If ALL images failed, show error with retry
        var successCount = data.images.filter(function(img) { return !img.error; }).length;
        if (successCount === 0) {
            var errEl = document.createElement('div');
            errEl.className = 'gallery-error';
            errEl.innerHTML = 'Image generation failed. <a href="#" onclick="event.preventDefault();generateSceneImages(' + sceneIndex + ', 4)" style="color:var(--accent);text-decoration:underline">Retry</a>';
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
            gallery.innerHTML = '<div class="gallery-error">Image generation failed. <a href="#" onclick="event.preventDefault();generateSceneImages(' + sceneIndex + ', 4)" style="color:var(--accent);text-decoration:underline">Retry</a></div>';
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
            body: JSON.stringify({ format: 'skeleton-anatomy', imageUrl, videoPrompt, sceneNumber: scene.sceneNumber || idx + 1, videoModel })
        });
        await handleCreditError(res);
        if (!res.ok) throw new Error(`Server error ${res.status}: ${await res.text()}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        
        scene._videoUrl = data.videoUrl;
        result.innerHTML = `
            <video src="${data.videoUrl}" controls muted loop class="video-preview"></video>
            <div style="margin-top:0.5rem"><button class="btn btn-secondary btn-sm" onclick="generateSceneVideo(${idx})">↻ Regenerate</button></div>
        `;
        
        // Refresh credit balance
        loadCreditBalance();
        
        // Show download all button if any videos exist
        updateDirectorDownloadBtn();
        
    } catch (err) {
        console.error(`Scene ${idx + 1} video error:`, err);
        result.innerHTML = '<div class="video-error">Video generation failed. <a href="#" onclick="event.preventDefault();generateSceneVideo(' + idx + ')" style="color:var(--accent);text-decoration:underline">Retry</a></div>';
    } finally {
        btn.disabled = false; btn.textContent = '🎥 Generate Video';
    }
}

async function generateAllSelectedVideos() {
    const withImages = currentScenes.filter(s => s._selectedImage);
    if (withImages.length === 0) return alert('Select an image for at least one scene first');
    
    var vidCost = withImages.length * 5;
    if (!confirm('Generate videos for ' + withImages.length + ' scenes?\nThis will use ~' + vidCost + ' credits.')) return;
    
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
        queued: '⏳ Waiting in queue... Please keep this tab open.',
        generating_voiceover: '🎙️ Generating voiceover... Keep this tab open.',
        analyzing_edit_points: '🧠 Analyzing edit points... Almost there, stay on this tab.',
        assembling_video: '🎬 Assembling video (1-3 min)... Don\'t close this tab.'
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

    // Refresh credit balance after assembly
    loadCreditBalance();

    // Add a cache-bust param so the browser doesn't serve a stale/partial response
    var bustUrl = url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();

    container.innerHTML = '<div class="assembly-progress">' +
        '<div style="margin-bottom:1rem">✅ Final video (' + dur + 's) — ' +
        hooks + ' hook clips, ' + segs + ' body segments</div>' +
        '<video id="assembly-video" src="' + bustUrl + '" controls autoplay muted loop ' +
        'style="width:100%;max-width:360px;border-radius:12px;margin-bottom:0.75rem"></video>' +
        '<div><button class="btn btn-green btn-sm" onclick="downloadFinalVideo(\'' +
        url + '\', \'final-video.mp4\')">📥 Download</button> ' +
        '<button class="btn btn-secondary btn-sm" onclick="' + retryFnName +
        '()">↻ Re-assemble</button></div></div>';

    // Retry loading the video if it fails (file may not be ready yet)
    var vid = document.getElementById('assembly-video');
    if (vid) {
        var retryCount = 0;
        vid.onerror = function() {
            retryCount++;
            if (retryCount <= 5) {
                console.log('Video load failed, retrying in 2s... (' + retryCount + '/5)');
                setTimeout(function() {
                    vid.src = url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
                    vid.load();
                }, 2000);
            }
        };
    }
}

async function assembleAutoVideo() {
    var scenes = currentScenes.filter(function(s) { return s.videoUrl; });
    if (scenes.length === 0) return alert('No videos generated yet');
    
    // Warn about missing scenes
    var missing = currentScenes.filter(function(s) { return !s.videoUrl; });
    var confirmMsg = 'Assemble final video from ' + scenes.length + ' scenes?\nEstimated time: 2-4 minutes.';
    if (missing.length > 0) {
        var missingNums = missing.map(function(s) { return 'Scene ' + (s.sceneNumber || '?'); }).join(', ');
        confirmMsg = '⚠️ ' + missing.length + ' scene(s) have no video: ' + missingNums + '\n\nAssemble with ' + scenes.length + ' available scenes?\nEstimated time: 2-4 minutes.';
    }
    if (!confirm(confirmMsg)) return;
    var btn = document.getElementById('auto-assemble-btn');
    btn.disabled = true; btn.textContent = '⏳ Submitting...';
    show('generation-warning');
    var rd = document.getElementById('auto-assembly-result');
    rd.innerHTML = '<div class="assembly-progress">🎬 Submitting job...</div>';
    rd.scrollIntoView({ behavior: 'smooth', block: 'end' });
    try {
        var jobId = await submitAssemblyJob(scenes, 'videoUrl');
        if (!jobId) return;
        btn.textContent = '⏳ Processing...';
        var result = await pollAssemblyJob(jobId, rd);
        renderAssemblyResult(rd, result, 'assembleAutoVideo');
    } catch (err) {
        console.error('Assembly error:', err);
        rd.innerHTML = '<div class="assembly-progress" style="color:var(--red)">❌ ' + err.message + '<br><span style="color:#22c55e">🛡️ Credits refunded.</span> Please retry.</div>';
    } finally {
        btn.disabled = false; btn.textContent = '🎬 Assemble Final Video';
        hide('generation-warning');
    }
}

async function assembleVideo() {
    var scenes = currentScenes.filter(function(s) { return s._videoUrl; });
    if (scenes.length === 0) return alert('Generate videos first');
    
    // Warn about missing scenes
    var missing = currentScenes.filter(function(s) { return !s._videoUrl; });
    var confirmMsg = 'Assemble final video from ' + scenes.length + ' scenes?\nEstimated time: 2-4 minutes.';
    if (missing.length > 0) {
        var missingNums = missing.map(function(s) { return 'Scene ' + (s.sceneNumber || '?'); }).join(', ');
        confirmMsg = '⚠️ ' + missing.length + ' scene(s) have no video: ' + missingNums + '\n\nAssemble with ' + scenes.length + ' available scenes?\nEstimated time: 2-4 minutes.';
    }
    if (!confirm(confirmMsg)) return;
    var btn = document.getElementById('director-assemble-btn');
    btn.disabled = true; btn.textContent = '⏳ Submitting...';
    show('generation-warning');
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
        rd.innerHTML = '<div style="color:var(--red)">❌ ' + err.message + '<br><span style="color:#22c55e">🛡️ Credits refunded.</span> Please retry.</div>';
    } finally {
        btn.disabled = false; btn.textContent = '🎬 Assemble Final Video';
        hide('generation-warning');
    }
}

// ==================== AUTO MODE ====================

async function handleAutoGeneration(script, generateVideos) {
    generationInProgress = true;
    currentScenes = [];
    
    show('progress-section', 'generation-warning');
    hide('config-section', 'results-section', 'director-section');
    
    document.querySelectorAll('.progress-chip').forEach(c => { c.classList.remove('active', 'done', 'error'); });
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('scenes-container').innerHTML = '';
    
    try {
        // Create a background task instead of SSE streaming
        const createRes = await fetch('/api/studio/tasks/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getAuthToken()}` },
            body: JSON.stringify({ format: 'skeleton-anatomy', script, gradientColors: selectedGradient, generateVideos, videoModel })
        });
        
        if (createRes.status === 402) {
            await handleCreditError(createRes);
            return;
        }
        if (createRes.status === 429) {
            var limitData = await createRes.json();
            alert(limitData.error || 'Too many concurrent tasks. Please wait for a task to finish.');
            resetToConfig();
            return;
        }
        if (!createRes.ok) {
            var errData = await createRes.json();
            throw new Error(errData.error || 'Failed to start generation');
        }
        
        var taskData = await createRes.json();
        var taskId = taskData.taskId;
        console.log('Background task created:', taskId);
        
        // Update the warning banner to show they can close the tab
        var warningDiv = document.getElementById('generation-warning');
        if (warningDiv) {
            warningDiv.innerHTML = '<div style="font-size:1.5rem;flex-shrink:0;">✅</div>' +
                '<div>' +
                    '<div style="color:#34d399;font-weight:700;font-size:0.9rem;margin-bottom:0.25rem;">Running in the background</div>' +
                    '<div style="color:#d1d5db;font-size:0.8rem;line-height:1.4;">You can close this tab. Your video will keep generating. Check progress in <a href="/studio" style="color:#7c6aef;text-decoration:underline;">My Tasks</a>.</div>' +
                '</div>';
        }
        
        // Poll the task for progress
        await pollTaskProgress(taskId, generateVideos);
        
    } catch (error) {
        if (error.message === '__credit_error__') { resetToConfig(); return; }
        console.error('Generation error:', error);
        updateMsg('❌ Error: ' + error.message);
        hide('generation-warning');
        setTimeout(function() { if (confirm('Generation failed. Try again?')) resetToConfig(); }, 2000);
    } finally {
        generationInProgress = false;
    }
}

// Poll a background task and update the UI as if it were streaming
async function pollTaskProgress(taskId, hasVideos) {
    var lastStep = '';
    var scenesRendered = new Set();
    
    while (true) {
        await sleep(3000);
        
        try {
            var res = await fetch('/api/studio/tasks/' + taskId, {
                headers: { 'Authorization': 'Bearer ' + getAuthToken() }
            });
            if (!res.ok) break;
            var data = await res.json();
            if (!data.task) break;
            
            var task = data.task;
            var p = task.progress || {};
            
            // Update progress chips
            if (p.step === 'claude') {
                setChip('claude', p.step === 'claude' ? 'active' : 'done');
            }
            if (p.step === 'images' || p.step === 'videos' || p.step === 'complete') {
                setChip('claude', 'done');
            }
            if (p.step === 'images') {
                setChip('images', 'active');
            }
            if (p.step === 'videos' || p.step === 'complete') {
                setChip('images', 'done');
            }
            if (p.step === 'videos') {
                setChip('videos', 'active');
            }
            if (p.step === 'complete') {
                setChip('videos', 'done');
                setChip('complete', 'done');
            }
            
            // Update progress bar
            var pct = 0;
            if (p.totalScenes > 0) {
                if (p.step === 'complete') pct = 100;
                else if (p.step === 'videos') pct = 60 + (p.videosCompleted / p.totalScenes) * 35;
                else if (p.step === 'images') pct = 25 + (p.imagesCompleted / p.totalScenes) * 35;
                else if (p.step === 'claude') pct = 10;
            }
            document.getElementById('progress-fill').style.width = pct + '%';
            updateMsg(p.message || 'Processing...');
            
            // Render completed scenes
            var scenes = task.scenes || [];
            scenes.forEach(function(s, i) {
                if (scenesRendered.has(i)) return;
                if (!s.imageUrl && !s.videoUrl) return;
                
                scenesRendered.add(i);
                show('results-section');
                var container = document.getElementById('scenes-container');
                var sceneData = {
                    sceneNumber: i + 1,
                    imageUrl: s.imageUrl,
                    videoUrl: s.videoUrl,
                    imagePrompt: s.imagePrompt || '',
                    videoPrompt: s.videoPrompt || '',
                    scriptLine: s.scriptLine || ''
                };
                currentScenes[i] = sceneData;
                var card = createAutoCard(sceneData, i + 1, hasVideos);
                container.appendChild(card);
            });
            
            // Update existing scene cards if video arrived after image
            scenes.forEach(function(s, i) {
                if (s.videoUrl && scenesRendered.has(i)) {
                    currentScenes[i] = {
                        sceneNumber: i + 1,
                        imageUrl: s.imageUrl,
                        videoUrl: s.videoUrl,
                        imagePrompt: s.imagePrompt || '',
                        videoPrompt: s.videoPrompt || '',
                        scriptLine: s.scriptLine || ''
                    };
                }
            });
            
            // Check if done
            if (task.status === 'completed' || task.status === 'partial') {
                // Rebuild currentScenes from task data
                currentScenes = scenes.map(function(s, i) {
                    return {
                        sceneNumber: i + 1,
                        imageUrl: s.imageUrl,
                        videoUrl: s.videoUrl,
                        imagePrompt: s.imagePrompt || '',
                        videoPrompt: s.videoPrompt || '',
                        scriptLine: s.scriptLine || ''
                    };
                });
                handleComplete({ scenes: currentScenes });
                break;
            }
            
            if (task.status === 'failed') {
                updateMsg('❌ ' + (task.error || 'Generation failed'));
                hide('generation-warning');
                break;
            }
            
            if (task.status === 'cancelled') {
                updateMsg('🚫 Task was cancelled');
                hide('generation-warning');
                break;
            }
            
        } catch (e) {
            console.warn('Poll error:', e);
            // Keep polling on network errors
        }
    }
    
    loadCreditBalance();
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
    loadCreditBalance();
}

function handleComplete(data) {
    setChip('complete', 'done');
    document.getElementById('progress-fill').style.width = '100%';
    updateMsg('🎉 Generation complete!');
    hide('generation-warning');
    currentScenes = data.scenes || currentScenes;
    generationInProgress = false;
    
    // Show assemble button if we have videos
    const hasVideos = currentScenes.some(s => s.videoUrl);
    const assembleBtn = document.getElementById('auto-assemble-btn');
    if (assembleBtn && hasVideos) assembleBtn.style.display = 'inline-flex';
    
    // Show "edit your video" prompt
    if (hasVideos) {
        var prompt = document.createElement('div');
        prompt.id = 'edit-prompt-banner';
        prompt.style.cssText = 'background:linear-gradient(135deg,#1a1a2e,#16213e);border:1px solid var(--accent);border-radius:12px;padding:1.5rem;text-align:center;margin:1.25rem 0;animation:fadeIn 0.3s ease';
        prompt.innerHTML = '<div style="font-size:1.5rem;margin-bottom:0.5rem">✅</div>' +
            '<div style="font-size:1.05rem;font-weight:700;margin-bottom:0.35rem">Finished generating</div>' +
            '<div style="color:var(--text-muted);font-size:0.85rem;margin-bottom:1rem">Your scenes are ready. Click below to assemble your final video with voiceover, captions, and effects.</div>' +
            '<button class="btn btn-primary" onclick="this.parentElement.remove();assembleAutoVideo();">🎬 Assemble Final Video · 2 💎</button>' +
            '<div style="font-size:0.75rem;color:var(--text-dim);margin-top:0.5rem">Or scroll down to review individual scenes first</div>';
        var resultsSection = document.getElementById('results-section');
        if (resultsSection) resultsSection.insertBefore(prompt, resultsSection.firstChild);
        
        // Auto-scroll to the top so user sees the "Edit Your Video" banner
        setTimeout(function() {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }, 400);
    }
    
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
    hide('progress-section', 'results-section', 'director-section', 'generation-warning');
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
    if (!getAuthToken()) {
        window.location.href = '/app';
        return;
    }
    // Check if admin — show model toggle if so
    fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + getAuthToken() } })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
            if (d && d.subscription && d.subscription.type === 'admin') {
                isAdmin = true;
                showAdminModelToggle();
            }
        })
        .catch(() => {});
}

function showAdminModelToggle() {
    var container = document.getElementById('admin-model-toggle');
    if (!container) return;
    container.style.display = 'block';
    container.innerHTML = '<div style="display:flex;align-items:center;gap:0.75rem;padding:0.75rem 1rem;background:var(--surface-2);border:1px solid var(--border);border-radius:10px">' +
        '<span style="font-size:0.8rem;color:var(--text-muted)">Video Model:</span>' +
        '<button id="model-wan-btn" class="btn btn-sm" onclick="setVideoModel(\'wan\')" style="font-size:0.75rem;padding:0.3rem 0.7rem">Wan Flash · $0.02</button>' +
        '<button id="model-kling-btn" class="btn btn-sm" onclick="setVideoModel(\'kling\')" style="font-size:0.75rem;padding:0.3rem 0.7rem">Kling 2.6 · $0.40</button>' +
        '<span style="font-size:0.7rem;color:var(--text-dim)">(admin only)</span>' +
        '</div>';
    updateModelButtons();
}

function setVideoModel(model) {
    videoModel = model;
    updateModelButtons();
}

function updateModelButtons() {
    var wan = document.getElementById('model-wan-btn');
    var kling = document.getElementById('model-kling-btn');
    if (!wan || !kling) return;
    wan.style.background = videoModel === 'wan' ? 'var(--accent)' : 'var(--surface-3)';
    wan.style.color = videoModel === 'wan' ? '#fff' : 'var(--text-muted)';
    kling.style.background = videoModel === 'kling' ? 'var(--accent)' : 'var(--surface-3)';
    kling.style.color = videoModel === 'kling' ? '#fff' : 'var(--text-muted)';
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

// Download final video with retry — waits for the file to be ready on the server
async function downloadFinalVideo(url, filename) {
    var maxRetries = 5;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            var bustUrl = url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
            var res = await fetch(bustUrl);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var blob = await res.blob();
            // If the blob is tiny, the file probably isn't ready yet
            if (blob.size < 10000 && attempt < maxRetries) {
                console.log('Download too small (' + blob.size + 'B), retrying in 3s... (' + (attempt + 1) + '/' + maxRetries + ')');
                await sleep(3000);
                continue;
            }
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(a.href);
            return;
        } catch (err) {
            if (attempt < maxRetries) {
                console.log('Download failed, retrying in 3s... (' + (attempt + 1) + '/' + maxRetries + ')');
                await sleep(3000);
            } else {
                alert('Download failed after ' + maxRetries + ' retries. Try opening the link directly:\n' + url);
            }
        }
    }
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

// ==================== CREDIT SYSTEM ====================

var _creditBalance = null;

async function loadCreditBalance() {
    var token = getAuthToken();
    if (!token) return;
    try {
        var res = await fetch('/api/studio/credits/balance', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!res.ok) {
            // No credit account yet — show 0
            updateCreditDisplay(0);
            return;
        }
        var data = await res.json();
        _creditBalance = data;
        var total = (data.balance || 0) + (data.topUpBalance || 0);
        updateCreditDisplay(total);
    } catch (err) {
        console.warn('Could not load credits:', err);
        updateCreditDisplay(0);
    }
}

function updateCreditDisplay(total) {
    var el = document.getElementById('credit-count');
    if (el) el.textContent = total;
    var buyBtn = document.getElementById('buy-credits-btn');
    if (buyBtn) buyBtn.style.display = (total < 50) ? 'inline-flex' : 'none';
}

async function showCreditDetails() {
    var modal = document.getElementById('credit-modal');
    if (!modal) return;
    modal.style.display = 'flex';

    var content = document.getElementById('credit-detail-content');
    if (!_creditBalance) {
        content.innerHTML = '<p style="color:var(--text-dim)">No credit account yet. Subscribe to a plan to get started.</p>';
        return;
    }

    var b = _creditBalance;
    var total = (b.balance || 0) + (b.topUpBalance || 0);
    var planName = b.plan ? b.plan.charAt(0).toUpperCase() + b.plan.slice(1) : 'None';
    var resetStr = b.resetDate ? new Date(b.resetDate).toLocaleDateString() : '—';

    content.innerHTML =
        '<div style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid var(--border)">' +
            '<span>Plan</span><span style="color:var(--text);font-weight:600">' + planName + '</span></div>' +
        '<div style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid var(--border)">' +
            '<span>Monthly Credits</span><span style="color:var(--accent);font-weight:600">' + (b.balance || 0) + '</span></div>' +
        '<div style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid var(--border)">' +
            '<span>Top-Up Credits</span><span style="color:var(--green);font-weight:600">' + (b.topUpBalance || 0) + '</span></div>' +
        '<div style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid var(--border)">' +
            '<span>Total Available</span><span style="color:var(--text);font-weight:700;font-size:1.1rem">' + total + '</span></div>' +
        '<div style="display:flex;justify-content:space-between;padding:0.5rem 0;border-bottom:1px solid var(--border)">' +
            '<span>Total Used</span><span style="color:var(--text-dim)">' + (b.totalUsed || 0) + '</span></div>' +
        '<div style="display:flex;justify-content:space-between;padding:0.5rem 0">' +
            '<span>Resets On</span><span style="color:var(--text-dim)">' + resetStr + '</span></div>' +
        '<div style="margin-top:0.75rem;padding:0.6rem;background:var(--surface-2);border-radius:8px;font-size:0.78rem;color:var(--text-dim);line-height:1.6">' +
            '💡 Scenes: 5 cr · Images: 2 cr/scene · Videos: 5 cr/scene · Assembly: 5 cr</div>';
}

function closeCreditModal() {
    var modal = document.getElementById('credit-modal');
    if (modal) modal.style.display = 'none';
}

async function buyCredits(pack) {
    var token = getAuthToken();
    if (!token) return alert('Please log in first');
    try {
        var res = await fetch('/api/studio/credits/buy', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ pack: pack || 'small' })
        });
        var data = await res.json();
        if (data.url) {
            window.location.href = data.url;
        } else {
            alert(data.error || 'Could not start purchase');
        }
    } catch (err) {
        alert('Purchase failed: ' + err.message);
    }
}

// Check for top-up success on page load
(function() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('topup') === 'success') {
        // Clean URL immediately
        window.history.replaceState({}, '', window.location.pathname);
        
        // Poll for credit balance update (webhook may take a few seconds)
        var attempts = 0;
        var previousBalance = _creditBalance ? ((_creditBalance.balance || 0) + (_creditBalance.topUpBalance || 0)) : 0;
        
        function checkCreditsUpdated() {
            attempts++;
            loadCreditBalance().then(function() {
                var newTotal = _creditBalance ? ((_creditBalance.balance || 0) + (_creditBalance.topUpBalance || 0)) : 0;
                if (newTotal > previousBalance) {
                    showCreditBanner(0, 0); // Remove any existing banner
                    var old = document.getElementById('credit-banner');
                    if (old) old.remove();
                    // Show success banner
                    var banner = document.createElement('div');
                    banner.id = 'credit-banner';
                    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:1000;padding:1rem 1.25rem;background:linear-gradient(135deg,#0a2e1a,#1a3e2d);border-bottom:1px solid rgba(52,211,153,0.3);display:flex;align-items:center;justify-content:center;gap:0.75rem;animation:slideDown 0.3s ease';
                    banner.innerHTML = '<span style="font-size:1.2rem">✅</span><span style="color:#e8e8ed;font-size:0.9rem">Credits added! You now have <b style="color:#34d399">' + newTotal + '</b> credits.</span><button onclick="this.parentNode.remove()" style="padding:0.3rem 0.6rem;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#8b8b9e;font-size:0.82rem;cursor:pointer;font-family:inherit;margin-left:0.5rem">OK</button>';
                    document.body.prepend(banner);
                    setTimeout(function() { var b = document.getElementById('credit-banner'); if (b) b.remove(); }, 6000);
                } else if (attempts < 10) {
                    // Webhook may not have processed yet — retry
                    setTimeout(checkCreditsUpdated, 2000);
                } else {
                    // After 20 seconds, try to verify the session server-side
                    fetch('/api/studio/credits/verify-purchase', {
                        method: 'POST',
                        headers: { 'Authorization': 'Bearer ' + getAuthToken(), 'Content-Type': 'application/json' }
                    }).then(function(r) { return r.json(); }).then(function(d) {
                        if (d.credited) {
                            loadCreditBalance();
                            var banner = document.createElement('div');
                            banner.id = 'credit-banner';
                            banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:1000;padding:1rem 1.25rem;background:linear-gradient(135deg,#0a2e1a,#1a3e2d);border-bottom:1px solid rgba(52,211,153,0.3);display:flex;align-items:center;justify-content:center;gap:0.75rem;animation:slideDown 0.3s ease';
                            banner.innerHTML = '<span style="font-size:1.2rem">✅</span><span style="color:#e8e8ed;font-size:0.9rem">Credits added! Balance updated.</span><button onclick="this.parentNode.remove()" style="padding:0.3rem 0.6rem;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#8b8b9e;font-size:0.82rem;cursor:pointer;font-family:inherit;margin-left:0.5rem">OK</button>';
                            document.body.prepend(banner);
                            setTimeout(function() { var b = document.getElementById('credit-banner'); if (b) b.remove(); }, 6000);
                        } else {
                            showCreditBanner(0, 0);
                            var old2 = document.getElementById('credit-banner');
                            if (old2) old2.remove();
                            var banner2 = document.createElement('div');
                            banner2.id = 'credit-banner';
                            banner2.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:1000;padding:1rem 1.25rem;background:linear-gradient(135deg,#2d1a1a,#3e1a1a);border-bottom:1px solid rgba(248,113,113,0.3);display:flex;align-items:center;justify-content:center;gap:0.75rem;animation:slideDown 0.3s ease';
                            banner2.innerHTML = '<span style="font-size:1.2rem">⚠️</span><span style="color:#e8e8ed;font-size:0.9rem">Payment received but credits are still processing. They should appear within a few minutes.</span><button onclick="this.parentNode.remove()" style="padding:0.3rem 0.6rem;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#8b8b9e;font-size:0.82rem;cursor:pointer;font-family:inherit;margin-left:0.5rem">OK</button>';
                            document.body.prepend(banner2);
                        }
                    }).catch(function() {
                        loadCreditBalance();
                    });
                }
            });
        }
        
        setTimeout(checkCreditsUpdated, 1500);
    }
})();
