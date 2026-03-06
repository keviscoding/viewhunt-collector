/* Timelapse Construction — Frontend App */
(function() {
    var token = localStorage.getItem('viewhunt_token') || localStorage.getItem('token');
    if (!token) { window.location.replace('/'); return; }

    var state = {
        concept: '',
        stageCount: 5,
        promptData: null,
        stageImageSets: {},  // { 1: [url, url, url, url], 2: [...], ... }
        stageSelected: {},   // { 1: url, 2: url, ... }
        currentStage: 1,
        transitionVideos: {},
        finalVideoUrl: null
    };

    // Load credit balance
    fetch('/api/studio/credits/balance', { headers: { 'Authorization': 'Bearer ' + token } })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var bal = (d.balance || 0) + (d.topUpBalance || 0);
            document.getElementById('credit-balance').textContent = bal;
        })
        .catch(function() {});

    // Update cost display when stage count changes
    window.updateStageCount = function(val) {
        state.stageCount = parseInt(val) || 5;
        updateCostDisplay();
    };

    function updateCostDisplay() {
        var n = state.stageCount;
        var imgCost = n * 2;           // 4 images × 0.5 = 2 per stage
        var vidCost = (n - 1) * 5;     // N-1 transitions × 5
        var asmCost = 2;
        var total = imgCost + vidCost + asmCost;
        var el = document.getElementById('cost-estimate');
        if (el) el.textContent = '~' + total + ' credits (' + n + ' stages × 2💎 images + ' + (n - 1) + ' videos × 5💎 + 2💎 assembly)';
    }

    window.generatePrompts = async function() {
        var concept = document.getElementById('concept-input').value.trim();
        if (!concept) return alert('Please describe your concept first.');
        if (concept.length < 20) return alert('Please provide a more detailed description (at least 20 characters).');

        state.concept = concept;
        state.stageCount = parseInt(document.getElementById('stage-count-select').value) || 5;
        var btn = document.getElementById('generate-prompts-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Generating ' + state.stageCount + ' stage prompts...';

        try {
            var res = await fetch('/api/studio/timelapse/prompts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ concept: concept, stageCount: state.stageCount })
            });
            if (!res.ok) {
                var err = await res.json().catch(function() { return {}; });
                throw new Error(err.error || 'Failed to generate prompts');
            }
            var data = await res.json();
            state.promptData = data;
            state.currentStage = 1;
            state.stageImageSets = {};
            state.stageSelected = {};
            state.transitionVideos = {};
            renderStages();
            document.getElementById('stages-section').style.display = 'block';
            document.getElementById('stages-section').scrollIntoView({ behavior: 'smooth' });
            generateStageImages(1);
        } catch (e) {
            alert('Error: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = 'Generate Stage Prompts · Free';
        }
    };

    function renderStages() {
        var list = document.getElementById('stages-list');
        var totalStages = state.promptData.stages.length;
        var html = '';
        state.promptData.stages.forEach(function(s) {
            var stageNum = s.stage;
            var images = state.stageImageSets[stageNum] || [];
            var selected = state.stageSelected[stageNum];
            var isActive = stageNum === state.currentStage;
            var isDone = !!selected;
            var isPending = stageNum > state.currentStage;
            var statusClass = isDone ? 'done' : (isActive ? 'active' : '');
            var statusBadge = isDone ? '<span class="stage-status status-done">Selected</span>' :
                (isActive && images.length > 0 ? '<span class="stage-status status-review">Pick one</span>' :
                (isActive ? '<span class="stage-status status-generating">Generating</span>' :
                '<span class="stage-status status-pending">Waiting</span>'));

            html += '<div class="stage-card ' + statusClass + '" id="stage-card-' + stageNum + '">';
            html += '<div class="stage-header">';
            html += '<span class="stage-num">Stage ' + stageNum + '/' + totalStages + ' — ' + escHtml(s.name) + '</span>';
            html += statusBadge;
            html += '</div>';
            html += '<div class="stage-desc">' + escHtml(s.description) + '</div>';

            // Show image grid (4 images or selected single)
            if (isDone) {
                html += '<div class="stage-images">';
                html += '<div class="stage-img selected">';
                html += '<img src="' + selected + '" alt="Stage ' + stageNum + '">';
                html += '<div class="check">✓</div>';
                html += '</div>';
                html += '</div>';
            } else if (images.length > 0) {
                html += '<div class="stage-images">';
                for (var i = 0; i < images.length; i++) {
                    if (images[i]) {
                        html += '<div class="stage-img" onclick="selectStageImage(' + stageNum + ',' + i + ')">';
                        html += '<img src="' + images[i] + '" alt="Option ' + (i + 1) + '">';
                        html += '<div class="check">✓</div>';
                        html += '</div>';
                    }
                }
                html += '</div>';
            }

            // Progress indicator
            if (isActive && images.length === 0) {
                html += '<div id="stage-progress-' + stageNum + '" class="progress-msg"><span class="spinner"></span> Generating 4 images for Stage ' + stageNum + '...</div>';
            }

            // Tweak + regenerate
            if (isActive || isDone) {
                html += '<div class="tweak-box" id="tweak-' + stageNum + '">';
                html += '<input type="text" placeholder="Tweak prompt (optional)..." id="tweak-input-' + stageNum + '">';
                html += '<button class="btn btn-sm btn-outline" onclick="regenerateStage(' + stageNum + ')">🔄 Regen · 2 💎</button>';
                html += '</div>';
            }

            html += '</div>';
        });
        list.innerHTML = html;
    }

    window.selectStageImage = function(stageNum, imageIndex) {
        var images = state.stageImageSets[stageNum];
        if (!images || !images[imageIndex]) return;
        state.stageSelected[stageNum] = images[imageIndex];

        var totalStages = state.promptData.stages.length;
        if (stageNum < totalStages) {
            state.currentStage = stageNum + 1;
            renderStages();
            generateStageImages(stageNum + 1);
            var card = document.getElementById('stage-card-' + (stageNum + 1));
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            // All stages done
            state.currentStage = totalStages + 1;
            renderStages();
            showVideoSection();
        }
    };

    window.regenerateStage = async function(stageNum) {
        var tweakInput = document.getElementById('tweak-input-' + stageNum);
        var tweak = tweakInput ? tweakInput.value.trim() : '';
        state.stageImageSets[stageNum] = [];
        state.stageSelected[stageNum] = null;
        state.currentStage = stageNum;
        renderStages();
        await generateStageImages(stageNum, tweak);
    };

    async function generateStageImages(stageNum, tweak) {
        var stage = state.promptData.stages.find(function(s) { return s.stage === stageNum; });
        if (!stage) return;

        var prompt = stage.imagePrompt;
        if (tweak) prompt = prompt + '\n\nAdditional direction: ' + tweak;

        var referenceUrl = null;
        if (stageNum > 1 && state.stageSelected[stageNum - 1]) {
            referenceUrl = state.stageSelected[stageNum - 1];
        }

        var progressEl = document.getElementById('stage-progress-' + stageNum);
        if (progressEl) progressEl.innerHTML = '<span class="spinner"></span> Generating 4 images for Stage ' + stageNum + '...';

        try {
            var res = await fetch('/api/studio/timelapse/generate-images', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({
                    imagePrompt: prompt,
                    stageNumber: stageNum,
                    referenceImageUrl: referenceUrl
                })
            });
            if (!res.ok) {
                var err = await res.json().catch(function() { return {}; });
                throw new Error(err.error || 'Image generation failed');
            }
            var data = await res.json();
            state.stageImageSets[stageNum] = data.imageUrls || [];
            renderStages();

            var balEl = document.getElementById('credit-balance');
            var curBal = parseFloat(balEl.textContent) || 0;
            balEl.textContent = Math.max(0, curBal - 2);
        } catch (e) {
            if (progressEl) progressEl.innerHTML = '<span style="color:var(--red);">❌ ' + escHtml(e.message) + '</span>';
        }
    }

    function showVideoSection() {
        var transitions = state.promptData.transitions;
        var html = '<div class="section-title">🎬 Transition Videos</div>';
        html += '<p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:0.75rem;">Generating ' + transitions.length + ' smooth transitions between your stages using Seedance 1.5 Pro (start+end frame interpolation).</p>';

        transitions.forEach(function(t) {
            var vid = state.transitionVideos[t.from + '-' + t.to];
            html += '<div class="transition-card" id="trans-card-' + t.from + '-' + t.to + '">';
            html += '<div class="stage-header">';
            html += '<span class="stage-num">Transition ' + t.from + ' → ' + t.to + '</span>';
            if (vid) {
                html += '<span class="stage-status status-done">Done</span>';
            } else {
                html += '<span class="stage-status status-pending" id="trans-status-' + t.from + '-' + t.to + '">Waiting</span>';
            }
            html += '</div>';
            html += '<div class="stage-desc" style="font-size:0.78rem;">' + escHtml(t.videoPrompt).substring(0, 120) + '...</div>';
            if (vid) {
                html += '<video src="' + vid + '" controls playsinline></video>';
            }
            html += '</div>';
        });

        html += '<div style="margin-top:0.75rem;">';
        html += '<button class="btn btn-primary" id="gen-videos-btn" onclick="generateAllVideos()">Generate All Videos · ' + (transitions.length * 5) + ' 💎</button>';
        html += '</div>';
        html += '<div class="cost-note">' + transitions.length + ' transitions × 5 credits each</div>';

        document.getElementById('videos-section').innerHTML = html;
        document.getElementById('videos-section').style.display = 'block';
        document.getElementById('videos-section').scrollIntoView({ behavior: 'smooth' });
    }

    window.generateAllVideos = async function() {
        var transitions = state.promptData.transitions;
        var btn = document.getElementById('gen-videos-btn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Generating videos...'; }

        for (var i = 0; i < transitions.length; i++) {
            var t = transitions[i];
            var key = t.from + '-' + t.to;
            if (state.transitionVideos[key]) continue;

            var statusEl = document.getElementById('trans-status-' + key);
            if (statusEl) { statusEl.className = 'stage-status status-generating'; statusEl.textContent = 'Generating'; }

            try {
                var res = await fetch('/api/studio/timelapse/generate-video', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({
                        startImageUrl: state.stageSelected[t.from],
                        endImageUrl: state.stageSelected[t.to],
                        videoPrompt: t.videoPrompt,
                        transitionNumber: i + 1
                    })
                });
                if (!res.ok) {
                    var err = await res.json().catch(function() { return {}; });
                    throw new Error(err.error || 'Video generation failed');
                }
                var data = await res.json();
                state.transitionVideos[key] = data.videoUrl;

                var balEl = document.getElementById('credit-balance');
                var curBal = parseFloat(balEl.textContent) || 0;
                balEl.textContent = Math.max(0, curBal - 5);

                showVideoSection();
            } catch (e) {
                if (statusEl) { statusEl.className = 'stage-status'; statusEl.style.cssText = 'background:rgba(248,113,113,0.12);color:var(--red)'; statusEl.textContent = 'Failed'; }
                alert('Transition ' + t.from + '→' + t.to + ' failed: ' + e.message);
                if (btn) { btn.disabled = false; btn.innerHTML = 'Retry Remaining · 5 💎 each'; }
                return;
            }
        }

        showAssemblySection();
    };

    function showAssemblySection() {
        var transitions = state.promptData.transitions;
        var html = '<div class="section-title">🔧 Final Assembly</div>';
        html += '<p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:0.75rem;">All ' + transitions.length + ' transition videos are ready. Stitch them into one seamless time-lapse.</p>';
        html += '<button class="btn btn-green" id="assemble-btn" onclick="assembleVideo()">Assemble Final Video · 2 💎</button>';
        html += '<div class="cost-note">FFmpeg stitching — fast</div>';

        document.getElementById('assembly-section').innerHTML = html;
        document.getElementById('assembly-section').style.display = 'block';
        document.getElementById('assembly-section').scrollIntoView({ behavior: 'smooth' });
    }

    window.assembleVideo = async function() {
        var btn = document.getElementById('assemble-btn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Assembling...'; }

        var transitions = state.promptData.transitions;
        var videoUrls = [];
        for (var i = 0; i < transitions.length; i++) {
            var key = transitions[i].from + '-' + transitions[i].to;
            var url = state.transitionVideos[key];
            if (!url) { alert('Missing video for transition ' + key); return; }
            videoUrls.push(url);
        }

        try {
            var res = await fetch('/api/studio/timelapse/assemble', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ videoUrls: videoUrls })
            });
            if (!res.ok) {
                var err = await res.json().catch(function() { return {}; });
                throw new Error(err.error || 'Assembly failed');
            }
            var data = await res.json();
            state.finalVideoUrl = data.videoUrl;

            var balEl = document.getElementById('credit-balance');
            var curBal = parseFloat(balEl.textContent) || 0;
            balEl.textContent = Math.max(0, curBal - 2);

            showFinalResult();
        } catch (e) {
            alert('Assembly failed: ' + e.message);
            if (btn) { btn.disabled = false; btn.innerHTML = 'Retry Assembly · 2 💎'; }
        }
    };

    function showFinalResult() {
        var stageCount = state.promptData.stages.length;
        var html = '<div class="final-section">';
        html += '<div class="section-title" style="justify-content:center;">🎉 Your Time-Lapse is Ready</div>';
        html += '<video src="' + state.finalVideoUrl + '" controls playsinline style="width:100%;max-width:300px;border-radius:10px;margin:0.75rem auto;display:block;"></video>';
        html += '<p style="font-size:0.82rem;color:var(--text-muted);margin:0.5rem 0;">' + stageCount + ' stages · ' + (stageCount - 1) + ' transitions · Seedance 1.5 Pro</p>';
        html += '<a href="' + state.finalVideoUrl + '" download class="btn btn-primary" style="max-width:280px;margin:0.5rem auto;">⬇ Download Video</a>';
        html += '</div>';

        document.getElementById('final-section').innerHTML = html;
        document.getElementById('final-section').style.display = 'block';
        document.getElementById('final-section').scrollIntoView({ behavior: 'smooth' });
    }

    function escHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
})();
