/* Seedance 2.0 — Frontend with drag-and-drop uploads */
(function() {
    var token = localStorage.getItem('viewhunt_token') || localStorage.getItem('token');
    if (!token) { window.location.replace('/'); return; }

    // Uploaded media state
    var uploads = { firstFrame: null, lastFrame: null, refImages: [], refVideos: [], refAudio: [] };
    var history = JSON.parse(localStorage.getItem('seedance2_history') || '[]');
    renderHistory();

    // ========== DROP ZONE SETUP ==========
    document.querySelectorAll('.drop-zone').forEach(function(zone) {
        var slot = zone.dataset.slot;
        var accept = zone.dataset.accept;
        var multi = zone.dataset.multi === 'true';

        // Hidden file input
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        if (multi) input.multiple = true;
        zone.appendChild(input);

        zone.addEventListener('click', function(e) { if (e.target.closest('.remove')) return; input.click(); });
        input.addEventListener('change', function() { handleFiles(slot, input.files, multi); input.value = ''; });

        zone.addEventListener('dragover', function(e) { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', function() { zone.classList.remove('dragover'); });
        zone.addEventListener('drop', function(e) {
            e.preventDefault(); zone.classList.remove('dragover');
            handleFiles(slot, e.dataTransfer.files, multi);
        });
    });

    async function handleFiles(slot, fileList, multi) {
        var files = Array.from(fileList);
        for (var i = 0; i < files.length; i++) {
            var file = files[i];
            var url = await uploadFile(file);
            if (!url) continue;

            var item = { url: url, name: file.name, type: file.type, duration: 0 };

            // Get video duration from browser
            if (file.type.startsWith('video/')) {
                item.duration = await getVideoDuration(file);
            }

            if (multi) {
                var maxMap = { refImages: 9, refVideos: 3, refAudio: 3 };
                if (uploads[slot].length >= (maxMap[slot] || 9)) { alert('Maximum files reached for this slot.'); break; }
                uploads[slot].push(item);
            } else {
                uploads[slot] = item;
            }
        }
        renderDropZone(slot);
    }

    function getVideoDuration(file) {
        return new Promise(function(resolve) {
            var video = document.createElement('video');
            video.preload = 'metadata';
            video.onloadedmetadata = function() { URL.revokeObjectURL(video.src); resolve(video.duration || 0); };
            video.onerror = function() { resolve(0); };
            video.src = URL.createObjectURL(file);
        });
    }

    async function uploadFile(file) {
        var formData = new FormData();
        formData.append('file', file);
        try {
            var res = await fetch('/api/studio/seedance2/upload', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token },
                body: formData
            });
            if (!res.ok) {
                var errText = await res.text();
                var err; try { err = JSON.parse(errText); } catch (e) { err = { error: 'Upload failed (server error)' }; }
                alert(err.error || 'Upload failed');
                return null;
            }
            var data = await res.json();
            return data.relativePath || data.url;
        } catch (e) { alert('Upload error: ' + e.message); return null; }
    }

    function renderDropZone(slot) {
        var zoneEl = document.querySelector('[data-slot="' + slot + '"]');
        if (!zoneEl) return;
        var multi = zoneEl.dataset.multi === 'true';
        var placeholder = zoneEl.querySelector('.placeholder');

        // Remove old thumbs
        zoneEl.querySelectorAll('.media-thumb').forEach(function(t) { t.remove(); });

        if (multi) {
            var items = uploads[slot] || [];
            if (items.length === 0) { if (placeholder) placeholder.style.display = ''; return; }
            if (placeholder) placeholder.style.display = 'none';
            items.forEach(function(item, idx) {
                zoneEl.appendChild(makeThumb(item, function() { uploads[slot].splice(idx, 1); renderDropZone(slot); }));
            });
        } else {
            var item = uploads[slot];
            if (!item) { if (placeholder) placeholder.style.display = ''; return; }
            if (placeholder) placeholder.style.display = 'none';
            zoneEl.appendChild(makeThumb(item, function() { uploads[slot] = null; renderDropZone(slot); }));
        }
    }

    function makeThumb(item, onRemove) {
        var div = document.createElement('div');
        div.className = 'media-thumb';
        var isVideo = item.type && item.type.startsWith('video');
        var isAudio = item.type && item.type.startsWith('audio');
        if (isVideo) {
            var vid = document.createElement('video');
            vid.src = item.url; vid.muted = true; vid.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid var(--border)';
            div.appendChild(vid);
        } else if (isAudio) {
            var aud = document.createElement('div');
            aud.style.cssText = 'width:64px;height:64px;border-radius:6px;border:1px solid var(--border);background:var(--surface-2);display:flex;align-items:center;justify-content:center;font-size:1.5rem;';
            aud.textContent = '🔊';
            div.appendChild(aud);
        } else {
            var img = document.createElement('img');
            img.src = item.url;
            div.appendChild(img);
        }
        var btn = document.createElement('button');
        btn.className = 'remove';
        btn.textContent = '✕';
        btn.onclick = function(e) { e.stopPropagation(); onRemove(); };
        div.appendChild(btn);
        return div;
    }

    // ========== PRICING ==========
    var pricingMap = { 4: 10, 8: 20, 12: 29 };

    function updateCostDisplay() {
        var dur = parseInt(document.getElementById('duration').value) || 8;
        var cost = pricingMap[dur] || 20;
        document.getElementById('btn-generate').textContent = 'Generate Video · ' + cost + ' 💎';
    }

    document.getElementById('duration').addEventListener('change', updateCostDisplay);
    updateCostDisplay();

    // ========== GENERATE ==========
    window.generate = async function() {
        var prompt = document.getElementById('prompt').value.trim();
        if (!prompt || prompt.length < 3) return alert('Please enter a prompt (at least 3 characters).');

        // Validate reference video durations (max 15s total, each 2-15s)
        if (uploads.refVideos.length > 0) {
            var totalRefDur = 0;
            for (var rv = 0; rv < uploads.refVideos.length; rv++) {
                var dur = uploads.refVideos[rv].duration || 0;
                if (dur > 15) return alert('Reference video "' + uploads.refVideos[rv].name + '" is ' + Math.round(dur) + 's — max is 15s per video.');
                if (dur > 0 && dur < 2) return alert('Reference video "' + uploads.refVideos[rv].name + '" is too short — minimum is 2s.');
                totalRefDur += dur;
            }
            if (totalRefDur > 15) return alert('Total reference video duration is ' + Math.round(totalRefDur) + 's — max allowed is 15s combined. Remove or trim some videos.');
        }

        var duration = parseInt(document.getElementById('duration').value) || 8;
        var aspectRatio = document.getElementById('aspect-ratio').value || '9:16';
        var generateAudio = document.getElementById('audio-toggle').checked;

        var body = {
            prompt: prompt,
            firstFrameUrl: uploads.firstFrame ? uploads.firstFrame.url : null,
            lastFrameUrl: uploads.lastFrame ? uploads.lastFrame.url : null,
            referenceImageUrls: uploads.refImages.map(function(i) { return i.url; }),
            referenceVideoUrls: uploads.refVideos.map(function(v) { return v.url; }),
            referenceAudioUrls: uploads.refAudio.map(function(a) { return a.url; }),
            duration: duration,
            aspectRatio: aspectRatio,
            generateAudio: generateAudio
        };

        var btn = document.getElementById('btn-generate');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Generating...';
        document.getElementById('progress').style.display = 'block';
        document.getElementById('result').style.display = 'none';
        document.getElementById('progress-text').innerHTML = '<span class="spinner"></span> Sending to Seedance 2.0... This may take 1-3 minutes.';

        try {
            var res = await fetch('/api/studio/seedance2/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(600000) // 10 min timeout
            });

            var text = await res.text();
            var data;
            try { data = JSON.parse(text); } catch (parseErr) {
                throw new Error('Server returned an unexpected response. The generation may still be processing — check back in a minute.');
            }
            if (!res.ok) throw new Error(data.error || 'Generation failed');

            document.getElementById('progress').style.display = 'none';
            document.getElementById('result').style.display = 'block';
            document.getElementById('result-video').src = data.videoUrl;
            document.getElementById('result-download').href = data.videoUrl;

            history.unshift({ prompt: prompt.substring(0, 80), videoUrl: data.videoUrl, date: new Date().toISOString() });
            if (history.length > 20) history = history.slice(0, 20);
            localStorage.setItem('seedance2_history', JSON.stringify(history));
            renderHistory();
        } catch (e) {
            document.getElementById('progress').style.display = 'none';
            // Show friendly maintenance message if applicable
            if (e.message && (e.message.includes('temporarily unavailable') || e.message.includes('maintenance'))) {
                document.getElementById('result').style.display = 'none';
                var prog = document.getElementById('progress');
                prog.style.display = 'block';
                prog.style.borderColor = 'var(--amber)';
                document.getElementById('progress-text').innerHTML = '<div style="font-size:0.88rem;font-weight:700;color:var(--amber);margin-bottom:0.4rem;">⚠️ Temporarily Unavailable</div><div style="font-size:0.82rem;color:var(--text-muted);line-height:1.5;">Seedance 2.0 is experiencing high demand and is temporarily down on the provider side. No credits were deducted from your account. Please try again in a little while.</div>';
            } else {
                alert('Error: ' + e.message);
            }
        } finally {
            btn.disabled = false;
            btn.innerHTML = 'Generate Video · ' + (pricingMap[parseInt(document.getElementById('duration').value)] || 20) + ' 💎';
        }
    };

    // ========== HISTORY ==========
    function renderHistory() {
        if (history.length === 0) { document.getElementById('history-section').style.display = 'none'; return; }
        document.getElementById('history-section').style.display = 'block';
        var html = '';
        history.forEach(function(h) {
            html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:0.75rem;margin-bottom:0.5rem;display:flex;align-items:center;gap:0.75rem;">';
            html += '<video src="' + esc(h.videoUrl) + '" muted style="width:60px;height:60px;object-fit:cover;border-radius:6px;background:var(--surface-2);"></video>';
            html += '<div style="flex:1;min-width:0;"><div style="font-size:0.82rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(h.prompt) + '</div>';
            html += '<div style="font-size:0.72rem;color:var(--text-dim);">' + new Date(h.date).toLocaleDateString() + '</div></div>';
            html += '<a href="' + esc(h.videoUrl) + '" download target="_blank" style="font-size:0.75rem;color:var(--accent);text-decoration:none;">📥</a></div>';
        });
        document.getElementById('history-list').innerHTML = html;
    }

    function esc(s) { return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : ''; }
})();
