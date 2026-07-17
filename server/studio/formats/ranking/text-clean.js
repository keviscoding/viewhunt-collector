/**
 * Burned-in caption / text overlay removal via Replicate API.
 * Model: hjunior29/video-text-remover (hosted — not custom ML).
 *
 * Env (official name is REPLICATE_API_TOKEN; REPLICATE_API_KEY also accepted):
 *   REPLICATE_API_TOKEN / REPLICATE_API_KEY
 *   APP_URL — public base so Replicate can fetch ranking uploads
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const Replicate = require('replicate');

const MODEL_VERSION =
    'hjunior29/video-text-remover:247c8385f3c6c322110a6787bd2d257acc3a3d60b9ed7da1726a628f72a42c4d';
const VERSION_HASH = MODEL_VERSION.split(':')[1];
const MAX_DATA_URI_BYTES = 8 * 1024 * 1024;

/** Normalize DO-pasted secrets: quotes, Bearer/Token prefix, whitespace. */
function normalizeReplicateToken(raw) {
    if (!raw || typeof raw !== 'string') return '';
    var t = raw.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        t = t.slice(1, -1).trim();
    }
    t = t.replace(/^(Bearer|Token)\s+/i, '').trim();
    return t;
}

function getReplicateToken() {
    return normalizeReplicateToken(
        process.env.REPLICATE_API_TOKEN ||
        process.env.REPLICATE_API_KEY ||
        process.env.REPLICATE_TOKEN ||
        ''
    );
}

function tokenHint(token) {
    if (!token) return 'missing';
    if (!/^r8_/.test(token)) return 'present but does not start with r8_ (wrong key?)';
    return 'present (' + token.length + ' chars, starts ' + token.slice(0, 5) + '…)';
}

function downloadToFile(url, destPath) {
    return new Promise(function(resolve, reject) {
        var mod = url.startsWith('https') ? https : http;
        var file = fs.createWriteStream(destPath);
        mod.get(url, function(res) {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close();
                try { fs.unlinkSync(destPath); } catch (e) {}
                return downloadToFile(res.headers.location, destPath).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                file.close();
                return reject(new Error('Download cleaned video failed: HTTP ' + res.statusCode));
            }
            res.pipe(file);
            file.on('finish', function() { file.close(resolve); });
        }).on('error', function(err) {
            try { fs.unlinkSync(destPath); } catch (e) {}
            reject(err);
        });
    });
}

function resolveOutputUrl(output) {
    if (!output) return null;
    if (typeof output === 'string') return output;
    if (Array.isArray(output) && output[0]) return resolveOutputUrl(output[0]);
    if (typeof output === 'object') {
        if (typeof output.url === 'function') {
            try { return output.url(); } catch (e) {}
        }
        if (typeof output.href === 'string') return output.href;
        if (typeof output.url === 'string') return output.url;
    }
    return null;
}

function toDataUri(filePath) {
    var buf = fs.readFileSync(filePath);
    return 'data:video/mp4;base64,' + buf.toString('base64');
}

function publicClipUrl(filePath) {
    var base = (process.env.APP_URL || process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
    if (!base) return null;
    return base + '/studio/ranking-uploads/' + encodeURIComponent(path.basename(filePath));
}

function friendlyReplicateError(err, token) {
    var msg = (err && err.message) || 'Text clean failed';
    var statusMatch = msg.match(/status\s+(\d+)/i);
    var status = statusMatch ? statusMatch[1] : null;
    var bodyMatch = msg.match(/:\s*(\{[\s\S]*\})\.?\s*$/);
    var detail = '';
    if (bodyMatch) {
        try {
            var j = JSON.parse(bodyMatch[1]);
            detail = j.detail || j.title || j.error || '';
        } catch (e) {
            detail = bodyMatch[1].slice(0, 120);
        }
    }
    var hint = ' (key ' + tokenHint(token) + ')';
    if (status === '401' || status === '403') {
        return 'Replicate auth failed' + hint +
            '. Use the token from replicate.com/account/api-tokens (starts with r8_). ' +
            'On DO set REPLICATE_API_TOKEN (or REPLICATE_API_KEY), no quotes, then redeploy.';
    }
    if (status === '402') return 'Replicate billing required — add credit on replicate.com.';
    if (status === '404') return 'Replicate model/version not found.';
    if (detail) return 'Replicate: ' + String(detail).slice(0, 160) + hint;
    if (status) return 'Replicate HTTP ' + status + hint;
    return (msg.length > 160 ? msg.slice(0, 160) + '…' : msg) + hint;
}

/**
 * Custom fetch that forces Bearer auth (official Replicate scheme).
 */
function bearerFetch(token) {
    return function(url, init) {
        init = init || {};
        var headers = Object.assign({}, init.headers || {});
        headers.Authorization = 'Bearer ' + token;
        return fetch(url, Object.assign({}, init, { headers: headers }));
    };
}

/**
 * @returns {{ ok: boolean, skipped?: boolean, error?: string, tokenHint?: string }}
 */
async function cleanBurnedInText(filePath, options) {
    options = options || {};
    var token = getReplicateToken();
    if (!token) {
        return {
            ok: false,
            skipped: true,
            error: 'REPLICATE_API_TOKEN not configured on the server',
            tokenHint: 'missing'
        };
    }
    if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, error: 'Clip file not found' };
    }

    var replicate = new Replicate({
        auth: token,
        fetch: bearerFetch(token)
    });
    var tmpOut = filePath + '.clean-' + Date.now() + '.mp4';
    var size = fs.statSync(filePath).size;

    var videoInput = options.publicUrl || publicClipUrl(filePath);
    if (!videoInput) {
        if (size <= MAX_DATA_URI_BYTES) {
            videoInput = toDataUri(filePath);
        } else {
            return {
                ok: false,
                error: 'APP_URL not set — needed so Replicate can download the clip (set APP_URL=https://viewhunt.app).'
            };
        }
    }

    try {
        console.log('Text-clean via Replicate:', path.basename(filePath),
            'key=' + tokenHint(token),
            videoInput.indexOf('data:') === 0 ? '(data-uri)' : videoInput);

        // Prefer versioned predictions.create (community models)
        var output = await replicate.run(MODEL_VERSION, {
            input: {
                video: videoInput,
                method: options.method || 'hybrid',
                conf_threshold: options.confThreshold != null ? options.confThreshold : 0.25,
                margin: options.margin != null ? options.margin : 5,
                resolution: options.resolution || '720p',
                detection_interval: options.detectionInterval != null ? options.detectionInterval : 5
            }
        });

        var outUrl = resolveOutputUrl(output);
        if (!outUrl) throw new Error('Replicate returned no output URL');

        await downloadToFile(outUrl, tmpOut);
        var stat = fs.statSync(tmpOut);
        if (stat.size < 1000) throw new Error('Cleaned file too small');

        fs.renameSync(tmpOut, filePath);
        console.log('Text-clean done:', path.basename(filePath), (stat.size / 1024 / 1024).toFixed(1) + 'MB');
        return { ok: true, tokenHint: tokenHint(token) };
    } catch (err) {
        try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch (e) {}
        var friendly = friendlyReplicateError(err, token);
        console.warn('Text-clean failed:', err.message);
        return { ok: false, error: friendly, tokenHint: tokenHint(token) };
    }
}

module.exports = {
    cleanBurnedInText,
    MODEL_VERSION,
    VERSION_HASH,
    getReplicateToken,
    tokenHint
};
