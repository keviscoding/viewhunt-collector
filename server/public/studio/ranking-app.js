/**
 * Ranking Video — Frontend App
 * Upload → Trim → Dashboard (title, position, order) → Assemble
 * Live overlay preview, position controls, #1 at top ascending
 */
(function() {
    'use strict';

    var clips = [];
    var currentTrimIndex = 0;
    var currentStep = 1;
    var dragging = null;
    var timelineDuration = 0;

    // Layout settings (sent to assembler)
    var layout = { listX: 5, titleY: 6, titleSize: 48 };
    var colorPalette = 'yellow';
    var checkeredMode = false;
    var subtitleColor = 'yellow';

    function getToken() { return localStorage.getItem('viewhunt_token') || localStorage.getItem('token') || null; }
    function authHeaders() { return { 'Authorization': 'Bearer ' + getToken() }; }
    async function apiFetch(url, opts) {
        opts = opts || {};
        opts.headers = Object.assign({}, opts.headers || {}, authHeaders());
        var res = await fetch(url, opts);
        if (res.status === 401 || res.status === 403) { window.location.replace('/'); throw new Error('Auth failed'); }
        return res;
    }

    async function loadCredits() {
        try {
            var res = await apiFetch('/api/studio/credits/balance');
            var data = await res.json();
            document.getElementById('credit-balance').textContent = (data.totalAvailable || 0);
        } catch (e) { console.warn('Credits:', e); }
    }

    function goToStep(step) {
        currentStep = step;
        ['screen-upload','screen-trim','screen-title','screen-result'].forEach(function(id, i) {
            var el = document.getElementById(id);
            if (i + 1 === step) el.classList.remove('hidden'); else el.classList.add('hidden');
        });
        for (var i = 1; i <= 4; i++) {
            var s = document.getElementById('step-' + i);
            s.className = 'step';
            if (i < step) s.classList.add('done'); else if (i === step) s.classList.add('active');
        }
    }

    // ==================== UPLOAD ====================
    function initUpload() {
        var zone = document.getElementById('upload-zone');
        var input = document.getElementById('file-input');
        zone.addEventListener('click', function() { input.click(); });
        zone.addEventListener('dragover', function(e) { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', function() { zone.classList.remove('dragover'); });
        zone.addEventListener('drop', function(e) { e.preventDefault(); zone.classList.remove('dragover'); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
        input.addEventListener('change', function() { if (input.files.length) handleFiles(input.files); input.value = ''; });
    }

    async function handleFiles(fileList) {
        for (var i = 0; i < fileList.length && clips.length < 10; i++) {
            if (!fileList[i].type.startsWith('video/')) continue;
            await uploadFile(fileList[i]);
        }
        if (clips.length >= 10) alert('Maximum 10 clips reached');
    }

    async function uploadFile(file) {
        if (file.size > 50 * 1024 * 1024) { alert('File too large: ' + file.name + '. Maximum 50MB per clip.'); return; }
        var tempId = 'up-' + Date.now() + Math.random();
        clips.push({ _tempId: tempId, uploading: true, uploadPct: 0, originalName: file.name, filename: null, url: null, duration: 0, originalDuration: 0, label: '', startTime: 0, endTime: 0 });
        renderClipList();
        return new Promise(function(resolve) {
            var fd = new FormData(); fd.append('clip', file);
            var xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/studio/ranking/upload');
            xhr.setRequestHeader('Authorization', 'Bearer ' + getToken());
            xhr.upload.onprogress = function(e) {
                if (e.lengthComputable) { var idx = clips.findIndex(function(c) { return c._tempId === tempId; }); if (idx >= 0) { clips[idx].uploadPct = Math.round((e.loaded / e.total) * 100); renderClipList(); } }
            };
            xhr.onload = function() {
                try {
                    var data = JSON.parse(xhr.responseText);
                    if (xhr.status >= 200 && xhr.status < 300 && data.success) {
                        var idx = clips.findIndex(function(c) { return c._tempId === tempId; });
                        if (idx >= 0) clips[idx] = { filename: data.filename, url: data.url, duration: data.duration, originalDuration: data.duration, label: '', startTime: 0, endTime: data.duration, originalName: file.name, uploading: false };
                    } else { clips = clips.filter(function(c) { return c._tempId !== tempId; }); alert('Upload failed: ' + (data.error || 'Server error')); }
                } catch (e) { clips = clips.filter(function(c) { return c._tempId !== tempId; }); alert('Upload failed'); }
                renderClipList(); updateNextButton(); resolve();
            };
            xhr.onerror = function() { clips = clips.filter(function(c) { return c._tempId !== tempId; }); alert('Upload failed: Network error.'); renderClipList(); updateNextButton(); resolve(); };
            xhr.ontimeout = function() { clips = clips.filter(function(c) { return c._tempId !== tempId; }); alert('Upload timed out.'); renderClipList(); updateNextButton(); resolve(); };
            xhr.timeout = 120000; xhr.send(fd);
        });
    }

    function renderClipList() {
        var list = document.getElementById('clip-list'); var html = '';
        clips.forEach(function(clip, i) {
            html += '<div class="clip-item"><div class="clip-num">' + (i + 1) + '</div><div class="clip-info">';
            if (clip.uploading) { html += '<div class="clip-name">Uploading ' + (clip.originalName || '') + ' (' + (clip.uploadPct || 0) + '%)</div>'; }
            else { html += '<div class="clip-name">' + (clip.originalName || clip.filename) + '</div><div class="clip-meta">' + clip.duration.toFixed(1) + 's</div>'; }
            html += '</div>';
            if (!clip.uploading) html += '<div class="clip-actions"><button onclick="window._rk.remove(' + i + ')" class="danger" title="Remove">x</button></div>';
            html += '</div>';
        });
        list.innerHTML = html;
    }

    function updateNextButton() { document.getElementById('btn-next-trim').disabled = clips.filter(function(c) { return !c.uploading && c.filename; }).length < 2; }

    function removeClip(index) {
        var clip = clips[index];
        if (clip && clip.filename) apiFetch('/api/studio/ranking/clip/' + clip.filename, { method: 'DELETE' }).catch(function(){});
        clips.splice(index, 1); renderClipList(); updateNextButton();
    }

    // ==================== URL IMPORT ====================
    async function importFromUrl() {
        var input = document.getElementById('url-input');
        var btn = document.getElementById('btn-import-url');
        var status = document.getElementById('url-status');
        var url = (input.value || '').trim();

        if (!url) return;
        if (clips.length >= 10) { alert('Maximum 10 clips reached'); return; }

        btn.disabled = true; btn.textContent = 'Downloading...';
        status.classList.remove('hidden');
        status.style.color = 'var(--text-muted)';
        status.textContent = 'Downloading video from URL... this may take a moment';

        try {
            var res = await apiFetch('/api/studio/ranking/import-url', {
                method: 'POST',
                headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
                body: JSON.stringify({ url: url })
            });
            var data = await res.json();

            if (!res.ok || !data.success) {
                throw new Error(data.error || 'Import failed');
            }

            clips.push({
                filename: data.filename, url: data.url,
                duration: data.duration, originalDuration: data.duration,
                label: '', startTime: 0, endTime: data.duration,
                originalName: url.length > 40 ? url.substring(0, 40) + '...' : url,
                uploading: false
            });

            input.value = '';
            status.style.color = 'var(--green)';
            status.textContent = 'Imported ' + data.duration.toFixed(1) + 's clip';
            setTimeout(function() { status.classList.add('hidden'); }, 3000);
            renderClipList(); updateNextButton();
        } catch (err) {
            status.style.color = 'var(--red)';
            status.textContent = err.message + ' — Download the video to your device first, then upload it.';
            status.classList.remove('hidden');
        }

        btn.disabled = false; btn.textContent = 'Import';
    }

    function initUrlImport() {
        document.getElementById('btn-import-url').addEventListener('click', importFromUrl);
        document.getElementById('url-input').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); importFromUrl(); }
        });
    }

    // ==================== TRIM ====================
    function startTrimming() { currentTrimIndex = 0; goToStep(2); showTrimClip(0); }

    function showTrimClip(index) {
        currentTrimIndex = index;
        var clip = clips[index]; if (!clip) return;
        document.getElementById('trim-clip-num').textContent = (index + 1);
        document.getElementById('trim-total').textContent = clips.length;
        var video = document.getElementById('trim-video');
        video.src = clip.url; video.load(); updatePlayOverlay();
        timelineDuration = clip.originalDuration || clip.duration;
        document.getElementById('trim-label').value = clip.label || '';
        video.onloadedmetadata = function() {
            timelineDuration = video.duration || clip.duration;
            if (clip.endTime === 0 || clip.endTime > timelineDuration) clip.endTime = timelineDuration;
            updateTimelineUI(); renderTicks(); video.currentTime = clip.startTime;
        };
        document.getElementById('btn-trim-prev').style.display = index === 0 ? 'none' : '';
        document.getElementById('btn-trim-next').textContent = index === clips.length - 1 ? 'Next: Dashboard' : 'Next Clip';
        renderPreview('preview-trim');
    }

    function togglePlay() { var v = document.getElementById('trim-video'); if (v.paused) v.play(); else v.pause(); }
    function updatePlayOverlay() {
        var v = document.getElementById('trim-video'), o = document.getElementById('play-overlay');
        if (!o) return;
        if (v.paused || v.ended) o.classList.remove('is-playing'); else o.classList.add('is-playing');
    }
    function initPlayControls() {
        document.getElementById('trim-video-wrap').addEventListener('click', function(e) { if (!e.target.closest('.timeline-handle')) togglePlay(); });
        var v = document.getElementById('trim-video');
        v.addEventListener('play', updatePlayOverlay); v.addEventListener('pause', updatePlayOverlay); v.addEventListener('ended', updatePlayOverlay);
    }

    function getTrackRect() { return document.getElementById('timeline-track').getBoundingClientRect(); }
    function timeToPercent(t) { return timelineDuration <= 0 ? 0 : Math.max(0, Math.min(100, (t / timelineDuration) * 100)); }
    function percentToTime(pct) { return Math.max(0, Math.min(timelineDuration, (pct / 100) * timelineDuration)); }
    function xToPercent(clientX) { var r = getTrackRect(); return Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)); }

    function updateTimelineUI() {
        var clip = clips[currentTrimIndex]; if (!clip) return;
        var sp = timeToPercent(clip.startTime), ep = timeToPercent(clip.endTime);
        document.getElementById('timeline-fill').style.left = sp + '%';
        document.getElementById('timeline-fill').style.width = (ep - sp) + '%';
        document.getElementById('handle-start').style.left = 'calc(' + sp + '% - 7px)';
        document.getElementById('handle-end').style.left = 'calc(' + ep + '% - 7px)';
        document.getElementById('trim-start-display').textContent = clip.startTime.toFixed(1) + 's';
        document.getElementById('trim-end-display').textContent = clip.endTime.toFixed(1) + 's';
        document.getElementById('trim-duration-badge').textContent = Math.max(0, clip.endTime - clip.startTime).toFixed(1) + 's selected';
        // Update total duration across all clips
        var total = 0;
        clips.forEach(function(c) { total += Math.max(0, (c.endTime || c.duration) - (c.startTime || 0)); });
        var el = document.getElementById('trim-total-duration');
        if (el) el.textContent = total.toFixed(1) + 's';
    }

    function updatePlayhead() { var v = document.getElementById('trim-video'); document.getElementById('timeline-playhead').style.left = 'calc(' + timeToPercent(v.currentTime) + '% - 1.5px)'; }

    function renderTicks() {
        var ticks = document.getElementById('timeline-ticks');
        var count = Math.min(10, Math.max(3, Math.floor(timelineDuration / 5))); var html = '';
        for (var i = 0; i <= count; i++) html += '<span>' + ((timelineDuration / count) * i).toFixed(1) + 's</span>';
        ticks.innerHTML = html;
    }

    function initTimeline() {
        var track = document.getElementById('timeline-track'), hs = document.getElementById('handle-start'), he = document.getElementById('handle-end'), v = document.getElementById('trim-video');
        v.addEventListener('timeupdate', updatePlayhead);
        track.addEventListener('click', function(e) { if (!dragging) v.currentTime = percentToTime(xToPercent(e.clientX)); });
        hs.addEventListener('mousedown', function(e) { e.preventDefault(); e.stopPropagation(); dragging = 'start'; });
        hs.addEventListener('touchstart', function(e) { e.preventDefault(); e.stopPropagation(); dragging = 'start'; }, { passive: false });
        he.addEventListener('mousedown', function(e) { e.preventDefault(); e.stopPropagation(); dragging = 'end'; });
        he.addEventListener('touchstart', function(e) { e.preventDefault(); e.stopPropagation(); dragging = 'end'; }, { passive: false });
        function onMove(cx) {
            if (!dragging) return; var clip = clips[currentTrimIndex]; if (!clip) return;
            var t = Math.round(percentToTime(xToPercent(cx)) * 10) / 10;
            if (dragging === 'start') { clip.startTime = Math.max(0, Math.min(t, clip.endTime - 0.5)); v.currentTime = clip.startTime; }
            else { clip.endTime = Math.min(timelineDuration, Math.max(t, clip.startTime + 0.5)); v.currentTime = clip.endTime; }
            updateTimelineUI();
        }
        document.addEventListener('mousemove', function(e) { onMove(e.clientX); });
        document.addEventListener('touchmove', function(e) { if (dragging && e.touches.length) onMove(e.touches[0].clientX); }, { passive: true });
        document.addEventListener('mouseup', function() { dragging = null; });
        document.addEventListener('touchend', function() { dragging = null; });
    }

    function saveTrimState() { var c = clips[currentTrimIndex]; if (c) c.label = document.getElementById('trim-label').value.trim(); }

    function initTrimControls() {
        document.getElementById('btn-trim-prev').addEventListener('click', function() { saveTrimState(); if (currentTrimIndex > 0) showTrimClip(currentTrimIndex - 1); });
        document.getElementById('btn-trim-next').addEventListener('click', function() {
            saveTrimState();
            if (currentTrimIndex < clips.length - 1) showTrimClip(currentTrimIndex + 1);
            else { goToStep(3); renderOrderList(); renderPreview('preview-dash'); }
        });
        document.getElementById('trim-label').addEventListener('input', function() { saveTrimState(); renderPreview('preview-trim'); });
        document.getElementById('btn-trim-back-upload').addEventListener('click', function() {
            saveTrimState();
            var v = document.getElementById('trim-video'); v.pause(); v.src = '';
            goToStep(1); renderClipList(); updateNextButton();
        });
    }

    // ==================== DASHBOARD ====================
    function renderOrderList() {
        var list = document.getElementById('order-list'); var html = ''; var totalDur = 0;
        clips.forEach(function(clip, i) {
            var num = clips.length - i; var dur = Math.max(0, clip.endTime - clip.startTime); totalDur += dur;
            html += '<div class="clip-item" draggable="true" data-index="' + i + '">';
            html += '<span class="drag-handle" title="Drag to reorder">&#10495;</span>';
            html += '<div class="clip-num">' + num + '</div>';
            html += '<div class="clip-info"><div class="dash-row">';
            html += '<div class="dash-label"><input type="text" class="label-input" value="' + (clip.label || '').replace(/"/g, '&quot;') + '" placeholder="Label..." maxlength="30" data-label-idx="' + i + '"></div>';
            html += '<div class="dash-dur"><input type="number" value="' + dur.toFixed(1) + '" min="0.5" max="' + clip.originalDuration.toFixed(1) + '" step="0.1" data-dur-idx="' + i + '"><label>sec</label></div>';
            html += '</div><div class="clip-meta" style="margin-top:0.25rem">' + (clip.originalName || clip.filename) + '</div></div>';
            html += '<div class="move-btns"><button onclick="window._rk.moveUp(' + i + ')" title="Move up">&#9650;</button><button onclick="window._rk.moveDown(' + i + ')" title="Move down">&#9660;</button></div>';
            html += '<div class="clip-actions"><button onclick="window._rk.retrim(' + i + ')" title="Re-trim">&#9986;</button></div>';
            html += '</div>';
        });
        list.innerHTML = html;
        document.getElementById('total-duration').textContent = totalDur.toFixed(1) + 's';
        document.getElementById('total-clips').textContent = clips.length;

        list.querySelectorAll('[data-label-idx]').forEach(function(input) {
            input.addEventListener('input', function() { var idx = parseInt(input.dataset.labelIdx); if (clips[idx]) clips[idx].label = input.value.trim(); renderPreview('preview-dash'); });
        });
        list.querySelectorAll('[data-dur-idx]').forEach(function(input) {
            input.addEventListener('change', function() {
                var idx = parseInt(input.dataset.durIdx); if (!clips[idx]) return;
                var nd = Math.max(0.5, Math.min(parseFloat(input.value) || 0, clips[idx].originalDuration)); input.value = nd.toFixed(1);
                clips[idx].endTime = clips[idx].startTime + nd;
                if (clips[idx].endTime > clips[idx].originalDuration) { clips[idx].endTime = clips[idx].originalDuration; clips[idx].startTime = Math.max(0, clips[idx].endTime - nd); }
                var td = 0; clips.forEach(function(c) { td += Math.max(0, c.endTime - c.startTime); });
                document.getElementById('total-duration').textContent = td.toFixed(1) + 's';
            });
        });
        initDragReorder(list);
    }

    function initDragReorder(list) {
        var dragItem = null;
        list.querySelectorAll('.clip-item').forEach(function(item) {
            item.addEventListener('dragstart', function(e) { dragItem = item; item.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
            item.addEventListener('dragend', function() { item.classList.remove('dragging'); dragItem = null; });
            item.addEventListener('dragover', function(e) { e.preventDefault(); });
            item.addEventListener('drop', function(e) {
                e.preventDefault(); if (!dragItem || dragItem === item) return;
                var moved = clips.splice(parseInt(dragItem.dataset.index), 1)[0];
                clips.splice(parseInt(item.dataset.index), 0, moved);
                renderOrderList(); renderPreview('preview-dash');
            });
        });
    }

    function initTitleControls() {
        document.getElementById('title-text').addEventListener('input', function() { renderPreview('preview-dash'); });
        document.getElementById('title-highlight').addEventListener('input', function() { renderPreview('preview-dash'); });
        document.getElementById('btn-back-trim').addEventListener('click', function() { goToStep(2); showTrimClip(clips.length - 1); });
        // Commentary toggle — update assemble button cost + show/hide voice picker + subtitle settings
        document.getElementById('commentary-toggle').addEventListener('change', function() {
            var cost = this.checked ? 7 : 2;
            document.getElementById('btn-assemble').textContent = 'Assemble Video (' + cost + ' 💎)';
            document.getElementById('voice-picker').style.display = this.checked ? '' : 'none';
            document.getElementById('subtitle-settings').style.display = this.checked ? '' : 'none';
        });
        // Color palette
        document.querySelectorAll('.color-swatch').forEach(function(btn) {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.color-swatch').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                colorPalette = btn.dataset.color;
                renderPreview('preview-dash');
            });
        });
        // Checkered mode
        document.getElementById('checkered-toggle').addEventListener('change', function() {
            checkeredMode = this.checked;
            renderPreview('preview-dash');
        });
        // Subtitle Y position slider
        var subYEl = document.getElementById('subtitle-y');
        var subYVal = document.getElementById('subtitle-y-val');
        if (subYEl) {
            subYEl.addEventListener('input', function() {
                subYVal.textContent = subYEl.value + '%';
            });
        }
        // Subtitle color swatches
        var subColorMap = { yellow: '#facc15', white: '#ffffff', cyan: '#22d3ee', green: '#34d399', red: '#f87171', pink: '#f472b6', orange: '#fb923c' };
        document.querySelectorAll('.sub-color-swatch').forEach(function(btn) {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.sub-color-swatch').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                subtitleColor = btn.dataset.color;
                // Update preview text color
                var preview = document.getElementById('subtitle-preview');
                if (preview) preview.style.color = subColorMap[subtitleColor] || '#facc15';
            });
        });
        // Subtitle font change updates preview
        var subFontEl = document.getElementById('subtitle-font');
        if (subFontEl) {
            subFontEl.addEventListener('change', function() {
                var preview = document.getElementById('subtitle-preview');
                if (preview) preview.style.fontFamily = subFontEl.value;
            });
        }
    }

    // ==================== POSITION CONTROLS ====================
    function initPositionControls() {
        function bind(id, key) {
            var el = document.getElementById(id);
            var valEl = document.getElementById(id + '-val');
            if (!el) return;
            el.value = layout[key];
            valEl.textContent = (key === 'titleSize') ? layout[key] : layout[key] + '%';
            el.addEventListener('input', function() {
                layout[key] = parseInt(el.value);
                valEl.textContent = (key === 'titleSize') ? layout[key] : layout[key] + '%';
                renderPreview('preview-dash');
            });
        }
        bind('pos-list-x', 'listX');
        bind('pos-title-y', 'titleY');
        bind('pos-title-size', 'titleSize');
    }

    // ==================== LIVE PREVIEW ====================
    function renderPreview(targetId) {
        var el = document.getElementById(targetId); if (!el) return;
        var isTrim = (targetId === 'preview-trim');
        var titleText = (document.getElementById('title-text') || {}).value || '';
        var hlWord = (document.getElementById('title-highlight') || {}).value || '';
        var totalClips = clips.filter(function(c) { return !c.uploading; }).length;

        // Color map for palettes
        var colorMap = {
            yellow: { active: '#facc15', done: '#ccaa00', hl: '#facc15' },
            cyan: { active: '#22d3ee', done: '#0e9ab5', hl: '#22d3ee' },
            green: { active: '#34d399', done: '#1a9a6e', hl: '#34d399' },
            red: { active: '#f87171', done: '#c44040', hl: '#f87171' },
            pink: { active: '#f472b6', done: '#c44a8a', hl: '#f472b6' },
            orange: { active: '#fb923c', done: '#c86a20', hl: '#fb923c' },
            white: { active: '#ffffff', done: '#cccccc', hl: '#ffffff' }
        };
        var colors = colorMap[colorPalette] || colorMap.yellow;

        if (totalClips < 1) {
            el.innerHTML = '<div class="pv-bg"></div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#555;font-size:0.65rem;text-align:center;padding:1rem">Upload clips to see preview</div>';
            return;
        }

        var html = '<div class="pv-bars top"></div><div class="pv-bars bottom"></div><div class="pv-bg"></div>';

        // Title — position and size from layout
        var titleYPct = layout.titleY;
        var titleFontRem = (layout.titleSize / 48) * 0.7;
        if (titleText) {
            var titleHtml = escapeHtml(titleText);
            if (hlWord) {
                var re = new RegExp('(' + escapeRegex(hlWord) + ')', 'i');
                titleHtml = titleHtml.replace(re, '<span style="color:' + colors.hl + '">$1</span>');
            }
            html += '<div class="pv-title" style="top:' + titleYPct + '%"><div class="pv-title-text" style="font-size:' + titleFontRem.toFixed(2) + 'rem">' + titleHtml + '</div></div>';
        }

        var listXPct = layout.listX;
        html += '<div class="pv-list" style="left:' + listXPct + '%">';

        for (var row = 0; row < totalClips; row++) {
            var num = row + 1;
            var clipIdx = totalClips - num;
            var clip = clips[clipIdx];
            var label = (clip && clip.label) || '';

            var numClass = 'dim';
            var labelClass = 'dim';
            var numColor = '';

            if (isTrim) {
                if (clipIdx < currentTrimIndex) { numClass = 'done'; labelClass = ''; }
                else if (clipIdx === currentTrimIndex) { numClass = 'active'; labelClass = ''; }
            } else {
                numClass = 'done'; labelClass = '';
            }

            // Apply color palette
            if (numClass === 'active') {
                numColor = 'color:' + colors.active + ';';
            } else if (numClass === 'done') {
                // Checkered mode: alternate between palette color and white
                if (checkeredMode) {
                    numColor = (row % 2 === 0) ? 'color:' + colors.done + ';' : 'color:#ffffff;';
                } else {
                    numColor = 'color:' + colors.done + ';';
                }
            }

            html += '<div class="pv-row"><div class="pv-num ' + numClass + '" style="' + numColor + '">' + num + '.</div><div class="pv-label ' + labelClass + '">' + escapeHtml(label) + '</div></div>';
        }
        html += '</div>';

        if (isTrim && clips[currentTrimIndex]) {
            html += '<div class="pv-clip-label">' + escapeHtml(clips[currentTrimIndex].originalName || '') + '</div>';
        }

        el.innerHTML = html;
    }

    function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\' + '$' + '&'); }

    // ==================== ASSEMBLE ====================
    async function assembleVideo() {
        var btn = document.getElementById('btn-assemble');
        var enableCommentary = document.getElementById('commentary-toggle').checked;
        btn.disabled = true; btn.textContent = 'Trimming clips...';
        goToStep(4);
        var pf = document.getElementById('progress-fill'), pt = document.getElementById('progress-text');
        pf.style.width = '0%'; pt.textContent = 'Trimming clips...';
        document.getElementById('assembly-progress').classList.remove('hidden');

        try {
            var trimmedClips = [];
            for (var i = 0; i < clips.length; i++) {
                var clip = clips[i];
                pf.style.width = Math.round(((i + 1) / clips.length) * 30) + '%';
                pt.textContent = 'Trimming clip ' + (i + 1) + ' of ' + clips.length + '...';
                var needsTrim = clip.startTime > 0.1 || Math.abs(clip.endTime - clip.originalDuration) > 0.1;
                var filename = clip.filename;
                if (needsTrim) {
                    var tr = await apiFetch('/api/studio/ranking/trim', {
                        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
                        body: JSON.stringify({ filename: clip.filename, startTime: clip.startTime, endTime: clip.endTime })
                    });
                    var td = await tr.json(); if (!td.success) throw new Error(td.error || 'Trim failed'); filename = td.filename;
                }
                trimmedClips.push({ filename: filename, number: clips.length - i, label: clip.label || '' });
            }

            pf.style.width = '40%';
            pt.textContent = enableCommentary ? 'Generating AI commentary... this may take a minute' : 'Assembling ranking video...';

            var selectedVoice = document.getElementById('voice-picker').value || 'Kore';
            var selectedFont = document.getElementById('subtitle-font').value || 'Arial';
            var selectedSubY = parseInt(document.getElementById('subtitle-y').value) || 55;
            var aRes = await apiFetch('/api/studio/ranking/assemble', {
                method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
                body: JSON.stringify({
                    clips: trimmedClips,
                    title: { text: document.getElementById('title-text').value || '', highlightWord: document.getElementById('title-highlight').value || '' },
                    layout: { listXPercent: layout.listX, titleYPercent: layout.titleY, titleFontSize: layout.titleSize },
                    commentary: enableCommentary,
                    voiceName: selectedVoice,
                    colorPalette: colorPalette,
                    checkeredMode: checkeredMode,
                    subtitleFont: selectedFont,
                    subtitleY: selectedSubY,
                    subtitleColor: subtitleColor
                })
            });
            var aData = await aRes.json(); if (!aData.success) throw new Error(aData.error || 'Assembly failed');
            pf.style.width = '100%'; pt.textContent = 'Done!';
            setTimeout(function() { showResult(aData); }, 400);
            loadCredits();
        } catch (err) {
            pf.style.width = '0%'; pt.textContent = 'Error: ' + err.message;
            var cost = enableCommentary ? 7 : 2;
            btn.disabled = false; btn.textContent = 'Assemble Video (' + cost + ' 💎)'; loadCredits();
        }
    }

    function showResult(data) {
        document.getElementById('assembly-progress').classList.add('hidden');
        var v = document.getElementById('result-video'); v.src = data.videoUrl; v.classList.remove('hidden'); v.load();
        document.getElementById('result-info').textContent = data.clipCount + ' clips, ' + data.duration.toFixed(1) + 's' + (data.hasCommentary ? ' (with commentary)' : '');
        document.getElementById('result-info').classList.remove('hidden');
        document.getElementById('result-actions').classList.remove('hidden');
        document.getElementById('btn-download').href = data.videoUrl;
    }

    function moveUp(i) { if (i <= 0) return; var x = clips.splice(i, 1)[0]; clips.splice(i - 1, 0, x); renderOrderList(); renderPreview('preview-dash'); }
    function moveDown(i) { if (i >= clips.length - 1) return; var x = clips.splice(i, 1)[0]; clips.splice(i + 1, 0, x); renderOrderList(); renderPreview('preview-dash'); }
    function retrim(i) { currentTrimIndex = i; goToStep(2); showTrimClip(i); }

    // ==================== INIT ====================
    function init() {
        loadCredits(); initUpload(); initUrlImport(); initTimeline(); initPlayControls(); initTrimControls(); initTitleControls(); initPositionControls();
        document.getElementById('btn-next-trim').addEventListener('click', startTrimming);
        document.getElementById('btn-assemble').addEventListener('click', assembleVideo);
        document.getElementById('btn-new').addEventListener('click', function() {
            clips = []; currentTrimIndex = 0; layout = { listX: 5, titleY: 6, titleSize: 48 };
            colorPalette = 'yellow'; checkeredMode = false; subtitleColor = 'yellow';
            renderClipList(); updateNextButton();
            document.getElementById('title-text').value = ''; document.getElementById('title-highlight').value = '';
            document.getElementById('result-video').classList.add('hidden'); document.getElementById('result-info').classList.add('hidden');
            document.getElementById('result-actions').classList.add('hidden');
            document.getElementById('btn-assemble').disabled = false; document.getElementById('btn-assemble').textContent = 'Assemble Video (2 💎)';
            // Reset commentary toggle + voice picker
            document.getElementById('commentary-toggle').checked = false;
            document.getElementById('voice-picker').style.display = 'none';
            document.getElementById('voice-picker').value = 'Kore';
            document.getElementById('subtitle-settings').style.display = 'none';
            document.getElementById('subtitle-font').value = 'Arial';
            document.getElementById('subtitle-y').value = 55;
            document.getElementById('subtitle-y-val').textContent = '55%';
            // Reset subtitle color swatches
            document.querySelectorAll('.sub-color-swatch').forEach(function(b) { b.classList.remove('active'); });
            var defSubSwatch = document.querySelector('.sub-color-swatch[data-color="yellow"]');
            if (defSubSwatch) defSubSwatch.classList.add('active');
            var subPreview = document.getElementById('subtitle-preview');
            if (subPreview) { subPreview.style.color = '#facc15'; subPreview.style.fontFamily = 'Arial'; }
            // Reset checkered toggle
            document.getElementById('checkered-toggle').checked = false;
            // Reset color swatches
            document.querySelectorAll('.color-swatch').forEach(function(b) { b.classList.remove('active'); });
            var defSwatch = document.querySelector('.color-swatch[data-color="yellow"]');
            if (defSwatch) defSwatch.classList.add('active');
            // Reset sliders
            ['pos-list-x','pos-title-y','pos-title-size'].forEach(function(id) { var el = document.getElementById(id); if (el) el.dispatchEvent(new Event('input')); });
            goToStep(1);
        });
        goToStep(1);
    }

    window._rk = { remove: removeClip, moveUp: moveUp, moveDown: moveDown, retrim: retrim };
    init();
})();
