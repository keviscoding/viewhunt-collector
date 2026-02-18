/**
 * Ranking Video — Frontend App
 * Upload clips → Trim with visual timeline → Title/Order → Assemble
 * Includes live overlay preview (pure HTML/CSS, no server calls)
 */
(function() {
    'use strict';

    // --- State ---
    var clips = [];
    var currentTrimIndex = 0;
    var currentStep = 1;
    var dragging = null;
    var timelineDuration = 0;

    // --- Auth ---
    function getToken() {
        return localStorage.getItem('viewhunt_token') || localStorage.getItem('token') || null;
    }
    function authHeaders() {
        return { 'Authorization': 'Bearer ' + getToken() };
    }
    async function apiFetch(url, opts) {
        opts = opts || {};
        opts.headers = Object.assign({}, opts.headers || {}, authHeaders());
        var res = await fetch(url, opts);
        if (res.status === 401 || res.status === 403) {
            window.location.replace('/');
            throw new Error('Auth failed');
        }
        return res;
    }

    // --- Credits ---
    async function loadCredits() {
        try {
            var res = await apiFetch('/api/studio/credits/balance');
            var data = await res.json();
            document.getElementById('credit-balance').textContent = (data.totalAvailable || 0);
        } catch (e) { console.warn('Credits:', e); }
    }

    // --- Step navigation ---
    function goToStep(step) {
        currentStep = step;
        ['screen-upload','screen-trim','screen-title','screen-result'].forEach(function(id, i) {
            var el = document.getElementById(id);
            if (i + 1 === step) el.classList.remove('hidden');
            else el.classList.add('hidden');
        });
        for (var i = 1; i <= 4; i++) {
            var s = document.getElementById('step-' + i);
            s.className = 'step';
            if (i < step) s.classList.add('done');
            else if (i === step) s.classList.add('active');
        }
    }

    // ==================== STEP 1: UPLOAD ====================
    function initUpload() {
        var zone = document.getElementById('upload-zone');
        var input = document.getElementById('file-input');
        zone.addEventListener('click', function() { input.click(); });
        zone.addEventListener('dragover', function(e) { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', function() { zone.classList.remove('dragover'); });
        zone.addEventListener('drop', function(e) {
            e.preventDefault(); zone.classList.remove('dragover');
            if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
        });
        input.addEventListener('change', function() {
            if (input.files.length) handleFiles(input.files);
            input.value = '';
        });
    }

    async function handleFiles(fileList) {
        for (var i = 0; i < fileList.length && clips.length < 10; i++) {
            var file = fileList[i];
            if (!file.type.startsWith('video/')) continue;
            await uploadFile(file);
        }
        if (clips.length >= 10) alert('Maximum 10 clips reached');
    }

    async function uploadFile(file) {
        if (file.size > 50 * 1024 * 1024) {
            alert('File too large: ' + file.name + ' (' + (file.size / 1024 / 1024).toFixed(1) + 'MB). Maximum 50MB per clip.');
            return;
        }
        var tempId = 'up-' + Date.now() + Math.random();
        clips.push({ _tempId: tempId, uploading: true, uploadPct: 0, originalName: file.name, filename: null, url: null, duration: 0, originalDuration: 0, label: '', startTime: 0, endTime: 0 });
        renderClipList();

        return new Promise(function(resolve) {
            var fd = new FormData();
            fd.append('clip', file);
            var xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/studio/ranking/upload');
            xhr.setRequestHeader('Authorization', 'Bearer ' + getToken());

            xhr.upload.onprogress = function(e) {
                if (e.lengthComputable) {
                    var pct = Math.round((e.loaded / e.total) * 100);
                    var idx = clips.findIndex(function(c) { return c._tempId === tempId; });
                    if (idx >= 0) { clips[idx].uploadPct = pct; renderClipList(); }
                }
            };
            xhr.onload = function() {
                try {
                    var data = JSON.parse(xhr.responseText);
                    if (xhr.status >= 200 && xhr.status < 300 && data.success) {
                        var idx = clips.findIndex(function(c) { return c._tempId === tempId; });
                        if (idx >= 0) {
                            clips[idx] = {
                                filename: data.filename, url: data.url,
                                duration: data.duration, originalDuration: data.duration,
                                label: '', startTime: 0, endTime: data.duration,
                                originalName: file.name, uploading: false
                            };
                        }
                    } else {
                        clips = clips.filter(function(c) { return c._tempId !== tempId; });
                        alert('Upload failed: ' + (data.error || 'Server error'));
                    }
                } catch (e) {
                    clips = clips.filter(function(c) { return c._tempId !== tempId; });
                    alert('Upload failed: Could not parse response');
                }
                renderClipList(); updateNextButton(); resolve();
            };
            xhr.onerror = function() {
                clips = clips.filter(function(c) { return c._tempId !== tempId; });
                alert('Upload failed: Network error. Try a smaller file (under 50MB).');
                renderClipList(); updateNextButton(); resolve();
            };
            xhr.ontimeout = function() {
                clips = clips.filter(function(c) { return c._tempId !== tempId; });
                alert('Upload timed out. Try a smaller file.');
                renderClipList(); updateNextButton(); resolve();
            };
            xhr.timeout = 120000;
            xhr.send(fd);
        });
    }

    function renderClipList() {
        var list = document.getElementById('clip-list');
        var html = '';
        clips.forEach(function(clip, i) {
            html += '<div class="clip-item"><div class="clip-num">' + (i + 1) + '</div><div class="clip-info">';
            if (clip.uploading) {
                html += '<div class="clip-name">⏳ Uploading ' + (clip.originalName || '') + ' (' + (clip.uploadPct || 0) + '%)</div>';
            } else {
                html += '<div class="clip-name">' + (clip.originalName || clip.filename) + '</div>';
                html += '<div class="clip-meta">' + clip.duration.toFixed(1) + 's</div>';
            }
            html += '</div>';
            if (!clip.uploading) {
                html += '<div class="clip-actions"><button onclick="window._rk.remove(' + i + ')" class="danger" title="Remove">✕</button></div>';
            }
            html += '</div>';
        });
        list.innerHTML = html;
    }

    function updateNextButton() {
        var ready = clips.filter(function(c) { return !c.uploading && c.filename; });
        document.getElementById('btn-next-trim').disabled = ready.length < 2;
    }

    function removeClip(index) {
        var clip = clips[index];
        if (clip && clip.filename) apiFetch('/api/studio/ranking/clip/' + clip.filename, { method: 'DELETE' }).catch(function(){});
        clips.splice(index, 1);
        renderClipList(); updateNextButton();
    }

    // ==================== STEP 2: TRIM WITH TIMELINE ====================
    function startTrimming() {
        currentTrimIndex = 0;
        goToStep(2);
        showTrimClip(0);
    }

    function showTrimClip(index) {
        currentTrimIndex = index;
        var clip = clips[index];
        if (!clip) return;

        document.getElementById('trim-clip-num').textContent = (index + 1);
        document.getElementById('trim-total').textContent = clips.length;

        var video = document.getElementById('trim-video');
        video.src = clip.url;
        video.load();
        updatePlayOverlay();

        timelineDuration = clip.originalDuration || clip.duration;
        document.getElementById('trim-label').value = clip.label || '';

        video.onloadedmetadata = function() {
            timelineDuration = video.duration || clip.duration;
            if (clip.endTime === 0 || clip.endTime > timelineDuration) clip.endTime = timelineDuration;
            updateTimelineUI();
            renderTicks();
            video.currentTime = clip.startTime;
        };

        document.getElementById('btn-trim-prev').style.display = index === 0 ? 'none' : '';
        document.getElementById('btn-trim-next').textContent = index === clips.length - 1 ? 'Next: Dashboard →' : 'Next Clip →';
        renderPreview('preview-trim');
    }

    // --- Play/Pause ---
    function togglePlay() {
        var video = document.getElementById('trim-video');
        if (video.paused) { video.play(); } else { video.pause(); }
    }

    function updatePlayOverlay() {
        var video = document.getElementById('trim-video');
        var overlay = document.getElementById('play-overlay');
        if (!overlay) return;
        if (video.paused || video.ended) {
            overlay.classList.remove('is-playing');
        } else {
            overlay.classList.add('is-playing');
        }
    }

    function initPlayControls() {
        var wrap = document.getElementById('trim-video-wrap');
        var video = document.getElementById('trim-video');
        wrap.addEventListener('click', function(e) {
            // Don't toggle if clicking handles
            if (e.target.closest('.timeline-handle')) return;
            togglePlay();
        });
        video.addEventListener('play', updatePlayOverlay);
        video.addEventListener('pause', updatePlayOverlay);
        video.addEventListener('ended', updatePlayOverlay);
    }

    // --- Timeline ---
    function getTrackRect() { return document.getElementById('timeline-track').getBoundingClientRect(); }
    function timeToPercent(t) { return timelineDuration <= 0 ? 0 : Math.max(0, Math.min(100, (t / timelineDuration) * 100)); }
    function percentToTime(pct) { return Math.max(0, Math.min(timelineDuration, (pct / 100) * timelineDuration)); }
    function xToPercent(clientX) { var r = getTrackRect(); return Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)); }

    function updateTimelineUI() {
        var clip = clips[currentTrimIndex];
        if (!clip) return;
        var startPct = timeToPercent(clip.startTime);
        var endPct = timeToPercent(clip.endTime);
        document.getElementById('timeline-fill').style.left = startPct + '%';
        document.getElementById('timeline-fill').style.width = (endPct - startPct) + '%';
        document.getElementById('handle-start').style.left = 'calc(' + startPct + '% - 7px)';
        document.getElementById('handle-end').style.left = 'calc(' + endPct + '% - 7px)';
        document.getElementById('trim-start-display').textContent = clip.startTime.toFixed(1) + 's';
        document.getElementById('trim-end-display').textContent = clip.endTime.toFixed(1) + 's';
        document.getElementById('trim-duration-badge').textContent = Math.max(0, clip.endTime - clip.startTime).toFixed(1) + 's selected';
    }

    function updatePlayhead() {
        var video = document.getElementById('trim-video');
        var pct = timeToPercent(video.currentTime);
        document.getElementById('timeline-playhead').style.left = 'calc(' + pct + '% - 1.5px)';
    }

    function renderTicks() {
        var ticks = document.getElementById('timeline-ticks');
        var count = Math.min(10, Math.max(3, Math.floor(timelineDuration / 5)));
        var html = '';
        for (var i = 0; i <= count; i++) {
            html += '<span>' + ((timelineDuration / count) * i).toFixed(1) + 's</span>';
        }
        ticks.innerHTML = html;
    }

    function initTimeline() {
        var track = document.getElementById('timeline-track');
        var handleStart = document.getElementById('handle-start');
        var handleEnd = document.getElementById('handle-end');
        var video = document.getElementById('trim-video');

        video.addEventListener('timeupdate', updatePlayhead);

        track.addEventListener('click', function(e) {
            if (dragging) return;
            var t = percentToTime(xToPercent(e.clientX));
            video.currentTime = t;
        });

        handleStart.addEventListener('mousedown', function(e) { e.preventDefault(); e.stopPropagation(); dragging = 'start'; });
        handleStart.addEventListener('touchstart', function(e) { e.preventDefault(); e.stopPropagation(); dragging = 'start'; }, { passive: false });
        handleEnd.addEventListener('mousedown', function(e) { e.preventDefault(); e.stopPropagation(); dragging = 'end'; });
        handleEnd.addEventListener('touchstart', function(e) { e.preventDefault(); e.stopPropagation(); dragging = 'end'; }, { passive: false });

        function onMove(clientX) {
            if (!dragging) return;
            var clip = clips[currentTrimIndex];
            if (!clip) return;
            var t = Math.round(percentToTime(xToPercent(clientX)) * 10) / 10;
            if (dragging === 'start') {
                clip.startTime = Math.max(0, Math.min(t, clip.endTime - 0.5));
                video.currentTime = clip.startTime;
            } else if (dragging === 'end') {
                clip.endTime = Math.min(timelineDuration, Math.max(t, clip.startTime + 0.5));
                video.currentTime = clip.endTime;
            }
            updateTimelineUI();
        }

        document.addEventListener('mousemove', function(e) { onMove(e.clientX); });
        document.addEventListener('touchmove', function(e) { if (dragging && e.touches.length) onMove(e.touches[0].clientX); }, { passive: true });
        document.addEventListener('mouseup', function() { dragging = null; });
        document.addEventListener('touchend', function() { dragging = null; });
    }

    function saveTrimState() {
        var clip = clips[currentTrimIndex];
        if (!clip) return;
        clip.label = document.getElementById('trim-label').value.trim();
    }

    function initTrimControls() {
        document.getElementById('btn-trim-prev').addEventListener('click', function() {
            saveTrimState();
            if (currentTrimIndex > 0) showTrimClip(currentTrimIndex - 1);
        });
        document.getElementById('btn-trim-next').addEventListener('click', function() {
            saveTrimState();
            if (currentTrimIndex < clips.length - 1) {
                showTrimClip(currentTrimIndex + 1);
            } else {
                goToStep(3);
                renderOrderList();
                renderPreview('preview-dash');
            }
        });
        // Update preview when label changes
        document.getElementById('trim-label').addEventListener('input', function() {
            saveTrimState();
            renderPreview('preview-trim');
        });
    }

    // ==================== STEP 3: DASHBOARD ====================
    function renderOrderList() {
        var list = document.getElementById('order-list');
        var html = '';
        var totalDur = 0;
        clips.forEach(function(clip, i) {
            var num = clips.length - i;
            var dur = Math.max(0, clip.endTime - clip.startTime);
            totalDur += dur;
            html += '<div class="clip-item" draggable="true" data-index="' + i + '">';
            html += '<span class="drag-handle" title="Drag to reorder">⠿</span>';
            html += '<div class="clip-num">' + num + '</div>';
            html += '<div class="clip-info"><div class="dash-row">';
            html += '<div class="dash-label"><input type="text" class="label-input" value="' + (clip.label || '').replace(/"/g, '&quot;') + '" placeholder="Label..." maxlength="30" data-label-idx="' + i + '"></div>';
            html += '<div class="dash-dur"><input type="number" value="' + dur.toFixed(1) + '" min="0.5" max="' + clip.originalDuration.toFixed(1) + '" step="0.1" data-dur-idx="' + i + '"><label>sec</label></div>';
            html += '</div>';
            html += '<div class="clip-meta" style="margin-top:0.25rem">' + (clip.originalName || clip.filename) + '</div>';
            html += '</div>';
            html += '<div class="move-btns">';
            html += '<button onclick="window._rk.moveUp(' + i + ')" title="Move up">&#9650;</button>';
            html += '<button onclick="window._rk.moveDown(' + i + ')" title="Move down">&#9660;</button>';
            html += '</div>';
            html += '<div class="clip-actions"><button onclick="window._rk.retrim(' + i + ')" title="Re-trim">&#9986;</button></div>';
            html += '</div>';
        });
        list.innerHTML = html;
        document.getElementById('total-duration').textContent = totalDur.toFixed(1) + 's';
        document.getElementById('total-clips').textContent = clips.length;

        // Bind label change → update preview
        list.querySelectorAll('[data-label-idx]').forEach(function(input) {
            input.addEventListener('input', function() {
                var idx = parseInt(input.dataset.labelIdx);
                if (clips[idx]) clips[idx].label = input.value.trim();
                renderPreview('preview-dash');
            });
        });
        // Bind duration change
        list.querySelectorAll('[data-dur-idx]').forEach(function(input) {
            input.addEventListener('change', function() {
                var idx = parseInt(input.dataset.durIdx);
                if (!clips[idx]) return;
                var newDur = Math.max(0.5, Math.min(parseFloat(input.value) || 0, clips[idx].originalDuration));
                input.value = newDur.toFixed(1);
                clips[idx].endTime = clips[idx].startTime + newDur;
                if (clips[idx].endTime > clips[idx].originalDuration) {
                    clips[idx].endTime = clips[idx].originalDuration;
                    clips[idx].startTime = Math.max(0, clips[idx].endTime - newDur);
                }
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
                e.preventDefault();
                if (!dragItem || dragItem === item) return;
                var moved = clips.splice(parseInt(dragItem.dataset.index), 1)[0];
                clips.splice(parseInt(item.dataset.index), 0, moved);
                renderOrderList();
                renderPreview('preview-dash');
            });
        });
    }

    function initTitleControls() {
        document.getElementById('title-text').addEventListener('input', function() { renderPreview('preview-dash'); });
        document.getElementById('title-highlight').addEventListener('input', function() { renderPreview('preview-dash'); });
        document.getElementById('btn-back-trim').addEventListener('click', function() {
            goToStep(2);
            showTrimClip(clips.length - 1);
        });
    }

    // ==================== LIVE PREVIEW RENDERER ====================
    /**
     * Renders a pure HTML/CSS mock of the final video overlay.
     * Shows: title (with highlight), all numbers stacked, labels.
     * On trim step: highlights the current clip being trimmed.
     * On dashboard step: shows all clips as "revealed" (final look).
     */
    function renderPreview(targetId) {
        var el = document.getElementById(targetId);
        if (!el) return;

        var isTrim = (targetId === 'preview-trim');
        var titleText = '';
        var hlWord = '';

        // On trim step, use whatever title was entered on dashboard (may be empty)
        var titleEl = document.getElementById('title-text');
        var hlEl = document.getElementById('title-highlight');
        if (titleEl) titleText = titleEl.value || '';
        if (hlEl) hlWord = hlEl.value || '';

        // Build number list (sorted descending — highest at top, #1 at bottom)
        var totalClips = clips.filter(function(c) { return !c.uploading; }).length;
        if (totalClips < 1) {
            el.innerHTML = '<div class="pv-bg"></div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#555;font-size:0.65rem;text-align:center;padding:1rem">Upload clips to see preview</div>';
            return;
        }

        var html = '';
        // Black bars
        html += '<div class="pv-bars top"></div>';
        html += '<div class="pv-bars bottom"></div>';
        // Gradient overlay
        html += '<div class="pv-bg"></div>';

        // Title
        if (titleText) {
            var titleHtml = escapeHtml(titleText);
            if (hlWord) {
                var re = new RegExp('(' + escapeRegex(hlWord) + ')', 'i');
                titleHtml = titleHtml.replace(re, '<span class="pv-hl">$1</span>');
            }
            html += '<div class="pv-title"><div class="pv-title-text">' + titleHtml + '</div></div>';
        }

        // Number list
        html += '<div class="pv-list">';
        for (var i = 0; i < totalClips; i++) {
            var num = totalClips - i; // descending: highest at top
            var clip = clips[i];
            var label = (clip && clip.label) || '';

            // Determine state for this number
            var numClass = 'dim';
            var labelClass = 'dim';

            if (isTrim) {
                // On trim: current clip is "active", previous clips are "done", future are "dim"
                if (i < currentTrimIndex) {
                    numClass = 'done';
                    labelClass = '';
                } else if (i === currentTrimIndex) {
                    numClass = 'active';
                    labelClass = '';
                }
            } else {
                // On dashboard: all clips are revealed (final look)
                numClass = 'done';
                labelClass = '';
            }

            html += '<div class="pv-row">';
            html += '<div class="pv-num ' + numClass + '">' + num + '.</div>';
            html += '<div class="pv-label ' + labelClass + '">' + escapeHtml(label) + '</div>';
            html += '</div>';
        }
        html += '</div>';

        // Current clip indicator
        if (isTrim && clips[currentTrimIndex]) {
            var cur = clips[currentTrimIndex];
            html += '<div class="pv-clip-label">▶ ' + escapeHtml(cur.originalName || cur.filename || '') + '</div>';
        }

        el.innerHTML = html;
    }

    function escapeHtml(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function escapeRegex(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\' + '$' + '&');
    }

    // ==================== STEP 4: ASSEMBLE ====================
    async function assembleVideo() {
        var btn = document.getElementById('btn-assemble');
        btn.disabled = true;
        btn.textContent = '⏳ Trimming clips...';

        goToStep(4);
        var progressFill = document.getElementById('progress-fill');
        var progressText = document.getElementById('progress-text');
        progressFill.style.width = '0%';
        progressText.textContent = 'Trimming clips...';
        document.getElementById('assembly-progress').classList.remove('hidden');

        try {
            var trimmedClips = [];
            for (var i = 0; i < clips.length; i++) {
                var clip = clips[i];
                var pct = Math.round(((i + 1) / clips.length) * 50);
                progressFill.style.width = pct + '%';
                progressText.textContent = 'Trimming clip ' + (i + 1) + ' of ' + clips.length + '...';

                var needsTrim = clip.startTime > 0.1 || Math.abs(clip.endTime - clip.originalDuration) > 0.1;
                var filename = clip.filename;

                if (needsTrim) {
                    var trimRes = await apiFetch('/api/studio/ranking/trim', {
                        method: 'POST',
                        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
                        body: JSON.stringify({ filename: clip.filename, startTime: clip.startTime, endTime: clip.endTime })
                    });
                    var trimData = await trimRes.json();
                    if (!trimData.success) throw new Error(trimData.error || 'Trim failed');
                    filename = trimData.filename;
                }
                trimmedClips.push({ filename: filename, number: clips.length - i, label: clip.label || '' });
            }

            progressFill.style.width = '60%';
            progressText.textContent = 'Assembling ranking video... keep this tab open';

            var title = {
                text: document.getElementById('title-text').value || '',
                highlightWord: document.getElementById('title-highlight').value || ''
            };

            var aRes = await apiFetch('/api/studio/ranking/assemble', {
                method: 'POST',
                headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
                body: JSON.stringify({ clips: trimmedClips, title: title })
            });
            var aData = await aRes.json();
            if (!aData.success) throw new Error(aData.error || 'Assembly failed');

            progressFill.style.width = '100%';
            progressText.textContent = 'Done!';
            setTimeout(function() { showResult(aData); }, 400);
            loadCredits();
        } catch (err) {
            progressFill.style.width = '0%';
            progressText.textContent = '❌ ' + err.message;
            if (err.message.includes('credits')) {
                progressText.textContent = '❌ Not enough credits. ' + err.message;
            }
            btn.disabled = false;
            btn.textContent = '🎬 Assemble Video (2 💎)';
            loadCredits();
        }
    }

    function showResult(data) {
        document.getElementById('assembly-progress').classList.add('hidden');
        var video = document.getElementById('result-video');
        video.src = data.videoUrl;
        video.classList.remove('hidden');
        video.load();
        document.getElementById('result-info').textContent = data.clipCount + ' clips · ' + data.duration.toFixed(1) + 's · 2 💎';
        document.getElementById('result-info').classList.remove('hidden');
        document.getElementById('result-actions').classList.remove('hidden');
        document.getElementById('btn-download').href = data.videoUrl;
    }

    // ==================== HELPERS ====================
    function moveUp(index) {
        if (index <= 0) return;
        var item = clips.splice(index, 1)[0];
        clips.splice(index - 1, 0, item);
        renderOrderList();
        renderPreview('preview-dash');
    }

    function moveDown(index) {
        if (index >= clips.length - 1) return;
        var item = clips.splice(index, 1)[0];
        clips.splice(index + 1, 0, item);
        renderOrderList();
        renderPreview('preview-dash');
    }

    function retrim(index) {
        currentTrimIndex = index;
        goToStep(2);
        showTrimClip(index);
    }

    // ==================== INIT ====================
    function init() {
        loadCredits();
        initUpload();
        initTimeline();
        initPlayControls();
        initTrimControls();
        initTitleControls();

        document.getElementById('btn-next-trim').addEventListener('click', startTrimming);
        document.getElementById('btn-assemble').addEventListener('click', assembleVideo);
        document.getElementById('btn-new').addEventListener('click', function() {
            clips = [];
            currentTrimIndex = 0;
            renderClipList();
            updateNextButton();
            document.getElementById('title-text').value = '';
            document.getElementById('title-highlight').value = '';
            document.getElementById('result-video').classList.add('hidden');
            document.getElementById('result-info').classList.add('hidden');
            document.getElementById('result-actions').classList.add('hidden');
            document.getElementById('btn-assemble').disabled = false;
            document.getElementById('btn-assemble').textContent = '🎬 Assemble Video (2 💎)';
            goToStep(1);
        });

        goToStep(1);
    }

    window._rk = { remove: removeClip, moveUp: moveUp, moveDown: moveDown, retrim: retrim };
    init();
})();
