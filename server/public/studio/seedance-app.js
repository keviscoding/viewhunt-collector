/* Seedance 2.0 — Frontend */
(function() {
    var token = localStorage.getItem('viewhunt_token') || localStorage.getItem('token');
    if (!token) { window.location.replace('/'); return; }

    var history = JSON.parse(localStorage.getItem('seedance2_history') || '[]');
    renderHistory();

    window.generate = async function() {
        var prompt = document.getElementById('prompt').value.trim();
        if (!prompt || prompt.length < 3) return alert('Please enter a prompt (at least 3 characters).');

        var firstFrame = document.getElementById('first-frame').value.trim() || null;
        var lastFrame = document.getElementById('last-frame').value.trim() || null;
        var duration = parseInt(document.getElementById('duration').value) || 8;
        var aspectRatio = document.getElementById('aspect-ratio').value || '9:16';
        var generateAudio = document.getElementById('audio-toggle').checked;

        var btn = document.getElementById('btn-generate');
        btn.disabled = true;
        btn.innerHTML = '<span style="display:inline-block;width:18px;height:18px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 0.8s linear infinite;margin-right:0.4rem;vertical-align:middle;"></span> Generating...';

        document.getElementById('progress').style.display = 'block';
        document.getElementById('result').style.display = 'none';
        document.getElementById('progress-text').innerHTML = '<span style="display:inline-block;width:18px;height:18px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite;margin-right:0.4rem;vertical-align:middle;"></span> Sending to Seedance 2.0... This may take 1-3 minutes.';

        try {
            var res = await fetch('/api/studio/seedance2/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({
                    prompt: prompt,
                    firstFrameUrl: firstFrame,
                    lastFrameUrl: lastFrame,
                    duration: duration,
                    aspectRatio: aspectRatio,
                    generateAudio: generateAudio
                })
            });

            var data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Generation failed');

            document.getElementById('progress').style.display = 'none';
            document.getElementById('result').style.display = 'block';
            document.getElementById('result-video').src = data.videoUrl;
            document.getElementById('result-download').href = data.videoUrl;

            // Save to local history
            history.unshift({ prompt: prompt.substring(0, 80), videoUrl: data.videoUrl, date: new Date().toISOString() });
            if (history.length > 20) history = history.slice(0, 20);
            localStorage.setItem('seedance2_history', JSON.stringify(history));
            renderHistory();

        } catch (e) {
            document.getElementById('progress').style.display = 'none';
            alert('Error: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = 'Generate Video · 5 💎';
        }
    };

    function renderHistory() {
        if (history.length === 0) { document.getElementById('history-section').style.display = 'none'; return; }
        document.getElementById('history-section').style.display = 'block';
        var html = '';
        history.forEach(function(h) {
            html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:0.75rem;margin-bottom:0.5rem;display:flex;align-items:center;gap:0.75rem;">';
            html += '<video src="' + h.videoUrl + '" muted style="width:60px;height:60px;object-fit:cover;border-radius:6px;background:var(--surface-2);"></video>';
            html += '<div style="flex:1;min-width:0;">';
            html += '<div style="font-size:0.82rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(h.prompt) + '</div>';
            html += '<div style="font-size:0.72rem;color:var(--text-dim);">' + new Date(h.date).toLocaleDateString() + '</div>';
            html += '</div>';
            html += '<a href="' + h.videoUrl + '" download target="_blank" style="font-size:0.75rem;color:var(--accent);text-decoration:none;white-space:nowrap;">📥</a>';
            html += '</div>';
        });
        document.getElementById('history-list').innerHTML = html;
    }

    function escHtml(s) { return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''; }
})();
