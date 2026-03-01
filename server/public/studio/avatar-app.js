/**
 * AI Avatar — Frontend App
 * Manages character creation, image generation, and gallery.
 */
var API = '/api/studio/avatar';
var token = localStorage.getItem('viewhunt_token') || localStorage.getItem('token');
var state = {
    characters: [],
    selectedCharId: null,
    styles: [],
    selectedStyleId: null,
    pendingPhotos: [],       // File objects for new character
    selectedSize: '1152x2048',
    selectedCount: 4,
    refImageFile: null,
    generating: false,
    lastResults: [],
    gallery: []
};

// ===== AUTH HELPERS =====
function authHeaders() {
    return { 'Authorization': 'Bearer ' + token };
}
function authJsonHeaders() {
    return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' };
}

// ===== TOAST =====
function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast toast-' + (type || 'error');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function() { el.remove(); }, 3500);
}

// ===== TABS =====
function switchTab(tab) {
    ['characters', 'generate', 'gallery'].forEach(function(t) {
        document.getElementById('panel-' + t).style.display = t === tab ? 'block' : 'none';
        document.getElementById('tab-' + t).classList.toggle('active', t === tab);
    });
    if (tab === 'generate') refreshCharSelector();
    if (tab === 'gallery') loadGallery();
}

// ===== CHARACTERS =====
async function loadCharacters() {
    try {
        var res = await fetch(API + '/characters', { headers: authHeaders() });
        if (!res.ok) throw new Error('Failed to load characters');
        var data = await res.json();
        state.characters = data.characters || [];
        renderCharacters();
        // Auto-poll any training characters
        var training = state.characters.filter(function(c) { return c.status !== 'completed' && c.status !== 'failed'; });
        if (training.length > 0) setTimeout(loadCharacters, 8000);
    } catch (e) {
        console.warn('Load characters error:', e);
    }
}

function renderCharacters() {
    var list = document.getElementById('characters-list');
    if (state.characters.length === 0) {
        list.innerHTML = '<div style="text-align:center;padding:1rem;color:var(--text-dim);font-size:0.85rem">No characters yet. Create one to get started.</div>';
        return;
    }
    var html = '';
    state.characters.forEach(function(c) {
        var isReady = c.status === 'completed';
        var statusClass = isReady ? 'ready' : (c.status === 'failed' ? 'failed' : 'training-status');
        var statusText = isReady ? '✓ Ready' : (c.status === 'failed' ? '✗ Failed' : '⏳ Training...');
        html += '<div class="char-card' + (isReady ? '' : ' training') + '" onclick="' + (isReady ? 'selectCharAndGenerate(\'' + c.higgsId + '\')' : '') + '">';
        html += '<div class="char-avatar">';
        if (c.thumbnailUrl) html += '<img src="' + c.thumbnailUrl + '" alt="' + esc(c.name) + '">';
        else html += '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:1.3rem">🎭</div>';
        html += '</div>';
        html += '<div class="char-info"><div class="char-name">' + esc(c.name) + '</div>';
        html += '<div class="char-status ' + statusClass + '">' + statusText + '</div></div>';
        html += '<div class="char-actions">';
        if (c.status === 'failed') html += '<button class="btn btn-danger" onclick="event.stopPropagation();deleteCharacter(\'' + c.id + '\')" style="font-size:0.75rem;padding:0.25rem 0.5rem">Delete</button>';
        html += '</div></div>';
    });
    list.innerHTML = html;
}

function selectCharAndGenerate(charId) {
    state.selectedCharId = charId;
    switchTab('generate');
}

function showCreateCharacter() {
    document.getElementById('create-char-panel').style.display = 'block';
    state.pendingPhotos = [];
    document.getElementById('photo-preview-grid').innerHTML = '';
    document.getElementById('char-name-input').value = '';
    updateCreateBtn();
}
function hideCreateCharacter() {
    document.getElementById('create-char-panel').style.display = 'none';
    state.pendingPhotos = [];
}

// Photo upload handling
var photoZone = document.getElementById('photo-upload-zone');
var photoInput = document.getElementById('photo-input');

photoZone.addEventListener('dragover', function(e) { e.preventDefault(); photoZone.classList.add('dragover'); });
photoZone.addEventListener('dragleave', function() { photoZone.classList.remove('dragover'); });
photoZone.addEventListener('drop', function(e) {
    e.preventDefault(); photoZone.classList.remove('dragover');
    addPhotos(Array.from(e.dataTransfer.files));
});
photoInput.addEventListener('change', function() {
    addPhotos(Array.from(this.files));
    this.value = '';
});

function addPhotos(files) {
    files.forEach(function(f) {
        if (!f.type.startsWith('image/')) return;
        if (state.pendingPhotos.length >= 30) return;
        state.pendingPhotos.push(f);
    });
    renderPhotoPreview();
    updateCreateBtn();
}

function removePhoto(idx) {
    state.pendingPhotos.splice(idx, 1);
    renderPhotoPreview();
    updateCreateBtn();
}

function renderPhotoPreview() {
    var grid = document.getElementById('photo-preview-grid');
    var html = '';
    state.pendingPhotos.forEach(function(f, i) {
        var url = URL.createObjectURL(f);
        html += '<div class="photo-thumb"><img src="' + url + '" alt="Photo ' + (i+1) + '"><button class="remove-btn" onclick="removePhoto(' + i + ')">✕</button></div>';
    });
    grid.innerHTML = html;
}

function updateCreateBtn() {
    var btn = document.getElementById('create-char-btn');
    var count = state.pendingPhotos.length;
    btn.disabled = count < 5;
    btn.innerHTML = 'Train Character (' + count + ' photos) · <span class="credit-badge">0 💎</span>';
}

async function createCharacter() {
    var name = document.getElementById('char-name-input').value.trim();
    if (!name) return toast('Enter a character name');
    if (state.pendingPhotos.length < 5) return toast('Upload at least 5 photos');

    var btn = document.getElementById('create-char-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Uploading photos...';

    try {
        // Upload photos via multipart
        var formData = new FormData();
        formData.append('name', name);
        state.pendingPhotos.forEach(function(f) { formData.append('photos', f); });

        var res = await fetch(API + '/characters', {
            method: 'POST',
            headers: authHeaders(),
            body: formData
        });
        if (!res.ok) {
            var err = await res.json().catch(function() { return {}; });
            throw new Error(err.error || 'Failed to create character');
        }
        var data = await res.json();
        toast('Character training started — this takes 5-15 minutes', 'success');
        hideCreateCharacter();
        loadCharacters();
    } catch (e) {
        toast(e.message);
        btn.disabled = false;
        updateCreateBtn();
    }
}

async function deleteCharacter(charId) {
    if (!confirm('Delete this character?')) return;
    try {
        await fetch(API + '/characters/' + charId, { method: 'DELETE', headers: authHeaders() });
        loadCharacters();
    } catch (e) { toast('Delete failed'); }
}

// ===== STYLES =====
async function loadStyles() {
    try {
        var res = await fetch(API + '/styles', { headers: authHeaders() });
        if (!res.ok) throw new Error('Failed to load styles');
        var data = await res.json();
        state.styles = data.styles || [];
        renderStyles();
    } catch (e) {
        document.getElementById('style-grid').innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem;grid-column:1/-1">Could not load styles</div>';
    }
}

function renderStyles() {
    var grid = document.getElementById('style-grid');
    if (state.styles.length === 0) {
        grid.innerHTML = '<div style="color:var(--text-dim);font-size:0.82rem;grid-column:1/-1">No styles available</div>';
        return;
    }
    // Auto-select iPhone style or first
    if (!state.selectedStyleId) {
        var iphone = state.styles.find(function(s) { return s.name && s.name.toLowerCase().indexOf('iphone') >= 0; });
        state.selectedStyleId = iphone ? iphone.id : state.styles[0].id;
    }
    var html = '';
    state.styles.forEach(function(s) {
        var sel = s.id === state.selectedStyleId ? ' selected' : '';
        html += '<div class="style-card' + sel + '" onclick="selectStyle(\'' + s.id + '\')">';
        if (s.preview_url) html += '<img src="' + s.preview_url + '" alt="' + esc(s.name) + '">';
        else html += '<div style="width:100%;aspect-ratio:1;background:var(--surface-3);display:flex;align-items:center;justify-content:center;font-size:1.5rem">🎨</div>';
        html += '<div class="style-card-name">' + esc(s.name) + '</div>';
        html += '</div>';
    });
    grid.innerHTML = html;
}

function selectStyle(id) {
    state.selectedStyleId = id;
    renderStyles();
}

// ===== GENERATE TAB HELPERS =====
function refreshCharSelector() {
    var list = document.getElementById('char-selector-list');
    var readyChars = state.characters.filter(function(c) { return c.status === 'completed'; });
    var noCharMsg = document.getElementById('no-char-msg');
    var charSection = document.getElementById('char-selector-section');

    if (readyChars.length === 0) {
        noCharMsg.style.display = 'block';
        charSection.style.display = 'none';
        return;
    }
    noCharMsg.style.display = 'none';
    charSection.style.display = 'block';

    if (!state.selectedCharId || !readyChars.find(function(c) { return c.higgsId === state.selectedCharId; })) {
        state.selectedCharId = readyChars[0].higgsId;
    }

    var html = '';
    readyChars.forEach(function(c) {
        var sel = c.higgsId === state.selectedCharId ? ' selected' : '';
        html += '<div class="char-card' + sel + '" onclick="state.selectedCharId=\'' + c.higgsId + '\';refreshCharSelector()">';
        html += '<div class="char-avatar">';
        if (c.thumbnailUrl) html += '<img src="' + c.thumbnailUrl + '" alt="">';
        else html += '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:1.3rem">🎭</div>';
        html += '</div>';
        html += '<div class="char-info"><div class="char-name">' + esc(c.name) + '</div><div class="char-status ready">✓ Ready</div></div>';
        html += '</div>';
    });
    list.innerHTML = html;
}

function selectSize(el) {
    state.selectedSize = el.dataset.size;
    document.querySelectorAll('#size-options .size-opt').forEach(function(o) { o.classList.remove('selected'); });
    el.classList.add('selected');
}
function selectCount(el) {
    state.selectedCount = parseInt(el.dataset.count);
    el.parentElement.querySelectorAll('.size-opt').forEach(function(o) { o.classList.remove('selected'); });
    el.classList.add('selected');
    updateGenCost();
}
function updateGenCost() {
    var cost = state.selectedCount === 4 ? 2 : 0.5;
    document.getElementById('gen-cost-badge').textContent = cost + ' 💎';
}

// Reference image
function handleRefUpload(input) {
    if (!input.files || !input.files[0]) return;
    state.refImageFile = input.files[0];
    var url = URL.createObjectURL(state.refImageFile);
    document.getElementById('ref-preview-img').src = url;
    document.getElementById('ref-preview-wrap').style.display = 'block';
    document.getElementById('ref-upload-zone').style.display = 'none';
}
function clearRefImage() {
    state.refImageFile = null;
    document.getElementById('ref-preview-wrap').style.display = 'none';
    document.getElementById('ref-upload-zone').style.display = 'block';
    document.getElementById('ref-input').value = '';
}

// ===== GENERATE =====
async function generateImages() {
    if (state.generating) return;
    if (!state.selectedCharId) return toast('Select a character first');
    var prompt = document.getElementById('prompt-input').value.trim();
    if (!prompt && !state.refImageFile) return toast('Enter a prompt or upload a reference image');

    state.generating = true;
    var btn = document.getElementById('generate-btn');
    var statusEl = document.getElementById('gen-status');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Generating...';
    statusEl.textContent = '';

    try {
        var body = {
            characterId: state.selectedCharId,
            prompt: prompt,
            styleId: state.selectedStyleId,
            size: state.selectedSize,
            batchSize: state.selectedCount
        };

        // If reference image, upload it first
        if (state.refImageFile) {
            statusEl.textContent = 'Uploading reference image...';
            var formData = new FormData();
            formData.append('image', state.refImageFile);
            var uploadRes = await fetch(API + '/upload-reference', {
                method: 'POST', headers: authHeaders(), body: formData
            });
            if (!uploadRes.ok) throw new Error('Reference upload failed');
            var uploadData = await uploadRes.json();
            body.referenceImageUrl = uploadData.url;
            statusEl.textContent = 'Describing reference image with AI...';
        }

        // Start generation
        statusEl.textContent = 'Starting generation...';
        var res = await fetch(API + '/generate', {
            method: 'POST', headers: authJsonHeaders(), body: JSON.stringify(body)
        });
        if (!res.ok) {
            var err = await res.json().catch(function() { return {}; });
            throw new Error(err.error || 'Generation failed');
        }
        var data = await res.json();
        var jobSetId = data.jobSetId;

        // Poll for results
        statusEl.textContent = 'Generating images — this takes 30-90 seconds...';
        var results = await pollGeneration(jobSetId, statusEl);
        state.lastResults = results;
        renderGenResults(results);
        document.getElementById('gen-results-section').style.display = 'block';
        toast('Images generated', 'success');
    } catch (e) {
        toast(e.message);
        statusEl.textContent = '';
    } finally {
        state.generating = false;
        btn.disabled = false;
        var cost = state.selectedCount === 4 ? 2 : 0.5;
        btn.innerHTML = 'Generate · <span class="credit-badge">' + cost + ' 💎</span>';
    }
}

async function pollGeneration(jobSetId, statusEl) {
    for (var i = 0; i < 60; i++) {
        await sleep(5000);
        try {
            var res = await fetch(API + '/poll/' + jobSetId, { headers: authHeaders() });
            if (!res.ok) continue;
            var data = await res.json();
            if (data.status === 'completed') return data.results;
            if (data.status === 'failed') throw new Error('Generation failed');
            var done = (data.results || []).filter(function(r) { return r.status === 'completed'; }).length;
            statusEl.textContent = 'Generating... ' + done + '/' + state.selectedCount + ' done';
        } catch (e) {
            if (e.message === 'Generation failed') throw e;
        }
    }
    throw new Error('Generation timed out');
}

function renderGenResults(results) {
    var grid = document.getElementById('gen-results-grid');
    var html = '';
    results.forEach(function(r, i) {
        if (r.status !== 'completed' || !r.imageUrl) return;
        html += '<div class="gen-card">';
        html += '<img src="' + r.rawUrl + '" alt="Generated ' + (i+1) + '" onclick="openLightbox(\'' + r.rawUrl + '\')">';
        html += '<div class="gen-card-actions">';
        html += '<a href="' + r.rawUrl + '" download="avatar-' + Date.now() + '-' + i + '.jpg" target="_blank" class="btn btn-secondary" style="text-decoration:none">📥</a>';
        html += '</div></div>';
    });
    if (!html) html = '<div style="color:var(--text-dim);font-size:0.85rem;grid-column:1/-1;text-align:center;padding:1rem">No images generated — try a different prompt</div>';
    grid.innerHTML = html;
}

// ===== GALLERY =====
async function loadGallery() {
    try {
        var res = await fetch(API + '/gallery', { headers: authHeaders() });
        if (!res.ok) throw new Error('Failed');
        var data = await res.json();
        state.gallery = data.generations || [];
        renderGallery();
    } catch (e) {
        document.getElementById('gallery-grid').innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem;grid-column:1/-1;text-align:center;padding:1rem">Could not load gallery</div>';
    }
}

function renderGallery() {
    var grid = document.getElementById('gallery-grid');
    if (state.gallery.length === 0) {
        grid.innerHTML = '<div style="color:var(--text-dim);font-size:0.85rem;grid-column:1/-1;text-align:center;padding:1rem">No generations yet. Create a character and start generating.</div>';
        return;
    }
    var html = '';
    state.gallery.forEach(function(gen) {
        (gen.images || []).forEach(function(img, i) {
            if (!img.rawUrl && !img.imageUrl) return;
            var url = img.rawUrl || img.imageUrl;
            html += '<div class="gen-card">';
            html += '<img src="' + url + '" alt="Generated" onclick="openLightbox(\'' + url + '\')" loading="lazy">';
            html += '<div class="gen-card-actions">';
            html += '<a href="' + url + '" download target="_blank" class="btn btn-secondary" style="text-decoration:none;font-size:0.75rem">📥</a>';
            html += '</div></div>';
        });
    });
    grid.innerHTML = html || '<div style="color:var(--text-dim);font-size:0.85rem;grid-column:1/-1;text-align:center;padding:1rem">No images found</div>';
}

// ===== LIGHTBOX =====
function openLightbox(url) {
    document.getElementById('lightbox-img').src = url;
    document.getElementById('lightbox').style.display = 'flex';
}

// ===== UTILS =====
function esc(str) { var d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML; }
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// ===== INIT =====
loadCharacters();
loadStyles();
updateGenCost();
