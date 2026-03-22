/* Transcript Extractor — Frontend */
(function() {
    var token = localStorage.getItem('viewhunt_token') || localStorage.getItem('token');
    if (!token) { window.location.replace('/'); return; }

    var hasPaidAccess = false;
    var FREE_LIMIT = 10;
    var PRO_LIMIT = 100;

    fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } })
        .then(function(r) { return r.json(); })
        .then(function(d) {
            var sub = d.subscription || {};
            hasPaidAccess = sub.type === 'admin' || sub.type === 'stripe' || sub.type === 'beta' || sub.type === 'invite';
            if (sub.type === 'stripe' && !sub.hasAccess) hasPaidAccess = false;
            updateLimitUI();
        })
        .catch(function() {});

    function updateLimitUI() {
        var limitNote = document.getElementById('limit-note');
        var countSelect = document.getElementById('video-count');
        if (!hasPaidAccess) {
            limitNote.style.display = 'block';
            // Disable options above 10 for free users
            for (var i = 0; i < countSelect.options.length; i++) {
                if (parseInt(countSelect.options[i].value) > FREE_LIMIT) {
                    countSelect.options[i].disabled = true;
                    countSelect.options[i].textContent += ' (Pro)';
                }
            }
        }
    }

    window.setTab = function(tab) {
        document.getElementById('tab-video').className = 'tab-btn' + (tab === 'video' ? ' active' : '');
        document.getElementById('tab-channel').className = 'tab-btn' + (tab === 'channel' ? ' active' : '');
        document.getElementById('video-mode').style.display = tab === 'video' ? 'block' : 'none';
        document.getElementById('channel-mode').style.display = tab === 'channel' ? 'block' : 'none';
    };

    function escHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ========== SINGLE VIDEO ==========
    window.extractVideo = async function() {
        var url = document.getElementById('video-url').value.trim();
        if (!url) return alert('Please paste a YouTube video URL.');
        if (url.indexOf('youtube.com') === -1 && url.indexOf('youtu.be') === -1) return alert('Please enter a valid YouTube URL.');

        var btn = document.getElementById('btn-extract-video');
        btn.disabled = true;
        btn.innerHTML = '<span style="display:inline-block;width:18px;height:18px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 0.8s linear infinite;margin-right:0.4rem;vertical-align:middle;"></span> Extracting...';

        try {
            var res = await fetch('/api/studio/transcript/video', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ url: url })
            });
            if (!res.ok) {
                var err = await res.json().catch(function() { return {}; });
                throw new Error(err.error || 'Failed to extract transcript');
            }
            var data = await res.json();
            showResults([data]);
        } catch (e) {
            alert('Error: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = 'Extract Transcript · Free';
        }
    };

    // ========== CHANNEL ==========
    window.extractChannel = async function() {
        var url = document.getElementById('channel-url').value.trim();
        if (!url) return alert('Please paste a YouTube channel URL.');
        if (url.indexOf('youtube.com') === -1) return alert('Please enter a valid YouTube channel URL.');

        var count = parseInt(document.getElementById('video-count').value) || 10;
        var maxAllowed = hasPaidAccess ? PRO_LIMIT : FREE_LIMIT;
        if (count > maxAllowed) count = maxAllowed;

        var btn = document.getElementById('btn-extract-channel');
        btn.disabled = true;
        btn.innerHTML = '<span style="display:inline-block;width:18px;height:18px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 0.8s linear infinite;margin-right:0.4rem;vertical-align:middle;"></span> Fetching channel videos...';

        var progressSection = document.getElementById('progress-section');
        var progressBar = document.getElementById('progress-bar');
        var progressText = document.getElementById('progress-text');
        progressSection.style.display = 'block';
        progressBar.style.width = '5%';
        progressText.innerHTML = '<span style="display:inline-block;width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite;margin-right:0.4rem;vertical-align:middle;"></span> Fetching video list from channel...';

        try {
            // Step 1: Get video list
            var listRes = await fetch('/api/studio/transcript/channel-videos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ channelUrl: url, count: count })
            });
            if (!listRes.ok) {
                var listErr = await listRes.json().catch(function() { return {}; });
                throw new Error(listErr.error || 'Failed to fetch channel videos');
            }
            var listData = await listRes.json();
            var videos = listData.videos || [];
            if (videos.length === 0) throw new Error('No videos found on this channel.');

            var actualCount = videos.length;
            var wasCapped = listData.capped;
            progressBar.style.width = '10%';
            progressText.innerHTML = '<span style="display:inline-block;width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite;margin-right:0.4rem;vertical-align:middle;"></span> Found ' + actualCount + ' videos. Extracting transcripts...';

            // Build a lookup of views/publishedAt from the channel video list
            var videoMeta = {};
            for (var m = 0; m < videos.length; m++) {
                videoMeta[videos[m].videoId] = { views: videos[m].views || '0', publishedAt: videos[m].publishedAt || '' };
            }

            // Step 2: Extract transcripts one by one
            var results = [];
            for (var i = 0; i < videos.length; i++) {
                var pct = 10 + Math.round((i / videos.length) * 85);
                progressBar.style.width = pct + '%';
                progressText.innerHTML = '<span style="display:inline-block;width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite;margin-right:0.4rem;vertical-align:middle;"></span> Extracting ' + (i + 1) + '/' + actualCount + ' — ' + escHtml(videos[i].title || 'Video');

                var vid = videos[i];
                var meta = videoMeta[vid.videoId] || {};
                try {
                    var tRes = await fetch('/api/studio/transcript/video', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                        body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=' + vid.videoId })
                    });
                    if (tRes.ok) {
                        var tData = await tRes.json();
                        tData.views = meta.views;
                        tData.publishedAt = meta.publishedAt;
                        results.push(tData);
                    } else {
                        results.push({ title: vid.title || 'Unknown', transcript: null, error: 'Failed to extract', views: meta.views, publishedAt: meta.publishedAt });
                    }
                } catch (e) {
                    results.push({ title: vid.title || 'Unknown', transcript: null, error: e.message, views: meta.views, publishedAt: meta.publishedAt });
                }
            }

            progressBar.style.width = '100%';
            progressText.textContent = 'Done! ' + results.filter(function(r) { return r.transcript; }).length + '/' + actualCount + ' transcripts extracted.';
            setTimeout(function() { progressSection.style.display = 'none'; }, 2000);

            showResults(results);

            // Show upgrade CTA if capped
            if (wasCapped && !hasPaidAccess) {
                document.getElementById('upgrade-cta').style.display = 'block';
            }

        } catch (e) {
            alert('Error: ' + e.message);
            progressSection.style.display = 'none';
        } finally {
            btn.disabled = false;
            btn.innerHTML = 'Extract Channel Transcripts · Free';
        }
    };

    // ========== HELPERS ==========
    function formatViews(v) {
        var n = parseInt(v);
        if (isNaN(n)) return v || '0';
        if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
        return String(n);
    }

    function formatDate(iso) {
        if (!iso) return '';
        try { var d = new Date(iso); return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
        catch (e) { return iso.split('T')[0] || ''; }
    }

    // ========== RESULTS ==========
    function showResults(results) {
        var section = document.getElementById('results-section');
        var successCount = results.filter(function(r) { return r.transcript; }).length;
        var hasChannelData = results.some(function(r) { return r.views || r.publishedAt; });

        var html = '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.75rem;">';
        html += '<div class="section-title">📋 Results (' + successCount + '/' + results.length + ')</div>';
        html += '<div style="display:flex;gap:0.4rem;align-items:center;">';
        if (successCount > 0) {
            html += '<button class="copy-btn" onclick="copyAll()" style="font-size:0.78rem;padding:0.4rem 0.8rem;">📋 Copy All</button>';
        }
        // CSV button — Pro only
        if (successCount > 0 && hasChannelData) {
            if (hasPaidAccess) {
                html += '<button class="copy-btn csv-btn" onclick="downloadCSV()" style="font-size:0.78rem;padding:0.4rem 0.8rem;background:var(--green-dim);border-color:var(--green);color:var(--green);">📊 Download CSV</button>';
            } else {
                html += '<button class="copy-btn csv-btn" onclick="alert(\'CSV download is a Pro feature. Upgrade to export your data.\')" style="font-size:0.78rem;padding:0.4rem 0.8rem;opacity:0.5;cursor:not-allowed;" title="Pro feature">🔒 CSV (Pro)</button>';
            }
        }
        html += '</div></div>';

        results.forEach(function(r, idx) {
            html += '<div class="result-card">';
            html += '<div class="result-title">' + escHtml(r.title || 'Untitled') + '</div>';
            // Meta line: views, date, duration, author
            var metaParts = [];
            if (r.views) metaParts.push('👁 ' + formatViews(r.views) + ' views');
            if (r.publishedAt) metaParts.push('📅 ' + formatDate(r.publishedAt));
            if (r.duration) metaParts.push(r.duration + 's');
            if (r.author) metaParts.push(escHtml(r.author));
            if (metaParts.length > 0) html += '<div class="result-meta">' + metaParts.join(' · ') + '</div>';
            if (r.transcript) {
                html += '<div class="result-transcript" id="transcript-' + idx + '">' + escHtml(r.transcript) + '</div>';
                html += '<button class="copy-btn" onclick="copySingle(' + idx + ')">Copy transcript</button>';
            } else {
                html += '<div style="font-size:0.78rem;color:var(--red);">No transcript available' + (r.error ? ' — ' + escHtml(r.error) : '') + '</div>';
            }
            html += '</div>';
        });

        section.innerHTML = html;
        section.style.display = 'block';
        section.scrollIntoView({ behavior: 'smooth' });

        // Store for copy-all / CSV
        window._transcriptResults = results;
    }

    window.copySingle = function(idx) {
        var el = document.getElementById('transcript-' + idx);
        if (!el) return;
        navigator.clipboard.writeText(el.textContent).then(function() {
            var btns = el.parentElement.querySelectorAll('.copy-btn');
            var btn = btns[btns.length - 1];
            if (btn) { btn.textContent = '✅ Copied!'; setTimeout(function() { btn.textContent = 'Copy transcript'; }, 1500); }
        });
    };

    window.copyAll = function() {
        var results = window._transcriptResults || [];
        var text = '';
        results.forEach(function(r) {
            if (!r.transcript) return;
            text += '=== ' + (r.title || 'Untitled') + ' ===\n\n';
            text += r.transcript + '\n\n\n';
        });
        navigator.clipboard.writeText(text.trim()).then(function() {
            var btn = document.querySelector('[onclick="copyAll()"]');
            if (btn) { btn.textContent = '✅ Copied!'; setTimeout(function() { btn.textContent = '📋 Copy All'; }, 1500); }
        });
    };

    // ========== CSV DOWNLOAD (Pro only) ==========
    function csvEscape(str) {
        if (!str) return '';
        str = String(str).replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
        if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    window.downloadCSV = function() {
        if (!hasPaidAccess) return alert('CSV download is a Pro feature.');
        var results = window._transcriptResults || [];
        if (results.length === 0) return;

        var rows = ['Title,Views,Upload Date,Transcript'];
        results.forEach(function(r) {
            var title = csvEscape(r.title || 'Untitled');
            var views = r.views || '0';
            var date = r.publishedAt ? r.publishedAt.split('T')[0] : '';
            var transcript = csvEscape(r.transcript || '');
            rows.push(title + ',' + views + ',' + date + ',' + transcript);
        });

        var csv = rows.join('\n');
        var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'transcripts_' + new Date().toISOString().split('T')[0] + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        var btn = document.querySelector('.csv-btn');
        if (btn) { btn.textContent = '✅ Downloaded!'; setTimeout(function() { btn.innerHTML = '📊 Download CSV'; }, 1500); }
    };
})();
