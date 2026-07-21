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
    var trialInfo = null; // { active, daysLeft, rankingVideosLeft }

    // Layout settings (sent to assembler)
    var layout = { listX: 5, titleY: 6, titleSize: 48, lineSpacing: 65, numSize: 50 };
    var colorPalette = 'yellow';
    var checkeredMode = false;
    var subtitleColor = 'yellow';
    var stylePreset = 'viral';
    var previewActiveClip = 0; // which clip looks "active" in dashboard preview

    var STYLE_PRESETS = {
        viral: {
            label: 'Viral Shorts',
            colorPalette: 'yellow',
            checkeredMode: false,
            layout: { listX: 5, titleY: 4, titleSize: 52, lineSpacing: 65, numSize: 50 },
            subtitleFont: 'Arial Black',
            subtitleY: 50,
            subtitleColor: 'yellow',
            overlayStyle: 'viral'
        },
        classic: {
            label: 'Classic Yellow',
            colorPalette: 'yellow',
            checkeredMode: false,
            layout: { listX: 5, titleY: 6, titleSize: 48, lineSpacing: 65, numSize: 50 },
            subtitleFont: 'Arial',
            subtitleY: 55,
            subtitleColor: 'yellow',
            overlayStyle: 'classic'
        },
        bold: {
            label: 'Bold Impact',
            colorPalette: 'orange',
            checkeredMode: false,
            layout: { listX: 4, titleY: 5, titleSize: 58, lineSpacing: 72, numSize: 62 },
            subtitleFont: 'Impact',
            subtitleY: 50,
            subtitleColor: 'yellow',
            overlayStyle: 'viral'
        },
        minimal: {
            label: 'Minimal Bottom Caps',
            colorPalette: 'white',
            checkeredMode: false,
            layout: { listX: 8, titleY: 8, titleSize: 40, lineSpacing: 58, numSize: 42 },
            subtitleFont: 'Arial',
            subtitleY: 72,
            subtitleColor: 'white',
            overlayStyle: 'classic'
        },
        checkered: {
            label: 'Checkered Pro',
            colorPalette: 'cyan',
            checkeredMode: true,
            layout: { listX: 5, titleY: 6, titleSize: 48, lineSpacing: 68, numSize: 52 },
            subtitleFont: 'Verdana',
            subtitleY: 58,
            subtitleColor: 'cyan',
            overlayStyle: 'classic'
        }
    };

    var SETTINGS_LS_KEY = 'viewhunt_ranking_settings_v1';

    function collectSettingsPrefs() {
        var titleEl = document.getElementById('title-text');
        var hlEl = document.getElementById('title-highlight');
        var voiceEl = document.getElementById('voice-picker');
        var fontEl = document.getElementById('subtitle-font');
        var subYEl = document.getElementById('subtitle-y');
        var commentaryEl = document.getElementById('commentary-toggle');
        return {
            title: {
                text: titleEl ? titleEl.value : '',
                highlightWord: hlEl ? hlEl.value : ''
            },
            layout: layout,
            colorPalette: colorPalette,
            checkeredMode: checkeredMode,
            subtitleFont: fontEl ? fontEl.value : 'Arial Black',
            subtitleY: subYEl ? (parseInt(subYEl.value, 10) || 50) : 50,
            subtitleColor: subtitleColor,
            stylePreset: stylePreset,
            commentary: commentaryEl ? !!commentaryEl.checked : true,
            voiceName: voiceEl ? voiceEl.value : 'Kore'
        };
    }

    function saveSettingsPrefs() {
        try {
            localStorage.setItem(SETTINGS_LS_KEY, JSON.stringify({
                settings: collectSettingsPrefs(),
                savedAt: Date.now()
            }));
        } catch (e) {}
    }

    function applySettingsPrefs(settings) {
        if (!settings) return;
        applyDraft({
            clips: [],
            title: settings.title,
            layout: settings.layout,
            colorPalette: settings.colorPalette,
            checkeredMode: settings.checkeredMode,
            subtitleFont: settings.subtitleFont,
            subtitleY: settings.subtitleY,
            subtitleColor: settings.subtitleColor,
            stylePreset: settings.stylePreset || 'viral',
            commentary: settings.commentary,
            voiceName: settings.voiceName,
            currentStep: 1
        });
        // applyDraft with empty clips goes to step 1 — keep style preset button state
        if (settings.stylePreset) {
            document.querySelectorAll('.style-preset').forEach(function(b) {
                b.classList.toggle('active', b.dataset.preset === settings.stylePreset);
            });
        }
    }

    function loadSettingsPrefs() {
        try {
            var raw = localStorage.getItem(SETTINGS_LS_KEY);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            return parsed && parsed.settings ? parsed.settings : null;
        } catch (e) {
            return null;
        }
    }

    async function validateDraftClips(draftClips) {
        var list = draftClips || [];
        var ok = [];
        for (var i = 0; i < list.length; i++) {
            var c = list[i];
            if (!c || !c.filename) continue;
            try {
                var url = c.url || ('/studio/ranking-uploads/' + encodeURIComponent(c.filename));
                var res = await fetch(url, { method: 'HEAD', headers: authHeaders() });
                if (res.ok) ok.push(c);
            } catch (e) { /* missing */ }
        }
        return ok;
    }

    function getToken() { return localStorage.getItem('viewhunt_token') || localStorage.getItem('token') || null; }
    function authHeaders() { return { 'Authorization': 'Bearer ' + getToken() }; }
    async function apiFetch(url, opts) {
        opts = opts || {};
        opts.headers = Object.assign({}, opts.headers || {}, authHeaders());
        var res = await fetch(url, opts);
        if (res.status === 401 || res.status === 403) { window.location.replace('/'); throw new Error('Auth failed'); }
        return res;
    }

    var draftSaveTimer = null;
    var activeJobId = null;
    var DRAFT_LS_KEY = 'viewhunt_ranking_draft_v1';

    function collectDraft() {
        var titleEl = document.getElementById('title-text');
        var hlEl = document.getElementById('title-highlight');
        var voiceEl = document.getElementById('voice-picker');
        var fontEl = document.getElementById('subtitle-font');
        var subYEl = document.getElementById('subtitle-y');
        var commentaryEl = document.getElementById('commentary-toggle');
        return {
            clips: clips.filter(function(c) { return c.filename && !c.uploading; }).map(function(c) {
                return {
                    filename: c.filename,
                    originalName: c.originalName || c.filename,
                    url: c.url || ('/studio/ranking-uploads/' + encodeURIComponent(c.filename)),
                    duration: c.duration || c.originalDuration || 0,
                    originalDuration: c.originalDuration || c.duration || 0,
                    startTime: c.startTime || 0,
                    endTime: c.endTime != null ? c.endTime : (c.duration || null),
                    label: c.label || '',
                    textCleaned: !!c.textCleaned
                };
            }),
            title: {
                text: titleEl ? titleEl.value : '',
                highlightWord: hlEl ? hlEl.value : ''
            },
            layout: layout,
            colorPalette: colorPalette,
            checkeredMode: checkeredMode,
            subtitleFont: fontEl ? fontEl.value : 'Arial',
            subtitleY: subYEl ? (parseInt(subYEl.value, 10) || 55) : 55,
            subtitleColor: subtitleColor,
            stylePreset: stylePreset,
            commentary: commentaryEl ? !!commentaryEl.checked : false,
            voiceName: voiceEl ? voiceEl.value : 'Kore',
            currentStep: currentStep
        };
    }

    function scheduleDraftSave() {
        if (draftSaveTimer) clearTimeout(draftSaveTimer);
        draftSaveTimer = setTimeout(function() { saveDraftNow(); }, 800);
    }

    async function saveDraftNow() {
        var draft = collectDraft();
        saveSettingsPrefs();
        try {
            localStorage.setItem(DRAFT_LS_KEY, JSON.stringify({ draft: draft, savedAt: Date.now() }));
        } catch (e) {}
        // Don't keep a server draft of dead/empty clip projects
        if (!draft.clips.length) {
            try { await apiFetch('/api/studio/ranking/draft', { method: 'DELETE' }); } catch (e) {}
            return;
        }
        try {
            await apiFetch('/api/studio/ranking/draft', {
                method: 'PUT',
                headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
                body: JSON.stringify(draft)
            });
        } catch (e) {
            console.warn('Draft save failed:', e.message);
        }
    }

    function applyDraft(draft) {
        if (!draft) return false;
        clips = (draft.clips || []).map(function(c) {
            return {
                filename: c.filename,
                originalName: c.originalName || c.filename,
                url: c.url || ('/studio/ranking-uploads/' + encodeURIComponent(c.filename)),
                duration: c.duration || c.originalDuration || 0,
                originalDuration: c.originalDuration || c.duration || 0,
                startTime: c.startTime || 0,
                endTime: c.endTime != null ? c.endTime : (c.duration || 0),
                label: c.label || '',
                textCleaned: !!c.textCleaned
            };
        });
        if (draft.layout) {
            layout = {
                listX: draft.layout.listX != null ? draft.layout.listX : 5,
                titleY: draft.layout.titleY != null ? draft.layout.titleY : 6,
                titleSize: draft.layout.titleSize != null ? draft.layout.titleSize : 48,
                lineSpacing: draft.layout.lineSpacing != null ? draft.layout.lineSpacing : 65,
                numSize: draft.layout.numSize != null ? draft.layout.numSize : 50
            };
        }
        colorPalette = draft.colorPalette || 'yellow';
        checkeredMode = !!draft.checkeredMode;
        subtitleColor = draft.subtitleColor || 'yellow';
        stylePreset = draft.stylePreset || 'viral';
        var titleEl = document.getElementById('title-text');
        var hlEl = document.getElementById('title-highlight');
        if (titleEl) titleEl.value = (draft.title && draft.title.text) || '';
        if (hlEl) hlEl.value = (draft.title && draft.title.highlightWord) || '';
        var commentaryEl = document.getElementById('commentary-toggle');
        if (commentaryEl) commentaryEl.checked = !!draft.commentary;
        var voiceEl = document.getElementById('voice-picker');
        if (voiceEl) {
            voiceEl.value = draft.voiceName || 'Kore';
            voiceEl.style.display = draft.commentary ? '' : 'none';
        }
        var fontEl = document.getElementById('subtitle-font');
        if (fontEl) fontEl.value = draft.subtitleFont || 'Arial';
        var subYEl = document.getElementById('subtitle-y');
        var subYVal = document.getElementById('subtitle-y-val');
        if (subYEl) {
            subYEl.value = draft.subtitleY != null ? draft.subtitleY : 55;
            if (subYVal) subYVal.textContent = subYEl.value + '%';
        }
        var subSettings = document.getElementById('subtitle-settings');
        if (subSettings) subSettings.style.display = draft.commentary ? '' : 'none';
        var checkered = document.getElementById('checkered-toggle');
        if (checkered) checkered.checked = checkeredMode;
        document.querySelectorAll('.color-swatch').forEach(function(b) {
            b.classList.toggle('active', b.getAttribute('data-color') === colorPalette);
        });
        document.querySelectorAll('.sub-color-swatch').forEach(function(b) {
            b.classList.toggle('active', b.getAttribute('data-color') === subtitleColor);
        });
        renderClipList();
        updateNextButton();
        var step = draft.currentStep || (clips.length ? 3 : 1);
        if (step >= 3 && clips.length) {
            goToStep(3);
            renderOrderList();
            renderPreview('preview-dash');
        } else if (step === 2 && clips.length) {
            currentTrimIndex = 0;
            goToStep(2);
            showTrimClip(0);
        } else {
            goToStep(1);
        }
        return clips.length > 0;
    }

    async function pollJobUntilDone(jobId, pf, pt, btn, enableCommentary) {
        activeJobId = jobId;
        try { localStorage.setItem('viewhunt_ranking_active_job', jobId); } catch (e) {}
        var failCount = 0;
        var pollInterval = 4000;
        while (true) {
            await new Promise(function(r) { setTimeout(r, pollInterval); });
            try {
                var controller = new AbortController();
                var pollTimeout = setTimeout(function() { controller.abort(); }, 15000);
                var pollRes = await apiFetch('/api/studio/ranking/assemble/status/' + jobId, { signal: controller.signal });
                clearTimeout(pollTimeout);
                if (pollRes.status === 404) {
                    throw new Error('Assembly job was lost. Please try again.');
                }
                var pollData = await pollRes.json();
                if (pollData.status === 'complete' && pollData.result) {
                    pf.style.width = '100%'; pt.textContent = 'Done!';
                    activeJobId = null;
                    try { localStorage.removeItem('viewhunt_ranking_active_job'); } catch (e) {}
                    if (btn) delete btn.dataset.busy;
                    setTimeout(function() { showResult(pollData.result); }, 400);
                    loadCredits();
                    return;
                }
                if (pollData.status === 'failed') {
                    var failErr = new Error(pollData.error || 'Assembly failed — credits refunded');
                    failErr.jobFailed = true;
                    throw failErr;
                }
                var msg = pollData.message || 'Processing...';
                pt.textContent = msg;
                var currentPct = parseInt(pf.style.width, 10) || 30;
                if (currentPct < 90) pf.style.width = Math.min(90, currentPct + 2) + '%';
                failCount = 0;
                // Poll faster while waiting on Fly heartbeat / early progress
                pollInterval = /waiting for worker heartbeat|Fly machine start/i.test(msg) ? 2000 : 4000;
            } catch (e) {
                // Real job failures must surface — do not hide behind "still waiting"
                if (e && (e.jobFailed || (e.message && (
                    e.message.includes('Assembly') ||
                    e.message.includes('Auth failed') ||
                    e.message.includes('credits') ||
                    e.message.includes('failed') ||
                    e.message.includes('Spaces') ||
                    e.message.includes('uploaded') ||
                    e.message.includes('Job was lost')
                )))) throw e;
                failCount++;
                if (failCount > 5) pollInterval = 8000;
                if (failCount > 10) pt.textContent = 'Server is busy processing your video... still waiting';
                if (failCount >= 90) throw new Error('Lost connection to server. Your video may still be processing — reopen this page to resume.');
            }
        }
    }

    function showResumeBanner(text, actionsHtml) {
        var el = document.getElementById('resume-banner');
        if (!el) return;
        el.classList.remove('hidden');
        el.innerHTML = '<div class="resume-banner-text">' + text + '</div><div class="resume-banner-actions">' + (actionsHtml || '') + '</div>';
    }

    function hideResumeBanner() {
        var el = document.getElementById('resume-banner');
        if (!el) return;
        el.classList.add('hidden');
        el.innerHTML = '';
    }

    async function resumeSession() {
        // Always restore last style/title prefs first (never blocked by dead clips)
        var prefs = loadSettingsPrefs();
        if (prefs) applySettingsPrefs(prefs);

        try {
            var res = await apiFetch('/api/studio/ranking/session');
            if (!res.ok) return;
            var data = await res.json();

            if (data.activeJob && data.activeJob.jobId) {
                showResumeBanner(
                    'A ranking video is still assembling' +
                        (data.activeJob.message ? ' — ' + escapeHtml(data.activeJob.message) : '') + '.',
                    '<button type="button" class="btn btn-primary btn-sm" id="btn-resume-job">Resume progress</button>'
                );
                var resumeBtn = document.getElementById('btn-resume-job');
                if (resumeBtn) {
                    resumeBtn.addEventListener('click', function() {
                        hideResumeBanner();
                        goToStep(4);
                        document.getElementById('assembly-progress').classList.remove('hidden');
                        var pf = document.getElementById('progress-fill');
                        var pt = document.getElementById('progress-text');
                        var btn = document.getElementById('btn-assemble');
                        pf.style.width = '40%';
                        pt.textContent = data.activeJob.message || 'Resuming…';
                        btn.disabled = true;
                        pollJobUntilDone(data.activeJob.jobId, pf, pt, btn, false).catch(function(err) {
                            pf.style.width = '0%';
                            pt.textContent = 'Error: ' + err.message;
                            btn.disabled = false;
                            btn.textContent = assembleButtonLabel(false);
                            loadCredits();
                        });
                    });
                }
            }

            if (data.draft && data.draft.clips && data.draft.clips.length) {
                var live = await validateDraftClips(data.draft.clips);
                if (live.length) {
                    var serverDraft = Object.assign({}, data.draft, { clips: live });
                    if (!data.activeJob) {
                        showResumeBanner(
                            'Restored your saved ranking project (' + live.length + ' clips).',
                            '<button type="button" class="btn btn-secondary btn-sm" id="btn-dismiss-draft">Dismiss</button>'
                        );
                        var dismiss = document.getElementById('btn-dismiss-draft');
                        if (dismiss) dismiss.addEventListener('click', hideResumeBanner);
                    }
                    applyDraft(serverDraft);
                    return;
                }
                // Clips gone — keep settings only, wipe dead draft
                try { localStorage.removeItem(DRAFT_LS_KEY); } catch (e) {}
                apiFetch('/api/studio/ranking/draft', { method: 'DELETE' }).catch(function() {});
                if (!data.activeJob) {
                    showResumeBanner(
                        'Previous clips expired — your title & style were kept. Upload new clips to continue.',
                        '<button type="button" class="btn btn-secondary btn-sm" id="btn-dismiss-draft">Got it</button>'
                    );
                    var dMiss = document.getElementById('btn-dismiss-draft');
                    if (dMiss) dMiss.addEventListener('click', hideResumeBanner);
                }
                return;
            }

            // localStorage draft only if clips still exist on server
            try {
                var raw = localStorage.getItem(DRAFT_LS_KEY);
                if (raw) {
                    var parsed = JSON.parse(raw);
                    if (parsed && parsed.draft && parsed.draft.clips && parsed.draft.clips.length) {
                        var localLive = await validateDraftClips(parsed.draft.clips);
                        if (localLive.length) {
                            applyDraft(Object.assign({}, parsed.draft, { clips: localLive }));
                            showResumeBanner('Restored draft (' + localLive.length + ' clips still available).',
                                '<button type="button" class="btn btn-secondary btn-sm" id="btn-dismiss-draft">Dismiss</button>');
                            var d2 = document.getElementById('btn-dismiss-draft');
                            if (d2) d2.addEventListener('click', hideResumeBanner);
                        } else {
                            localStorage.removeItem(DRAFT_LS_KEY);
                        }
                    }
                }
            } catch (e) {}
        } catch (e) {
            console.warn('Session resume skipped:', e.message);
        }
    }

    function assembleButtonLabel(enableCommentary) {
        if (trialInfo && trialInfo.active) {
            var left = trialInfo.rankingVideosLeft;
            return 'Assemble Video (Trial · ' + left + ' left)';
        }
        var cost = enableCommentary ? 7 : 2;
        return 'Assemble Video (' + cost + ' 💎)';
    }

    function updateTrialBadge() {
        var badge = document.getElementById('trial-badge');
        var el = document.getElementById('trial-remaining');
        var upgradeBtn = document.getElementById('btn-upgrade-trial');
        if (!badge || !el) return;
        if (trialInfo && trialInfo.active) {
            badge.style.display = '';
            badge.style.color = '';
            el.textContent = trialInfo.rankingVideosLeft + ' ranking left · ' + trialInfo.daysLeft + 'd';
            if (upgradeBtn) {
                var used = trialInfo.rankingVideosUsed != null
                    ? trialInfo.rankingVideosUsed
                    : Math.max(0, 3 - (trialInfo.rankingVideosLeft || 0));
                upgradeBtn.style.display = used >= 1 ? '' : 'none';
                upgradeBtn.style.display = '';
                upgradeBtn.textContent = 'Start free challenge';
            }
        } else if (trialInfo && trialInfo.reason && trialInfo.reason !== 'converted') {
            badge.style.display = '';
            badge.style.color = '#f87171';
            el.textContent = (trialInfo.reason === 'videos_exhausted' || trialInfo.rankingVideosLeft === 0)
                ? '0 ranking left — end trial to continue'
                : 'Start free challenge';
            if (upgradeBtn) {
                upgradeBtn.style.display = '';
                upgradeBtn.textContent = window._stripeTrialing ? 'End trial early' : 'Start free challenge';
            }
        } else {
            badge.style.display = 'none';
            if (upgradeBtn) upgradeBtn.style.display = 'none';
        }
        var btn = document.getElementById('btn-assemble');
        if (btn) {
            var enableCommentary = document.getElementById('commentary-toggle') && document.getElementById('commentary-toggle').checked;
            var trialBlocked = !!(trialInfo && !trialInfo.active && window._stripeTrialing && !window._stripePaidActive);
            if (!btn.dataset.busy) {
                btn.disabled = trialBlocked;
                btn.textContent = trialBlocked
                    ? 'End trial to cook more'
                    : assembleButtonLabel(enableCommentary);
            }
        }
    }

    function showUpgradeModal(opts) {
        opts = opts || {};
        var modal = document.getElementById('upgrade-modal');
        if (!modal) return;
        var sub = document.getElementById('upgrade-modal-sub');
        if (sub && opts.message) sub.textContent = opts.message;
        var endBtn = document.getElementById('btn-end-stripe-trial');
        if (endBtn) {
            var showEnd = opts.showEndStripeTrial != null ? opts.showEndStripeTrial : !!window._stripeTrialing;
            endBtn.style.display = showEnd ? '' : 'none';
        }
        modal.classList.remove('hidden');
    }

    function hideUpgradeModal() {
        var modal = document.getElementById('upgrade-modal');
        if (modal) modal.classList.add('hidden');
    }

    async function startPlanCheckout(plan) {
        try {
            // Persist project so return from Stripe lands back on the same ranking draft
            await saveDraftNow();
            var res = await apiFetch('/api/subscription/create-plan-checkout', {
                method: 'POST',
                headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
                body: JSON.stringify({ plan: plan, returnTo: '/studio/ranking' })
            });
            var data = await res.json();
            if (data.url) {
                window.location.href = data.url;
                return;
            }
            alert(data.error || 'Could not start checkout');
        } catch (e) {
            alert('Checkout error: ' + e.message);
        }
    }

    async function endStripeTrialEarly() {
        try {
            var res = await apiFetch('/api/subscription/end-trial-early', {
                method: 'POST',
                headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
                body: '{}'
            });
            var data = await res.json();
            if (data.needsCheckout) {
                showUpgradeModal({ message: 'Start a plan first — we will save your card for the 7-day trial.' });
                return;
            }
            if (!res.ok) {
                alert(data.error || 'Could not end trial');
                return;
            }
            alert(data.message || 'Trial ended — billing started.');
            hideUpgradeModal();
            loadCredits();
        } catch (e) {
            alert('Error: ' + e.message);
        }
    }

    function wireUpgradeModal() {
        var close = document.getElementById('upgrade-modal-close');
        if (close) close.addEventListener('click', hideUpgradeModal);
        var modal = document.getElementById('upgrade-modal');
        if (modal) {
            modal.addEventListener('click', function(e) {
                if (e.target === modal) hideUpgradeModal();
            });
        }
        document.querySelectorAll('.upgrade-plan-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                startPlanCheckout(btn.getAttribute('data-plan'));
            });
        });
        var endBtn = document.getElementById('btn-end-stripe-trial');
        if (endBtn) endBtn.addEventListener('click', endStripeTrialEarly);
        var badge = document.getElementById('trial-badge');
        if (badge) {
            badge.addEventListener('click', function() {
                showUpgradeModal({
                    message: (trialInfo && trialInfo.active)
                        ? 'You still have trial videos left — or start Creator now with a 7-day Stripe trial (card saved).'
                        : (window._stripeTrialing
                            ? 'Your free trial ranking videos are used up. End your free trial early to start your plan and keep cooking.'
                            : 'Your free trial has ended. Pick a plan to keep posting ranking Shorts.'),
                    showEndStripeTrial: !!window._stripeTrialing
                });
            });
        }
        var upgradeBtn = document.getElementById('btn-upgrade-trial');
        if (upgradeBtn) {
            upgradeBtn.addEventListener('click', function() {
                showUpgradeModal({
                    message: window._stripeTrialing && trialInfo && !trialInfo.active
                        ? 'Your free trial ranking videos are used up. End your free trial early to start your plan and keep cooking.'
                        : 'Start Creator to post every day. Card collected at checkout — 7-day plan trial, then billed.',
                    showEndStripeTrial: !!window._stripeTrialing
                });
            });
        }
    }

    async function loadCredits() {
        try {
            var res = await apiFetch('/api/studio/credits/balance');
            var data = await res.json();
            document.getElementById('credit-balance').textContent = (data.totalAvailable || 0);
        } catch (e) { console.warn('Credits:', e); }
        try {
            var meRes = await apiFetch('/api/auth/me');
            if (meRes.ok) {
                var me = await meRes.json();
                var t = me.trial || (me.subscription && me.subscription.trial) || null;
                if (t) {
                    trialInfo = {
                        active: !!(me.trialRemaining && me.trialRemaining.daysLeft != null
                            ? (me.subscription && me.subscription.type === 'trial')
                            : t.active),
                        daysLeft: (me.trialRemaining && me.trialRemaining.daysLeft != null)
                            ? me.trialRemaining.daysLeft
                            : (t.daysLeft || 0),
                        rankingVideosLeft: (me.trialRemaining && me.trialRemaining.rankingVideosLeft != null)
                            ? me.trialRemaining.rankingVideosLeft
                            : (t.rankingVideosLeft != null ? t.rankingVideosLeft : 0),
                        rankingVideosUsed: t.rankingVideosUsed != null ? t.rankingVideosUsed : 0,
                        reason: t.reason
                    };
                    if (me.subscription && me.subscription.type === 'trial') trialInfo.active = true;
                    window._stripeTrialing = !!(me.subscription && me.subscription.status === 'trialing');
                    window._stripePaidActive = !!(me.subscription && me.subscription.status === 'active' && me.subscription.hasAccess);
                    if (me.subscription && me.subscription.type === 'stripe' && me.subscription.hasAccess) {
                        if (me.subscription.status === 'active') {
                            // Paid plan — clear app-trial badge; credits path applies
                            trialInfo = null;
                        } else if (me.subscription.status === 'trialing' && trialInfo && !trialInfo.active) {
                            // Stripe still trialing but app ranking allotment exhausted
                            trialInfo.reason = trialInfo.reason || 'videos_exhausted';
                        }
                    }
                } else {
                    window._stripeTrialing = !!(me.subscription && me.subscription.status === 'trialing');
                    window._stripePaidActive = !!(me.subscription && me.subscription.status === 'active' && me.subscription.hasAccess);
                }
                updateTrialBadge();
            }
        } catch (e) { console.warn('Trial:', e); }
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
        if (step < 4) scheduleDraftSave();
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
        if (file.size > 100 * 1024 * 1024) { alert('File too large: ' + file.name + '. Maximum 100MB per clip.'); return; }
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
                        if (idx >= 0) {
                            clips[idx] = {
                                filename: data.filename, url: data.url, duration: data.duration,
                                originalDuration: data.duration, label: '', startTime: 0, endTime: data.duration,
                                originalName: file.name, uploading: false, cleaning: false, textCleaned: false
                            };
                            renderClipList(); updateNextButton();
                        }
                    } else { clips = clips.filter(function(c) { return c._tempId !== tempId; }); alert('Upload failed: ' + (data.error || 'Server error')); }
                } catch (e) { clips = clips.filter(function(c) { return c._tempId !== tempId; }); alert('Upload failed'); }
                renderClipList(); updateNextButton(); resolve();
            };
            xhr.onerror = function() { clips = clips.filter(function(c) { return c._tempId !== tempId; }); alert('Upload failed: Network error.'); renderClipList(); updateNextButton(); resolve(); };
            xhr.ontimeout = function() { clips = clips.filter(function(c) { return c._tempId !== tempId; }); alert('Upload timed out.'); renderClipList(); updateNextButton(); resolve(); };
            xhr.timeout = 300000; xhr.send(fd);
        });
    }

    function renderClipList() {
        var list = document.getElementById('clip-list'); var html = '';
        clips.forEach(function(clip, i) {
            html += '<div class="clip-item">';
            html += '<div class="clip-num">' + (i + 1) + '</div>';
            if (clip.downloading || clip.uploading || clip.cleaning) {
                html += '<div class="clip-thumb is-loading"><div class="spinner"></div></div>';
            } else if (clip.url) {
                html += '<video class="clip-thumb" src="' + clip.url + '" muted playsinline preload="metadata"></video>';
            } else {
                html += '<div class="clip-thumb" style="display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:0.65rem">—</div>';
            }
            html += '<div class="clip-info" style="flex:1;min-width:0">';
            if (clip.downloading) {
                html += '<div class="clip-name">Downloading from link…</div>';
                html += '<div class="clip-meta">' + escapeHtml(clip.originalName || 'video') +
                    (clip.waitSecs != null ? ' · ' + clip.waitSecs + 's elapsed' : '') + '</div>';
                html += '<div class="clip-meta" style="color:var(--accent)">Still working — TikTok/YouTube can take up to ~90s</div>';
            } else if (clip.uploading) {
                html += '<div class="clip-name">Uploading ' + escapeHtml(clip.originalName || '') + ' (' + (clip.uploadPct || 0) + '%)</div>';
                html += '<div class="clip-meta">Keep this tab open</div>';
            } else if (clip.cleaning) {
                html += '<div class="clip-name">Removing burned-in text…</div>';
                html += '<div class="clip-meta">' + escapeHtml(clip.originalName || '') +
                    (clip.waitSecs != null ? ' · ' + clip.waitSecs + 's elapsed' : '') + '</div>';
                html += '<div class="clip-meta" style="color:var(--accent)">Replicate is processing — usually 30–120s</div>';
            } else if (clip.importFailed) {
                html += '<div class="clip-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
                    escapeHtml(clip.originalName || 'Import failed') + '</div>';
                html += '<div class="clip-meta" style="color:var(--red)">' +
                    escapeHtml(String(clip.textCleanError || clip.importError || 'Import failed').slice(0, 100)) + '</div>';
            } else {
                html += '<div class="clip-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
                    escapeHtml(clip.originalName || clip.filename || '') + '</div>';
                html += '<div class="clip-meta">' + (clip.duration || 0).toFixed(1) + 's' +
                    (clip.textCleaned ? ' · text cleaned' : '') + '</div>';
                if (clip.textCleanError) {
                    html += '<div class="clip-meta" style="color:var(--red)">' +
                        escapeHtml(String(clip.textCleanError).slice(0, 80)) + '</div>';
                }
            }
            html += '</div>';
            if (clip.importFailed) {
                html += '<div class="clip-actions">';
                html += '<button type="button" class="btn-mini danger" onclick="window._rk.remove(' + i + ')">Dismiss</button>';
                html += '</div>';
            } else if (!clip.uploading && !clip.downloading && !clip.cleaning && clip.filename) {
                html += '<div class="clip-actions">';
                if (!clip.textCleaned) {
                    html += '<button type="button" class="btn-mini" onclick="window._rk.cleanText(' + i + ')">Remove text</button>';
                } else {
                    html += '<button type="button" class="btn-mini" disabled style="opacity:0.5">Text cleaned</button>';
                }
                html += '<button type="button" class="btn-mini danger" onclick="window._rk.remove(' + i + ')">Remove clip</button>';
                html += '</div>';
            }
            html += '</div>';
        });
        list.innerHTML = html;
    }

    function shortUrlLabel(url) {
        try {
            var u = new URL(url);
            var host = u.hostname.replace(/^www\./, '');
            var tail = u.pathname.split('/').filter(Boolean).slice(-2).join('/');
            var s = host + '/' + tail;
            return s.length > 52 ? s.slice(0, 52) + '…' : s;
        } catch (e) {
            return url.length > 48 ? url.slice(0, 48) + '…' : url;
        }
    }

    function setImportProgress(visible, opts) {
        opts = opts || {};
        var panel = document.getElementById('import-progress');
        if (!panel) return;
        if (!visible) {
            panel.classList.add('hidden');
            return;
        }
        panel.classList.remove('hidden');
        var done = opts.done || 0;
        var total = opts.total || 0;
        var label = opts.label || 'Downloading clips…';
        var hint = opts.hint || 'Keep this tab open — imports continue in the background.';
        var fill = document.getElementById('import-progress-fill');
        var labelEl = document.getElementById('import-progress-label');
        var countEl = document.getElementById('import-progress-count');
        var hintEl = document.getElementById('import-progress-hint');
        if (labelEl) labelEl.textContent = label;
        if (countEl) countEl.textContent = done + ' / ' + total;
        if (hintEl) hintEl.textContent = hint;
        if (fill) fill.style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
    }

    function startElapsedTicker(clip) {
        clip._startedAt = Date.now();
        clip.waitSecs = 0;
        if (clip._tick) clearInterval(clip._tick);
        clip._tick = setInterval(function() {
            if (!clip.downloading && !clip.cleaning) {
                clearInterval(clip._tick);
                clip._tick = null;
                return;
            }
            clip.waitSecs = Math.round((Date.now() - clip._startedAt) / 1000);
            renderClipList();
        }, 1000);
    }

    function stopElapsedTicker(clip) {
        if (clip && clip._tick) {
            clearInterval(clip._tick);
            clip._tick = null;
        }
        if (clip) clip.waitSecs = null;
    }

    async function cleanTextClip(clipIndex, fromTrim) {
        var clip = clips[clipIndex];
        if (!clip || !clip.filename || clip.textCleaned || clip.cleaning) return;

        clip.cleaning = true;
        clip.textCleanError = null;
        startElapsedTicker(clip);
        renderClipList();
        updateNextButton();
        updateTrimCleanUi(fromTrim, 'Removing burned-in text… this can take a minute', false);

        try {
            var res = await apiFetch('/api/studio/ranking/clean-text', {
                method: 'POST',
                headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
                body: JSON.stringify({ filename: clip.filename })
            });
            var data = await res.json();
            if (res.ok && data.success) {
                var prevStart = clip.startTime || 0;
                var prevEnd = clip.endTime != null ? clip.endTime : clip.duration;
                var prevOrig = clip.originalDuration || clip.duration;
                clip.duration = data.duration || clip.duration;
                clip.originalDuration = data.duration || clip.originalDuration;
                if (prevOrig > 0 && clip.originalDuration) {
                    var scale = clip.originalDuration / prevOrig;
                    clip.startTime = Math.max(0, prevStart * scale);
                    clip.endTime = Math.min(clip.originalDuration, prevEnd * scale);
                } else {
                    clip.endTime = data.duration || clip.endTime;
                }
                clip.url = data.url + '?t=' + Date.now();
                clip.textCleaned = true;
                updateTrimCleanUi(fromTrim, 'Text removed — preview updated', true);
                if (fromTrim && currentTrimIndex === clipIndex) showTrimClip(clipIndex);
            } else {
                clip.textCleanError = data.error || 'Text clean failed';
                updateTrimCleanUi(fromTrim, clip.textCleanError, false);
            }
        } catch (err) {
            clip.textCleanError = err.message;
            updateTrimCleanUi(fromTrim, err.message, false);
        }
        stopElapsedTicker(clip);
        clip.cleaning = false;
        renderClipList();
        updateNextButton();
        updateTrimCleanButton();
    }

    function updateTrimCleanUi(fromTrim, message, ok) {
        if (!fromTrim) return;
        var el = document.getElementById('trim-clean-status');
        if (!el) return;
        el.classList.remove('hidden');
        el.style.color = ok ? 'var(--green)' : 'var(--text-dim)';
        if (/fail|error|not configured|unavailable/i.test(message || '')) el.style.color = 'var(--red)';
        el.textContent = message || '';
    }

    function updateTrimCleanButton() {
        var btn = document.getElementById('btn-trim-clean-text');
        if (!btn) return;
        var clip = clips[currentTrimIndex];
        if (!clip) { btn.disabled = true; return; }
        btn.disabled = !!clip.cleaning || !!clip.textCleaned || !clip.filename;
        btn.textContent = clip.textCleaned
            ? 'Text already cleaned'
            : (clip.cleaning ? 'Removing text…' : 'Remove burned-in text on this clip');
    }

    function updateNextButton() {
        var busy = clips.some(function(c) { return c.uploading || c.downloading || c.cleaning; });
        var ready = clips.filter(function(c) {
            return !c.uploading && !c.downloading && !c.cleaning && !c.importFailed && c.filename;
        }).length;
        document.getElementById('btn-next-trim').disabled = ready < 2 || busy;
    }

    function removeClip(index) {
        scheduleDraftSave();
        var clip = clips[index];
        if (clip) stopElapsedTicker(clip);
        if (clip && clip.filename) apiFetch('/api/studio/ranking/clip/' + clip.filename, { method: 'DELETE' }).catch(function(){});
        clips.splice(index, 1); renderClipList(); updateNextButton();
    }

    // ==================== URL IMPORT ====================
    function parseImportUrls(raw) {
        var text = String(raw || '');
        var found = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
        var seen = {};
        var out = [];
        for (var i = 0; i < found.length; i++) {
            var u = found[i].replace(/[),.;]+$/g, '');
            if (seen[u]) continue;
            seen[u] = true;
            out.push(u);
        }
        return out;
    }

    async function importOneUrl(url, placeholderIndex) {
        var res = await apiFetch('/api/studio/ranking/import-url', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
            body: JSON.stringify({ url: url })
        });
        var data = await res.json();
        if (!res.ok || !data.success) {
            throw new Error(data.error || 'Import failed');
        }
        var clip = clips[placeholderIndex];
        if (!clip) return data;
        stopElapsedTicker(clip);
        clips[placeholderIndex] = {
            filename: data.filename, url: data.url,
            duration: data.duration, originalDuration: data.duration,
            label: '', startTime: 0, endTime: data.duration,
            originalName: shortUrlLabel(url),
            uploading: false, downloading: false, cleaning: false, textCleaned: false
        };
        renderClipList();
        updateNextButton();
        return data;
    }

    async function importFromUrl() {
        var input = document.getElementById('url-input');
        var btn = document.getElementById('btn-import-url');
        var status = document.getElementById('url-status');
        var urls = parseImportUrls(input.value);

        if (!urls.length) {
            status.classList.remove('hidden');
            status.style.color = 'var(--red)';
            status.textContent = 'Paste one or more http(s) links first.';
            return;
        }
        if (clips.length >= 10) { alert('Maximum 10 clips reached'); return; }

        var room = 10 - clips.filter(function(c) { return !c.importFailed; }).length;
        if (room <= 0) { alert('Maximum 10 clips reached'); return; }
        if (urls.length > room) urls = urls.slice(0, room);

        btn.disabled = true;
        input.disabled = true;
        status.classList.add('hidden');

        var placeholders = [];
        for (var p = 0; p < urls.length; p++) {
            var ph = {
                _tempId: 'dl-' + Date.now() + '-' + p,
                downloading: true,
                originalName: shortUrlLabel(urls[p]),
                importUrl: urls[p],
                filename: null,
                url: null,
                duration: 0
            };
            startElapsedTicker(ph);
            clips.push(ph);
            placeholders.push(clips.length - 1);
        }
        renderClipList();
        updateNextButton();

        var ok = 0;
        var fail = 0;
        var startedAll = Date.now();
        setImportProgress(true, {
            done: 0,
            total: urls.length,
            label: 'Downloading clip 1 of ' + urls.length + '…',
            hint: 'Still working — TikTok/YouTube imports often take 20–90 seconds each. Previews appear as each finishes.'
        });

        for (var i = 0; i < urls.length; i++) {
            var idx = placeholders[i];
            var elapsedAll = Math.round((Date.now() - startedAll) / 1000);
            btn.textContent = 'Downloading ' + (i + 1) + '/' + urls.length + '…';
            setImportProgress(true, {
                done: i,
                total: urls.length,
                label: 'Downloading clip ' + (i + 1) + ' of ' + urls.length + '…',
                hint: 'Elapsed ' + elapsedAll + 's total · keep this tab open. Finished clips show a preview below.'
            });
            try {
                await importOneUrl(urls[i], idx);
                ok++;
            } catch (err) {
                fail++;
                console.warn('Import failed for', urls[i], err.message);
                var failed = clips[idx];
                if (failed) {
                    stopElapsedTicker(failed);
                    failed.downloading = false;
                    failed.importFailed = true;
                    failed.importError = err.message || 'Import failed';
                    failed.originalName = shortUrlLabel(urls[i]);
                }
                renderClipList();
            }
            setImportProgress(true, {
                done: i + 1,
                total: urls.length,
                label: (i + 1 < urls.length)
                    ? ('Downloaded ' + (i + 1) + ' of ' + urls.length + ' — starting next…')
                    : ('Finished ' + (i + 1) + ' of ' + urls.length),
                hint: fail
                    ? (ok + ' imported, ' + fail + ' failed so far. You can dismiss failures and keep going.')
                    : 'Previews appear under the list as each download completes.'
            });
        }

        input.value = '';
        input.disabled = false;
        btn.disabled = false;
        btn.textContent = 'Import links';
        updateNextButton();

        var totalSec = Math.round((Date.now() - startedAll) / 1000);
        if (ok && !fail) {
            setImportProgress(true, {
                done: urls.length,
                total: urls.length,
                label: 'Imported ' + ok + ' clip' + (ok === 1 ? '' : 's') + ' in ' + totalSec + 's',
                hint: 'Preview below — use Remove text only on clips that need it.'
            });
            setTimeout(function() { setImportProgress(false); }, 4000);
            status.classList.remove('hidden');
            status.style.color = 'var(--green)';
            status.textContent = 'Imported ' + ok + ' clip' + (ok === 1 ? '' : 's') + '.';
            setTimeout(function() { status.classList.add('hidden'); }, 4500);
        } else if (ok && fail) {
            setImportProgress(true, {
                done: urls.length,
                total: urls.length,
                label: 'Imported ' + ok + ', failed ' + fail,
                hint: 'Dismiss failed rows or retry those links. Successful clips are ready to preview.'
            });
            status.classList.remove('hidden');
            status.style.color = 'var(--text-muted)';
            status.textContent = 'Imported ' + ok + ', failed ' + fail + '.';
        } else {
            setImportProgress(false);
            status.classList.remove('hidden');
            status.style.color = 'var(--red)';
            status.textContent = 'All imports failed — try uploading the files instead.';
        }
    }

    function initUrlImport() {
        document.getElementById('btn-import-url').addEventListener('click', importFromUrl);
        document.getElementById('url-input').addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); importFromUrl(); }
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
        updateTrimCleanButton();
        var cleanStatus = document.getElementById('trim-clean-status');
        if (cleanStatus) {
            if (clip.textCleaned) {
                cleanStatus.classList.remove('hidden');
                cleanStatus.style.color = 'var(--green)';
                cleanStatus.textContent = 'Text already cleaned on this clip';
            } else {
                cleanStatus.classList.add('hidden');
                cleanStatus.textContent = '';
            }
        }
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
        var cleanBtn = document.getElementById('btn-trim-clean-text');
        if (cleanBtn) {
            cleanBtn.addEventListener('click', function() {
                cleanTextClip(currentTrimIndex, true);
            });
        }
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
            var enableCommentary = this.checked;
            document.getElementById('btn-assemble').textContent = assembleButtonLabel(enableCommentary);
            document.getElementById('voice-picker').style.display = this.checked ? '' : 'none';
            document.getElementById('subtitle-settings').style.display = this.checked ? '' : 'none';
            renderPreview('preview-dash');
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
                renderPreview('preview-dash');
            });
        }
        // Subtitle color swatches
        var subColorMap = { yellow: '#facc15', white: '#ffffff', cyan: '#22d3ee', green: '#34d399', red: '#f87171', pink: '#f472b6', orange: '#fb923c' };
        document.querySelectorAll('.sub-color-swatch').forEach(function(btn) {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.sub-color-swatch').forEach(function(b) { b.classList.remove('active'); });
                btn.classList.add('active');
                subtitleColor = btn.dataset.color;
                var preview = document.getElementById('subtitle-preview');
                if (preview) preview.style.color = subColorMap[subtitleColor] || '#facc15';
                renderPreview('preview-dash');
            });
        });
        // Subtitle font change updates preview
        var subFontEl = document.getElementById('subtitle-font');
        if (subFontEl) {
            subFontEl.addEventListener('change', function() {
                var preview = document.getElementById('subtitle-preview');
                if (preview) preview.style.fontFamily = subFontEl.value;
                renderPreview('preview-dash');
            });
        }
    }

    function applyStylePreset(id) {
        var p = STYLE_PRESETS[id];
        if (!p) return;
        stylePreset = id;
        colorPalette = p.colorPalette;
        checkeredMode = !!p.checkeredMode;
        subtitleColor = p.subtitleColor;
        layout = {
            listX: p.layout.listX,
            titleY: p.layout.titleY,
            titleSize: p.layout.titleSize,
            lineSpacing: p.layout.lineSpacing,
            numSize: p.layout.numSize
        };

        document.querySelectorAll('.style-preset').forEach(function(b) {
            b.classList.toggle('active', b.dataset.preset === id);
        });
        document.querySelectorAll('.color-swatch').forEach(function(b) {
            b.classList.toggle('active', b.dataset.color === colorPalette);
        });
        var check = document.getElementById('checkered-toggle');
        if (check) check.checked = checkeredMode;
        var fontEl = document.getElementById('subtitle-font');
        if (fontEl) fontEl.value = p.subtitleFont;
        var subY = document.getElementById('subtitle-y');
        var subYVal = document.getElementById('subtitle-y-val');
        if (subY) { subY.value = p.subtitleY; if (subYVal) subYVal.textContent = p.subtitleY + '%'; }
        document.querySelectorAll('.sub-color-swatch').forEach(function(b) {
            b.classList.toggle('active', b.dataset.color === subtitleColor);
        });
        var sample = document.getElementById('subtitle-preview');
        if (sample) {
            sample.style.fontFamily = p.subtitleFont;
            sample.style.color = ({ yellow:'#facc15', white:'#ffffff', cyan:'#22d3ee', green:'#34d399', red:'#f87171', pink:'#f472b6', orange:'#fb923c' })[subtitleColor] || '#facc15';
        }
        // Sync position sliders
        ['list-x','title-y','title-size','line-spacing','num-size'].forEach(function(suffix) {
            var map = { 'list-x': 'listX', 'title-y': 'titleY', 'title-size': 'titleSize', 'line-spacing': 'lineSpacing', 'num-size': 'numSize' };
            var key = map[suffix];
            var el = document.getElementById('pos-' + suffix);
            var valEl = document.getElementById('pos-' + suffix + '-val');
            if (el) el.value = layout[key];
            if (valEl) valEl.textContent = (key === 'titleSize' || key === 'lineSpacing' || key === 'numSize') ? layout[key] : layout[key] + '%';
        });
        renderPreview('preview-dash');
    }

    function initStylePresets() {
        document.querySelectorAll('.style-preset').forEach(function(btn) {
            btn.addEventListener('click', function() { applyStylePreset(btn.dataset.preset); });
        });
        // Click phone preview to cycle which number looks active
        var frame = document.getElementById('preview-dash');
        if (frame) {
            frame.style.cursor = 'pointer';
            frame.title = 'Click to preview next clip highlight';
            frame.addEventListener('click', function() {
                var n = clips.filter(function(c) { return !c.uploading; }).length;
                if (n < 1) return;
                previewActiveClip = (previewActiveClip + 1) % n;
                renderPreview('preview-dash');
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
            valEl.textContent = (key === 'titleSize' || key === 'lineSpacing' || key === 'numSize') ? layout[key] : layout[key] + '%';
            el.addEventListener('input', function() {
                layout[key] = parseInt(el.value);
                valEl.textContent = (key === 'titleSize' || key === 'lineSpacing' || key === 'numSize') ? layout[key] : layout[key] + '%';
                renderPreview('preview-dash');
            });
        }
        bind('pos-list-x', 'listX');
        bind('pos-title-y', 'titleY');
        bind('pos-title-size', 'titleSize');
        bind('pos-line-spacing', 'lineSpacing');
        bind('pos-num-size', 'numSize');
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

        var viral = stylePreset === 'viral' || stylePreset === 'bold';
        var html = '<div class="pv-bars top"></div><div class="pv-bars bottom"></div><div class="pv-bg"></div>';

        var titleYPct = layout.titleY;
        var titleFontRem = (layout.titleSize / 48) * 0.7;
        if (viral && titleText) {
            html += '<div style="position:absolute;top:0;left:0;right:0;height:14%;background:#000;z-index:2"></div>';
            var tw = titleText.trim().split(/\s+/).filter(Boolean);
            var viralColors = ['#ffffff', '#f472b6', '#f472b6', '#facc15', '#facc15', '#22d3ee'];
            var titleHtml = tw.map(function(w, i) {
                var col = viralColors[Math.min(i, viralColors.length - 1)];
                if (hlWord && w.toLowerCase() === hlWord.toLowerCase()) col = '#facc15';
                return '<span style="color:' + col + '">' + escapeHtml(w.toUpperCase()) + '</span>';
            }).join(' ');
            html += '<div class="pv-title" style="top:2%;z-index:3"><div class="pv-title-text" style="font-size:' + titleFontRem.toFixed(2) + 'rem;font-weight:900;line-height:1.15;text-align:center;padding:0 0.3rem">' + titleHtml + '</div></div>';
            var activeIdx = isTrim ? currentTrimIndex : Math.min(previewActiveClip, totalClips - 1);
            var activeClip = clips[activeIdx];
            var rankNum = totalClips - activeIdx;
            var rankLab = (activeClip && activeClip.label) ? String(activeClip.label).toUpperCase() : 'MOMENT';
            html += '<div style="position:absolute;top:15%;left:0;right:0;text-align:center;z-index:3;font-weight:900;font-size:0.78rem;color:#fff;-webkit-text-stroke:1px #000;text-shadow:0 0 2px #000">' + rankNum + '. ' + escapeHtml(rankLab) + '</div>';
        } else if (titleText) {
            var titleHtmlClassic = escapeHtml(titleText);
            if (hlWord) {
                var re = new RegExp('(' + escapeRegex(hlWord) + ')', 'i');
                titleHtmlClassic = titleHtmlClassic.replace(re, '<span style="color:' + colors.hl + '">$1</span>');
            }
            html += '<div class="pv-title" style="top:' + titleYPct + '%"><div class="pv-title-text" style="font-size:' + titleFontRem.toFixed(2) + 'rem">' + titleHtmlClassic + '</div></div>';
        }

        if (!viral) {
            var listXPct = layout.listX;
            var gapPx = Math.round((layout.lineSpacing / 65) * 3);
            html += '<div class="pv-list" style="left:' + listXPct + '%;gap:' + gapPx + 'px">';

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
                    var actIdx = Math.min(previewActiveClip, totalClips - 1);
                    if (clipIdx < actIdx) { numClass = 'done'; labelClass = ''; }
                    else if (clipIdx === actIdx) { numClass = 'active'; labelClass = ''; }
                    else { numClass = 'dim'; labelClass = 'dim'; }
                }

                if (numClass === 'active') {
                    numColor = 'color:' + colors.active + ';';
                } else if (numClass === 'done') {
                    if (checkeredMode) {
                        numColor = (row % 2 === 0) ? 'color:' + colors.done + ';' : 'color:#ffffff;';
                    } else {
                        numColor = 'color:' + colors.done + ';';
                    }
                }

                var numFontRem = (layout.numSize / 50) * 0.65;
                var numActiveFontRem = (layout.numSize / 50) * 0.72;
                var numFontStyle = (numClass === 'active') ? 'font-size:' + numActiveFontRem.toFixed(2) + 'rem;' : 'font-size:' + numFontRem.toFixed(2) + 'rem;';

                html += '<div class="pv-row"><div class="pv-num ' + numClass + '" style="' + numColor + numFontStyle + '">' + num + '.</div><div class="pv-label ' + labelClass + '">' + escapeHtml(label) + '</div></div>';
            }
            html += '</div>';
        }

        var commentaryOn = document.getElementById('commentary-toggle') && document.getElementById('commentary-toggle').checked;
        var sampleCap = viral
            ? (previewActiveClip === 0 ? 'watch this you need to see it' : 'subscribe before this goes wrong')
            : 'bro did not see that coming';
        if (commentaryOn || viral || !isTrim) {
            var subY = parseInt((document.getElementById('subtitle-y') || {}).value, 10);
            if (isNaN(subY)) subY = viral ? 50 : 55;
            var subFont = ((document.getElementById('subtitle-font') || {}).value) || (viral ? 'Arial Black' : 'Arial');
            var subColorMap = {
                yellow: '#facc15', cyan: '#22d3ee', green: '#34d399', red: '#f87171',
                pink: '#f472b6', orange: '#fb923c', white: '#ffffff'
            };
            var capColor = subColorMap[subtitleColor] || '#facc15';
            var words = sampleCap.split(/\s+/);
            var mid = Math.max(0, Math.floor(words.length / 2) - 1);
            var capHtml = words.map(function(w, i) {
                return '<span class="pv-cap-word' + (i === mid ? ' on' : '') + '" style="-webkit-text-stroke:1px #000;paint-order:stroke fill">' + escapeHtml(w.toUpperCase()) + '</span>';
            }).join(' ');
            html += '<div class="pv-caption" style="top:' + subY + '%;color:' + capColor + ';font-family:\'' + subFont.replace(/'/g, '') + '\',sans-serif;font-size:' + (viral ? '0.85' : '0.72') + 'rem;font-weight:900;text-align:center;width:100%">' + capHtml + '</div>';
        }

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
        if (trialInfo && !trialInfo.active && window._stripeTrialing && !window._stripePaidActive) {
            showUpgradeModal({
                message: 'Your free trial ranking videos are used up. End your free trial early to start your plan and keep cooking.',
                showEndStripeTrial: true
            });
            return;
        }
        btn.dataset.busy = '1';
        btn.disabled = true; btn.textContent = 'Starting...';
        goToStep(4);
        var pf = document.getElementById('progress-fill'), pt = document.getElementById('progress-text');
        pf.style.width = '0%'; pt.textContent = 'Submitting to Fly...';
        document.getElementById('assembly-progress').classList.remove('hidden');

        try {
            // Trim runs on Fly (or local assemble worker) — send in/out times with the job
            var clipPayload = clips.map(function(clip, i) {
                return {
                    filename: clip.filename,
                    number: clips.length - i,
                    label: clip.label || '',
                    startTime: clip.startTime || 0,
                    endTime: clip.endTime != null ? clip.endTime : clip.duration,
                    originalDuration: clip.originalDuration || clip.duration
                };
            });

            pf.style.width = '20%';
            pt.textContent = 'Submitting job to Fly (trim + assemble)...';

            var selectedVoice = document.getElementById('voice-picker').value || 'Kore';
            var selectedFont = document.getElementById('subtitle-font').value || 'Arial';
            var selectedSubY = parseInt(document.getElementById('subtitle-y').value) || 55;
            var aRes = await apiFetch('/api/studio/ranking/assemble', {
                method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
                body: JSON.stringify({
                    clips: clipPayload,
                    title: { text: document.getElementById('title-text').value || '', highlightWord: document.getElementById('title-highlight').value || '' },
                    layout: { listXPercent: layout.listX, titleYPercent: layout.titleY, titleFontSize: layout.titleSize, lineSpacing: layout.lineSpacing, numSize: layout.numSize },
                    commentary: enableCommentary,
                    voiceName: selectedVoice,
                    colorPalette: colorPalette,
                    checkeredMode: checkeredMode,
                    subtitleFont: selectedFont,
                    subtitleY: selectedSubY,
                    subtitleColor: subtitleColor,
                    stylePreset: stylePreset
                })
            });
            var aData = await aRes.json();
            if (aRes.status === 402 || !aData.success) {
                if (aRes.status === 402 && (aData.needsCard || aData.upgradeRequired || aData.trialExhausted || (aData.trial && !aData.trial.active))) {
                    showUpgradeModal({
                        message: aData.message || (aData.needsCard
                            ? 'Add a card to start your free challenge and cook this video. You will not be charged today.'
                            : 'Your free trial ranking videos are used up. End your free trial early to start your plan and keep cooking.'),
                        showEndStripeTrial: !!(aData.showEndStripeTrial || aData.trialExhausted || window._stripeTrialing)
                    });
                }
                throw new Error(aData.message || aData.error || 'Assembly failed');
            }
            if (aData.trial) {
                trialInfo = {
                    active: !!(aData.usingTrial || (aData.trial && aData.trial.active)),
                    daysLeft: aData.trial.daysLeft || 0,
                    rankingVideosLeft: aData.trial.rankingVideosLeft || 0,
                    reason: aData.trial.reason
                };
                updateTrialBadge();
            }

            var jobId = aData.jobId;
            pf.style.width = '30%';
            pt.textContent = enableCommentary
                ? 'Generating AI commentary... you can close this tab — progress is saved'
                : 'Assembling video... you can close this tab — progress is saved';
            await saveDraftNow();
            await pollJobUntilDone(jobId, pf, pt, btn, enableCommentary);
        } catch (err) {
            pf.style.width = '0%'; pt.textContent = 'Error: ' + err.message;
            delete btn.dataset.busy;
            btn.disabled = false;
            btn.textContent = assembleButtonLabel(enableCommentary);
            loadCredits();
        }
    }

    function showResult(data) {
        document.getElementById('assembly-progress').classList.add('hidden');
        // Project finished — keep style prefs, drop clip draft so next open is clean
        saveSettingsPrefs();
        try {
            localStorage.removeItem(DRAFT_LS_KEY);
            localStorage.removeItem('viewhunt_ranking_active_job');
        } catch (e) {}
        apiFetch('/api/studio/ranking/draft', { method: 'DELETE' }).catch(function() {});

        var v = document.getElementById('result-video');
        var url = data && data.videoUrl;
        if (!url) {
            document.getElementById('result-info').textContent =
                'Video finished but no download URL was returned. Re-run assemble.';
            document.getElementById('result-info').classList.remove('hidden');
            document.getElementById('result-actions').classList.remove('hidden');
            v.classList.add('hidden');
            return;
        }
        v.onerror = function() {
            document.getElementById('result-info').textContent =
                'Could not play this file (missing or not a video). Re-run assemble — storage upload may have failed.';
            document.getElementById('result-info').classList.remove('hidden');
        };
        v.src = url;
        v.classList.remove('hidden');
        v.load();
        document.getElementById('result-info').textContent = data.clipCount + ' clips, ' + data.duration.toFixed(1) + 's' + (data.hasCommentary ? ' (with commentary)' : '');
        document.getElementById('result-info').classList.remove('hidden');
        document.getElementById('result-actions').classList.remove('hidden');
        document.getElementById('btn-download').href = url;
        document.getElementById('btn-download').setAttribute('download', 'ranking-video.mp4');
    }

    function moveUp(i) { if (i <= 0) return; var x = clips.splice(i, 1)[0]; clips.splice(i - 1, 0, x); renderOrderList(); renderPreview('preview-dash'); }
    function moveDown(i) { if (i >= clips.length - 1) return; var x = clips.splice(i, 1)[0]; clips.splice(i + 1, 0, x); renderOrderList(); renderPreview('preview-dash'); }
    function retrim(i) { currentTrimIndex = i; goToStep(2); showTrimClip(i); }

    // ==================== INIT ====================
    function init() {
        loadCredits(); initUpload(); initUrlImport(); initTimeline(); initPlayControls(); initTrimControls(); initTitleControls(); initPositionControls(); initStylePresets();
        wireUpgradeModal();
        document.getElementById('btn-next-trim').addEventListener('click', startTrimming);
        document.getElementById('btn-assemble').addEventListener('click', assembleVideo);
        ['title-text', 'title-highlight', 'voice-picker', 'subtitle-font', 'subtitle-y', 'commentary-toggle'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('change', scheduleDraftSave);
            if (el) el.addEventListener('input', scheduleDraftSave);
        });
        document.getElementById('btn-new').addEventListener('click', function() {
            saveSettingsPrefs();
            clips = [];
            currentTrimIndex = 0;
            activeJobId = null;
            hideResumeBanner();
            try {
                localStorage.removeItem(DRAFT_LS_KEY);
                localStorage.removeItem('viewhunt_ranking_active_job');
            } catch (e) {}
            apiFetch('/api/studio/ranking/draft', { method: 'DELETE' }).catch(function() {});
            // Keep last title/style; only clear clips & result
            var prefs = loadSettingsPrefs();
            if (prefs) applySettingsPrefs(prefs);
            else applyStylePreset('viral');
            renderClipList();
            updateNextButton();
            document.getElementById('result-video').classList.add('hidden');
            document.getElementById('result-info').classList.add('hidden');
            document.getElementById('result-actions').classList.add('hidden');
            document.getElementById('btn-assemble').disabled = false;
            document.getElementById('btn-assemble').textContent = assembleButtonLabel(
                !!(document.getElementById('commentary-toggle') && document.getElementById('commentary-toggle').checked)
            );
            goToStep(1);
        });
        goToStep(1);
        applyStylePreset(stylePreset || 'viral');
        var ctInit = document.getElementById('commentary-toggle');
        if (ctInit && ctInit.checked) {
            var vp = document.getElementById('voice-picker');
            var ss = document.getElementById('subtitle-settings');
            if (vp) vp.style.display = '';
            if (ss) ss.style.display = '';
        }
        resumeSession();

        // Returned from Stripe plan checkout — keep them cooking
        try {
            var params = new URLSearchParams(window.location.search || '');
            var ok = params.get('success');
            if (ok === 'trial_started' || ok === 'subscription_activated') {
                showResumeBanner(
                    'You\'re in — free challenge active. Hit Assemble Video to finish cooking.',
                    '<button type="button" class="btn btn-primary btn-sm" id="btn-dismiss-draft">Got it</button>'
                );
                var got = document.getElementById('btn-dismiss-draft');
                if (got) got.addEventListener('click', hideResumeBanner);
                if (window.history && window.history.replaceState) {
                    window.history.replaceState({}, '', '/studio/ranking');
                }
            }
        } catch (e) {}
    }

    window._rk = {
        remove: removeClip,
        moveUp: moveUp,
        moveDown: moveDown,
        retrim: retrim,
        cleanText: function(i) { cleanTextClip(i, false); }
    };
    init();
})();
