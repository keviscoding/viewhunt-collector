// AI Storytelling App — Director Mode

var currentScenes = [];
var currentCharacters = [];
var generatingAll = false;

document.addEventListener('DOMContentLoaded', function() {
    checkAuth();
    loadCreditBalance();
    initScriptInput();
});

function getAuthToken() {
    return localStorage.getItem('viewhunt_token') || localStorage.getItem('token') || null;
}

function checkAuth() {
    if (!getAuthToken()) { window.location.href = '/app'; return; }
}

async function loadCreditBalance() {
    try {
        var res = await fetch('/api/studio/credits/balance', { headers: { 'Authorization': 'Bearer ' + getAuthToken() } });
        if (!res.ok) return;
        var d = await res.json();
        var total = (d.balance || 0) + (d.topUpBalance || 0);
        document.getElementById('credit-balance').textContent = total + ' credits';
    } catch (e) {}
}

function initScriptInput() {
    var ta = document.getElementById('script');
    var wc = document.getElementById('word-count');
    ta.addEventListener('input', function() {
        var words = ta.value.trim().split(/\s+/).filter(function(w) { return w.length > 0; });
        wc.textContent = words.length + ' words';
    });

    document.getElementById('generate-scenes-btn').addEventListener('click', function() {
        var script = ta.value.trim();
        if (!script) return alert('Paste a script first');
        if (script.split(/\s+/).length < 20) return alert('Script is too short. Paste a full story.');
        generateScenes(script);
    });
}

async function generateScenes(script) {
    var btn = document.getElementById('generate-scenes-btn');
    btn.disabled = true;
    btn.querySelector('.btn-text').textContent = 'Breaking into scenes...';

    try {
        var res = await fetch('/api/studio/storytelling/scenes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() },
            body: JSON.stringify({ script: script })
        });

        if (res.status === 402) {
            var err = await res.json();
            alert('Not enough credits. Need ' + (err.cost || 5) + ' credits.');
            return;
        }
        if (!res.ok) {
            var errData = await res.json();
            throw new Error(errData.error || 'Failed');
        }

        var data = await res.json();
        currentScenes = data.scenes || [];
        currentCharacters = data.characters || [];

        renderScenes();
        loadCreditBalance();

    } catch (e) {
        alert('Error: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.querySelector('.btn-text').textContent = 'Break Into Scenes · 5 credits';
    }
}

function renderScenes() {
    document.getElementById('config-section').style.display = 'none';
    document.getElementById('scenes-section').style.display = 'block';

    // Characters panel
    if (currentCharacters.length > 0) {
        var cp = document.getElementById('characters-panel');
        cp.style.display = 'block';
        var html = '';
        currentCharacters.forEach(function(c) {
            html += '<div class="char-tag"><strong>' + c.name + '</strong> — ' + c.description + '</div>';
        });
        document.getElementById('characters-list').innerHTML = html;
    }

    // Cost estimate
    var cost = currentScenes.length * 5;
    document.getElementById('cost-estimate').textContent = currentScenes.length + ' scenes · ~' + cost + ' credits to generate all videos';

    // Update generate all button
    document.getElementById('generate-all-btn').textContent = 'Generate All Videos · ' + cost + ' credits';

    // Render scene cards
    var grid = document.getElementById('scenes-grid');
    var cardsHtml = '';
    currentScenes.forEach(function(scene, i) {
        var num = scene.sceneNumber || (i + 1);
        var pov = scene.povType === 'selfie' ? 'Selfie POV' : 'Rear Camera POV';
        cardsHtml += '<div class="scene-card" id="scene-card-' + i + '">' +
            '<div class="scene-head">' +
            '<span class="scene-num">Scene ' + num + '</span>' +
            '<span class="scene-pov">' + pov + '</span>' +
            '</div>' +
            '<div class="scene-excerpt">"' + escapeHtml(scene.excerpt || '') + '"</div>' +
            '<div class="scene-desc">' + escapeHtml(scene.description || '') + '</div>' +
            '<div class="scene-controls">' +
            '<button class="btn btn-green btn-sm" onclick="generateSceneVideo(' + i + ')" id="gen-btn-' + i + '">Generate Video · 5 credits</button>' +
            '</div>' +
            '<div class="scene-result" id="scene-result-' + i + '"></div>' +
            '</div>';
    });
    grid.innerHTML = cardsHtml;
}

async function generateSceneVideo(idx) {
    var scene = currentScenes[idx];
    if (!scene) return;

    var btn = document.getElementById('gen-btn-' + idx);
    var result = document.getElementById('scene-result-' + idx);
    btn.disabled = true;
    btn.textContent = 'Generating...';
    result.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem">Submitting to Sora 2... this may take 2-5 minutes.</div>';

    try {
        var res = await fetch('/api/studio/storytelling/generate-video', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getAuthToken() },
            body: JSON.stringify({
                videoPrompt: scene.videoPrompt,
                sceneNumber: scene.sceneNumber || (idx + 1)
            })
        });

        if (res.status === 402) {
            var err = await res.json();
            alert('Not enough credits.');
            result.innerHTML = '';
            return;
        }
        if (!res.ok) {
            var errData = await res.json();
            throw new Error(errData.error || 'Failed');
        }

        var data = await res.json();
        scene.videoUrl = data.videoUrl;

        result.innerHTML = '<video src="' + data.videoUrl + '" controls muted loop class="video-preview"></video>' +
            '<div style="margin-top:0.5rem"><button class="btn btn-secondary btn-sm" onclick="generateSceneVideo(' + idx + ')">Regenerate · 5 credits</button>' +
            ' <button class="btn btn-secondary btn-sm" onclick="downloadFile(\'' + data.videoUrl + '\',\'scene-' + (scene.sceneNumber || idx + 1) + '.mp4\')">Download</button></div>';

        updateDownloadAllBtn();
        loadCreditBalance();

    } catch (e) {
        result.innerHTML = '<div style="color:var(--red);font-size:0.8rem">Failed: ' + escapeHtml(e.message) + ' <a href="#" onclick="event.preventDefault();generateSceneVideo(' + idx + ')" style="color:var(--accent)">Retry</a></div>';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Generate Video · 5 credits';
    }
}

async function generateAllVideos() {
    if (generatingAll) return;
    var scenesWithoutVideo = currentScenes.filter(function(s) { return !s.videoUrl; });
    if (scenesWithoutVideo.length === 0) return alert('All scenes already have videos');

    var cost = scenesWithoutVideo.length * 5;
    if (!confirm('Generate ' + scenesWithoutVideo.length + ' videos? This will use ~' + cost + ' credits and may take 10-30 minutes.')) return;

    generatingAll = true;
    var allBtn = document.getElementById('generate-all-btn');
    allBtn.disabled = true;
    allBtn.textContent = 'Generating...';
    document.getElementById('generation-warning').style.display = 'block';

    for (var i = 0; i < currentScenes.length; i++) {
        if (currentScenes[i].videoUrl) continue;
        allBtn.textContent = 'Generating ' + (i + 1) + '/' + currentScenes.length + '...';
        await generateSceneVideo(i);
        // Small delay between requests
        if (i < currentScenes.length - 1) await new Promise(function(r) { setTimeout(r, 1000); });
    }

    generatingAll = false;
    allBtn.disabled = false;
    allBtn.textContent = 'Generate All Videos';
    document.getElementById('generation-warning').style.display = 'none';

    // Show completion prompt
    var grid = document.getElementById('scenes-grid');
    var prompt = document.createElement('div');
    prompt.style.cssText = 'background:linear-gradient(135deg,#1a1a2e,#16213e);border:1px solid var(--accent);border-radius:12px;padding:1.5rem;text-align:center;margin-bottom:1rem';
    prompt.innerHTML = '<div style="font-size:1.5rem;margin-bottom:0.5rem">Done</div>' +
        '<div style="font-size:1rem;font-weight:700;margin-bottom:0.35rem">All videos generated</div>' +
        '<div style="color:var(--text-muted);font-size:0.85rem">Download your clips and edit them together in your video editor.</div>';
    grid.insertBefore(prompt, grid.firstChild);
}

function updateDownloadAllBtn() {
    var hasVideos = currentScenes.some(function(s) { return s.videoUrl; });
    document.getElementById('download-all-btn').style.display = hasVideos ? 'inline-flex' : 'none';
}

async function downloadAllVideos() {
    var videos = currentScenes.filter(function(s) { return s.videoUrl; });
    if (videos.length === 0) return alert('No videos to download');
    for (var i = 0; i < videos.length; i++) {
        try {
            await downloadFile(videos[i].videoUrl, 'scene-' + (videos[i].sceneNumber || i + 1) + '.mp4');
            if (i < videos.length - 1) await new Promise(function(r) { setTimeout(r, 500); });
        } catch (e) { console.error('Download error:', e); }
    }
}

async function downloadFile(url, filename) {
    var res = await fetch(url);
    var blob = await res.blob();
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
}

function resetToScript() {
    currentScenes = [];
    currentCharacters = [];
    document.getElementById('config-section').style.display = 'block';
    document.getElementById('scenes-section').style.display = 'none';
    document.getElementById('scenes-grid').innerHTML = '';
    document.getElementById('characters-panel').style.display = 'none';
}

function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
