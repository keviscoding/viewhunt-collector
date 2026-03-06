/* Timelapse Construction — Frontend App */
(function() {
    var token = localStorage.getItem('viewhunt_token') || localStorage.getItem('token');
    if (!token) { window.location.replace('/'); return; }

    var state = {
        concept: '',
        promptData: null,    // { title, character, environment, stages[], transitions[] }
        stageImages: {},     // { 1: { url, prompt }, 2: ..., 3: ..., 4: ... }
        currentStage: 1,
        transitionVideos: {},// { 1: url, 2: url, 3: url }
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

    // Expose generatePrompts globally
    window.generatePrompts = async function() {
        var concept = document.getElementById('concept-input').value.trim();
        if (!concept) return alert('Please describe your concept first.');
        if (concept.length < 20) return alert('Please provide a more detailed description (at least 20 characters).');

        state.concept = concept;
        var btn = document.getElementById('generate-prompts-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Generating prompts...';

        try {
            var res = await fetch('/api/studio/timelapse/prompts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ concept: concept })
            });
            if (!res.ok) {
                var err = await res.json().catch(function() { return {}; });
                throw new Error(err.error || 'Failed to generate prompts');
            }
            var data = await res.json();
            state.promptData = data;
            state.currentStage = 1;
            renderStages();
            document.getElementById('stages-section').style.display = 'block';
            document.getElementById('stages-section').scrollIntoView({ behavior: 'smooth' });
            // Auto-generate first stage image
            generateStageImage(1);
        } catch (e) {
            alert('Error: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = 'Generate Stage Prompts · Free';
        }
    };

    function renderStages() {
        var list = document.getElementById('stages-list');
        var html = '';
        state.promptData.stages.forEach(function(s) {
            var stageNum = s.stage;
            var img = state.stageImages[stageNum];
            var isActive = stageNum === state.currentStage;
            var isDone = !!img;
            var isPending = stageNum > state.currentStage;
            var statusClass = isDone ? 'done' : (isActive ? 'active' : '');
            var statusBadge = isDone ? '<span class="stage-status status-done">Done</span>' :
                (isActive ? '<span class="stage-status status-generating">Current</span>' :
                '<span class="stage-status status-pending">Waiting</span>');

            html += '<div class="stage-card ' + statusClass + '" id="stage-card-' + stageNum + '">';
            html += '<div class="stage-header">';
            html += '<span class="stage-num">Stage ' + stageNum + ' — ' + escHtml(s.name) + '</span>';
            html += statusBadge;
            html += '</div>';
            html += '<div class="stage-desc">' + escHtml(s.description) + '</div>';

            if (img) {
                html += '<div class="stage-images">';
                html += '<div class="stage-img selected">';
                html += '<img src="' + img.url + '" alt="Stage ' + stageNum + '">';
                html += '<div class="check">✓</div>';
                html += '</div>';
                html += '</div>';
            }

            if (isActive && !img) {
                html += '<div id="stage-progress-' + stageNum + '" class="progress-msg"><span class="spinner"></span> Generating image...</div>';
            }

            // Tweak + regenerate (only for current or done stages)
            if ((isActive || isDone) && !isPending) {
                html += '<div class="tweak-box" id="tweak-' + stageNum + '">';
                html += '<input type="text" placeholder="Tweak prompt (optional)..." id="tweak-input-' + stageNum + '">';
                html += '<button class="btn btn-sm btn-outline" onclick="regenerateStage(' + stageNum + ')">🔄 Regen · 0.5 💎</button>';
                html += '</div>';
            }

            // Accept button (only for current stage when image exists)
            if (isActive && img) {
                html += '<div style="margin-top:0.5rem;display:flex;gap:0.4rem;">';
                html += '<button class="btn btn-sm btn-green" onclick="acceptStage(' + stageNum + ')">✓ Accept & Continue</button>';
                html += '</div>';
            }

            html += '</div>';
        });
        list.innerHTML = html;
    }

    window.acceptStage = function(stageNum) {
        if (stageNum < 4) {
            state.currentStage = stageNum + 1;
            renderStages();
            generateStageImage(stageNum + 1);
            var card = document.getElementById('stage-card-' + (stageNum + 1));
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            // All 4 stages done — move to video generation
            state.currentStage = 5; // past stages
            renderStages();
            showVideoSection();
        }
    };

    window.regenerateStage = async function(stageNum) {
        var tweakInput = document.getElementById('tweak-input-' + stageNum);
        var tweak = tweakInput ? tweakInput.value.trim() : '';
        state.stageImages[stageNum] = null;
        state.currentStage = stageNum;
        renderStages();
        await generateStageImage(stageNum, tweak);
    };

    async function generateStageImage(stageNum, tweak) {
        var stage = state.promptData.stages.find(function(s) { return s.stage === stageNum; });
        if (!stage) return;

        var prompt = stage.imagePrompt;
        if (tweak) {
            prompt = prompt + '\n\nAdditional direction: ' + tweak;
        }

        // Reference image = previous stage's selected image
        var referenceUrl = null;
        if (stageNum > 1 && state.stageImages[stageNum - 1]) {
            referenceUrl = state.stageImages[stageNum - 1].url;
        }

        var progressEl = document.getElementById('stage-progress-' + stageNum);
        if (progressEl) progressEl.innerHTML = '<span class="spinner"></span> Generating image for Stage ' + stageNum + '...';

        try {
            var res = await fetch('/api/studio/timelapse/generate-image', {
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
            state.stageImages[stageNum] = { url: data.imageUrl, prompt: prompt };
            renderStages();

            // Update balance
            var balEl = document.getElementById('credit-balance');
            var curBal = parseFloat(balEl.textContent) || 0;
            balEl.textContent = Math.max(0, curBal - 0.5);
        } catch (e) {
            if (progressEl) progressEl.innerHTML = '<span style="color:var(--red);">❌ ' + escHtml(e.message) + '</span>';
        }
    }

    function showVideoSection() {
        document.getElementById('videos-section').style.display = 'block';
        document.getElementById('videos-section').scrollIntoView({ behavior: 'smooth' });

        var html = '';
        html += '<div style="text-align:center;margin-bottom:1rem;">';
        html += '<button class="btn btn-primary" id="gen-videos-btn" onclick="generateAllVideos()">';
        html += '🎬 Generate 3 Transition Videos · 15 💎';
        html += '</button>';
        html += '<div class="cost-note">Uses start+end frame interpolation for smooth transitions</div>';
        html += '</div>';

        for (var i = 0; i < 3; i++) {
            var t = state.promptData.transitions[i];
            html += '<div class="transition-card" id="transition-card-' + (i + 1) + '">';
            html += '<div style="display:flex;align-items:center;justify-content:space-between;">';
            html += '<span style="font-size:0.82rem;font-weight:700;">Transition ' + (i + 1) + ': Stage ' + t.from + ' → ' + t.to + '</span>';
            html += '<span class="stage-status status-pending" id="transition-status-' + (i + 1) + '">Pending</span>';
            html += '</div>';
            html += '<div style="font-size:0.78rem;color:var(--text-dim);margin-top:0.3rem;">' + escHtml(t.videoPrompt.substring(0, 120)) + '...</div>';
            html += '<div id="transition-result-' + (i + 1) + '"></div>';
            html += '</div>';
        }

        document.getElementById('transitions-list').innerHTML = html;
    }

    window.generateAllVideos = async function() {
        var btn = document.getElementById('gen-videos-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Generating videos...';

        var allDone = true;
        for (var i = 0; i < 3; i++) {
            var t = state.promptData.transitions[i];
            var num = i + 1;
            var statusEl = document.getElementById('transition-status-' + num);
            var resultEl = document.getElementById('transition-result-' + num);

            statusEl.className = 'stage-status status-generating';
            statusEl.textContent = 'Generating';

            try {
                var startImg = state.stageImages[t.from].url;
                var endImg = state.stageImages[t.to].url;

                var res = await fetch('/api/studio/timelapse/generate-video', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify({
                        startImageUrl: startImg,
                        endImageUrl: endImg,
                        videoPrompt: t.videoPrompt,
                        transitionNumber: num
                    })
                });
                if (!res.ok) {
                    var err = await res.json().catch(function() { return {}; });
                    throw new Error(err.error || 'Video generation failed');
                }
                var data = await res.json();
                state.transitionVideos[num] = data.videoUrl;

                statusEl.className = 'stage-status status-done';
                statusEl.textContent = 'Done';
                resultEl.innerHTML = '<video src="' + data.videoUrl + '" controls muted playsinline style="width:100%;max-width:200px;border-radius:8px;margin-top:0.5rem;"></video>';

                // Update balance
                var balEl = document.getElementById('credit-balance');
                var curBal = parseFloat(balEl.textContent) || 0;
                balEl.textContent = Math.max(0, curBal - 5);
            } catch (e) {
                statusEl.className = 'stage-status status-pending';
                statusEl.textContent = 'Failed';
                resultEl.innerHTML = '<div style="color:var(--red);font-size:0.82rem;margin-top:0.3rem;">❌ ' + escHtml(e.message) + '</div>';
                allDone = false;
            }
        }

        btn.disabled = false;
        var doneCount = Object.keys(state.transitionVideos).length;
        if (doneCount === 3) {
            btn.innerHTML = '✅ All 3 videos generated';
            btn.disabled = true;
            showAssemblySection();
        } else {
            btn.innerHTML = '🔄 Retry Failed Videos · ' + ((3 - doneCount) * 5) + ' 💎';
        }
    };

    function showAssemblySection() {
        var section = document.getElementById('assembly-section');
        section.style.display = 'block';
        section.innerHTML = '<div style="text-align:center;margin-top:1rem;">' +
            '<button class="btn btn-primary" onclick="assembleVideo()" id="assemble-btn">' +
            '🎬 Assemble Final Video · 2 💎</button>' +
            '<div class="cost-note">Stitches 3 transition clips into one seamless video</div></div>';
        section.scrollIntoView({ behavior: 'smooth' });
    }

    window.assembleVideo = async function() {
        var btn = document.getElementById('assemble-btn');
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Assembling...';

        try {
            var videoUrls = [
                state.transitionVideos[1],
                state.transitionVideos[2],
                state.transitionVideos[3]
            ];

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

            // Update balance
            var balEl = document.getElementById('credit-balance');
            var curBal = parseFloat(balEl.textContent) || 0;
            balEl.textContent = Math.max(0, curBal - 2);

            showFinalResult(data.videoUrl);
        } catch (e) {
            btn.disabled = false;
            btn.innerHTML = '🎬 Assemble Final Video · 2 💎';
            alert('Assembly error: ' + e.message);
        }
    };

    function showFinalResult(videoUrl) {
        var section = document.getElementById('final-section');
        section.style.display = 'block';
        var bustUrl = videoUrl + (videoUrl.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
        section.innerHTML = '<div class="final-section">' +
            '<div style="font-size:1.1rem;font-weight:700;color:var(--green);margin-bottom:0.5rem;">✅ Your Time-Lapse Video is Ready</div>' +
            '<video src="' + bustUrl + '" controls autoplay muted loop style="width:100%;max-width:300px;border-radius:10px;margin:0.75rem auto;display:block;"></video>' +
            '<div style="margin-top:0.75rem;display:flex;gap:0.5rem;justify-content:center;">' +
                '<a href="' + videoUrl + '" download="timelapse-video.mp4" target="_blank" class="btn btn-sm btn-green" style="text-decoration:none;">📥 Download</a>' +
            '</div></div>';
        section.scrollIntoView({ behavior: 'smooth' });

        // Hide assembly button
        document.getElementById('assembly-section').style.display = 'none';
    }

    function escHtml(str) {
        var d = document.createElement('div');
        d.textContent = str || '';
        return d.innerHTML;
    }
})();
