/**
 * Ranking Video — Frontend App
 * Phase 1: Upload clips → Trim → Title/Order → Assemble
 */
(function() {
    'use strict';

    // --- State ---
    var clips = []; // [{ filename, url, duration, label, startTime, endTime, originalDuration }]
    var currentTrimIndex = 0;
    var currentStep = 1;

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

    // --- Credit balance ---
    async function loadCredits() {
        try {
            var res = await apiFetch('/api/studio/credits/balance');
            var data = await res.json();
            var el = document.getElementById('credit-balance');
            if (el) el.textContent = (data.totalAvailable || 0);
        } catch (e) { console.warn('Credits:', e); }
    }

    // --- Step navigation ---
    function goToStep(step) {
        currentStep = step;
        var screens = ['screen-upload', 'screen-trim', 'screen-title', 'screen-result'];
        screens.forEach(function(id, i) {
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

    // --- Upload ---
    function initUpload() {
        var zone = document.getElementById('upload-zone');
        var input = document.getElementById('file-input');

        zone.addEventListener('click', function() { input.click(); });

        zone.addEventListener('dragover', function(e) {
            e.preventDefault();
            zone.classList.add('dragover');
        });
        zone.addEventListener('dragleave', function() {
            zone.classList.remove('dragover');
        });
        zone.addEventListener('drop', function(e) {
            e.preventDefault();
            zone.classList.remove('dragover');
            if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
        });

        input.addEventListener('change', function() {
            if (input.files.length) handleFiles(input.files);
            input.value = '';
        });
    }

    async function handleFiles(fileList) {
        if (clips.length >= 10) {
            alert('Maximum 10 clips allowed');
            return;
        }

        for (var i = 0; i < fileList.length; i++) {
            if (clips.length >= 10) break;
            var file = fileList[i];
            if (!file.type.startsWith('video/')) continue;
            await uploadFile(file);
        }
        renderClipList();
        updateNextButton();
    }

    async function uploadFile(file) {
        var formData = new FormData();
        formData.append('clip', file);

        // Show uploading state
        var tempId = 'uploading-' + Date.now();
        clips.push({ _tempId: tempId, filename: null, url: null, duration: 0, label: '', startTime: 0, endTime: 0, originalName: file.name, uploading: true });
        renderClipList();

        try {
            var res = await apiFetch('/api/studio/ranking/upload', {
                method: 'POST',
                body: formData
            });
            var data = await res.json();
            if (!data.success) throw new Error(data.error || 'Upload failed');

            // Replace temp entry
            var idx = clips.findIndex(function(c) { return c._tempId === tempId; });
            if (idx >= 0) {
                clips[idx] = {
                    filename: data.filename,
                    url: data.url,
                    duration: data.duration,
                    originalDuration: data.duration,
                    label: '',
                    startTime: 0,
                    endTime: data.duration,
                    originalName: file.name,
                    uploading: false
                };
            }
        } catch (err) {
            // Remove failed upload
            clips = clips.filter(function(c) { return c._tempId !== tempId; });
            alert('Upload failed: ' + err.message);
        }

        renderClipList();
        updateNextButton();
    }

    function renderClipList() {
        var list = document.getElementById('clip-list');
        if (!list) return;
        var html = '';
        clips.forEach(function(clip, i) {
            html += '<div class="clip-item" data-index="' + i + '">';
            html += '<div class="clip-num">' + (i + 1) + '</div>';
            html += '<div class="clip-info">';
            if (clip.uploading) {
                html += '<div class="clip-name">⏳ Uploading...</div>';
                html += '<div class="clip-meta">' + (clip.originalName || '') + '</div>';
            } else {
                html += '<div class="clip-name">' + (clip.originalName || clip.filename) + '</div>';
                html += '<div class="clip-meta">' + clip.duration.toFixed(1) + 's</div>';
            }
            html += '</div>';
            if (!clip.uploading) {
                html += '<div class="clip-actions">';
                html += '<button onclick="window._rankingApp.removeClip(' + i + ')" class="danger" title="Remove">✕</button>';
                html += '</div>';
            }
            html += '</div>';
        });
        list.innerHTML = html;
    }

    function updateNextButton() {
        var btn = document.getElementById('btn-next-trim');
        var ready = clips.filter(function(c) { return !c.uploading && c.filename; });
        btn.disabled = ready.length < 2;
    }

    function removeClip(index) {
        var clip = clips[index];
        if (clip && clip.filename) {
            // Delete from server (fire and forget)
            apiFetch('/api/studio/ranking/clip/' + clip.filename, { method: 'DELETE' }).catch(function() {});
        }
        clips.splice(index, 1);
        renderClipList();
        updateNextButton();
    }

    // --- Trim ---
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

        document.getElementById('trim-start').value = clip.startTime || 0;
        document.getElementById('trim-end').value = clip.endTime || clip.duration;
        document.getElementById('trim-label').value = clip.label || '';
        updateTrimDuration();

        // Prev/next buttons
        document.getElementById('btn-trim-prev').style.display = index === 0 ? 'none' : '';
        var nextBtn = document.getElementById('btn-trim-next');
        nextBtn.textContent = index === clips.length - 1 ? 'Next: Title & Order →' : 'Next Clip →';
    }

    function saveTrimState() {
        var clip = clips[currentTrimIndex];
        if (!clip) return;
        clip.startTime = parseFloat(document.getElementById('trim-start').value) || 0;
        clip.endTime = parseFloat(document.getElementById('trim-end').value) || clip.duration;
        clip.label = document.getElementById('trim-label').value.trim();
    }

    function updateTrimDuration() {
        var s = parseFloat(document.getElementById('trim-start').value) || 0;
        var e = parseFloat(document.getElementById('trim-end').value) || 0;
        var dur = Math.max(0, e - s);
        document.getElementById('trim-duration').textContent = dur.toFixed(1) + 's';
    }

    function initTrimControls() {
        document.getElementById('btn-set-start').addEventListener('click', function() {
            var video = document.getElementById('trim-video');
            document.getElementById('trim-start').value = video.currentTime.toFixed(1);
            updateTrimDuration();
        });
        document.getElementById('btn-set-end').addEventListener('click', function() {
            var video = document.getElementById('trim-video');
            document.getElementById('trim-end').value = video.currentTime.toFixed(1);
            updateTrimDuration();
        });
        document.getElementById('trim-start').addEventListener('input', updateTrimDuration);
        document.getElementById('trim-end').addEventListener('input', updateTrimDuration);

        document.getElementById('btn-trim-prev').addEventListener('click', function() {
            saveTrimState();
            if (currentTrimIndex > 0) showTrimClip(currentTrimIndex - 1);
        });
        document.getElementById('btn-trim-next').addEventListener('click', function() {
            saveTrimState();
            if (currentTrimIndex < clips.length - 1) {
                showTrimClip(currentTrimIndex + 1);
            } else {
                // Done trimming → go to title/order
                goToStep(3);
                renderOrderList();
                updateTitlePreview();
            }
        });
    }

    // --- Title & Order ---
    function renderOrderList() {
        var list = document.getElementById('order-list');
        var html = '';
        clips.forEach(function(clip, i) {
            var num = clips.length - i; // Reverse: last clip = #1
            var trimDur = (clip.endTime - clip.startTime).toFixed(1);
            html += '<div class="clip-item" data-index="' + i + '">';
            html += '<span class="drag-handle" title="Drag to reorder">⠿</span>';
            html += '<div class="clip-num">' + num + '</div>';
            html += '<div class="clip-info">';
            html += '<div class="clip-name">' + (clip.label || clip.originalName || clip.filename) + '</div>';
            html += '<div class="clip-meta">' + trimDur + 's clip</div>';
            html += '</div>';
            html += '</div>';
        });
        list.innerHTML = html;
        initDragReorder(list);
    }

    function initDragReorder(list) {
        var items = list.querySelectorAll('.clip-item');
        var dragItem = null;

        items.forEach(function(item) {
            item.draggable = true;
            item.addEventListener('dragstart', function(e) {
                dragItem = item;
                item.style.opacity = '0.5';
                e.dataTransfer.effectAllowed = 'move';
            });
            item.addEventListener('dragend', function() {
                item.style.opacity = '1';
                dragItem = null;
            });
            item.addEventListener('dragover', function(e) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });
            item.addEventListener('drop', function(e) {
                e.preventDefault();
                if (!dragItem || dragItem === item) return;
                var fromIdx = parseInt(dragItem.dataset.index);
                var toIdx = parseInt(item.dataset.index);
                // Swap in clips array
                var temp = clips[fromIdx];
                clips.splice(fromIdx, 1);
                clips.splice(toIdx, 0, temp);
                renderOrderList();
            });
        });
    }

    function updateTitlePreview() {
        var text = document.getElementById('title-text').value || 'Your Title Here';
        var highlight = document.getElementById('title-highlight').value;
        var preview = document.getElementById('title-preview');

        if (highlight && text.toLowerCase().includes(highlight.toLowerCase())) {
            var regex = new RegExp('(' + highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'i');
            var html = text.replace(regex, '<span class="highlight">$1</span>');
            preview.innerHTML = '<h2>' + html + '</h2>';
        } else {
            preview.innerHTML = '<h2>' + text + '</h2>';
        }
    }

    function initTitleControls() {
        document.getElementById('title-text').addEventListener('input', updateTitlePreview);
        document.getElementById('title-highlight').addEventListener('input', updateTitlePreview);

        document.getElementById('btn-back-trim').addEventListener('click', function() {
            goToStep(2);
            showTrimClip(clips.length - 1);
        });
    }

    // --- Assembly ---
    async function assembleVideo() {
        var btn = document.getElementById('btn-assemble');
        btn.disabled = true;
        btn.textContent = '⏳ Trimming clips...';

        goToStep(4);
        var progressEl = document.getElementById('assembly-progress');
        var progressFill = document.getElementById('progress-fill');
        var progressText = document.getElementById('progress-text');
        progressEl.classList.remove('hidden');
        progressFill.style.width = '0%';
        progressText.textContent = 'Trimming clips...';

        try {
            // Step 1: Trim all clips server-side
            var trimmedClips = [];
            for (var i = 0; i < clips.length; i++) {
                var clip = clips[i];
                var pct = Math.round(((i + 1) / clips.length) * 50);
                progressFill.style.width = pct + '%';
                progressText.textContent = 'Trimming clip ' + (i + 1) + ' of ' + clips.length + '...';

                // Only trim if start/end differ from original
                var needsTrim = clip.startTime > 0.1 || Math.abs(clip.endTime - clip.originalDuration) > 0.1;
                var filename = clip.filename;

                if (needsTrim) {
                    var trimRes = await apiFetch('/api/studio/ranking/trim', {
                        method: 'POST',
                        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
                        body: JSON.stringify({
                            filename: clip.filename,
                            startTime: clip.startTime,
                            endTime: clip.endTime
                        })
                    });
                    var trimData = await trimRes.json();
                    if (!trimData.success) throw new Error(trimData.error || 'Trim failed');
                    filename = trimData.filename;
                }

                var num = clips.length - i; // Reverse numbering: last in array = #1
                trimmedClips.push({
                    filename: filename,
                    number: num,
                    label: clip.label || ''
                });
            }

            // Step 2: Assemble
            progressFill.style.width = '60%';
            progressText.textContent = 'Assembling ranking video...';

            var title = {
                text: document.getElementById('title-text').value || '',
                highlightWord: document.getElementById('title-highlight').value || ''
            };

            var assembleRes = await apiFetch('/api/studio/ranking/assemble', {
                method: 'POST',
                headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
                body: JSON.stringify({ clips: trimmedClips, title: title })
            });
            var assembleData = await assembleRes.json();

            if (!assembleData.success) {
                throw new Error(assembleData.error || 'Assembly failed');
            }

            // Done
            progressFill.style.width = '100%';
            progressText.textContent = 'Done!';

            setTimeout(function() {
                progressEl.classList.add('hidden');
                showResult(assembleData);
            }, 500);

            loadCredits();

        } catch (err) {
            progressFill.style.width = '0%';
            progressText.textContent = '❌ ' + err.message;
            btn.disabled = false;
            btn.textContent = '🎬 Assemble Video (2 💎)';

            // If credit error
            if (err.message.includes('credits')) {
                progressText.textContent = '❌ Not enough credits. ' + err.message;
            }
            loadCredits();
        }
    }

    function showResult(data) {
        var video = document.getElementById('result-video');
        video.src = data.videoUrl;
        video.classList.remove('hidden');
        video.load();

        var info = document.getElementById('result-info');
        info.textContent = data.clipCount + ' clips · ' + data.duration.toFixed(1) + 's · 2 💎';

        var actions = document.getElementById('result-actions');
        actions.classList.remove('hidden');

        document.getElementById('btn-download').href = data.videoUrl;
    }

    // --- Init ---
    function init() {
        loadCredits();
        initUpload();
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
            document.getElementById('result-actions').classList.add('hidden');
            document.getElementById('btn-assemble').disabled = false;
            document.getElementById('btn-assemble').textContent = '🎬 Assemble Video (2 💎)';
            goToStep(1);
        });

        goToStep(1);
    }

    // Expose for inline onclick handlers
    window._rankingApp = {
        removeClip: removeClip
    };

    init();
})();
