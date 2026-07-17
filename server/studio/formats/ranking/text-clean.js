/**
 * Burned-in caption / text overlay removal via Replicate API.
 * Model: hjunior29/video-text-remover (hosted — not custom ML).
 *
 * Env: REPLICATE_API_KEY (or REPLICATE_API_TOKEN), APP_URL for public clip URLs
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const Replicate = require('replicate');

// Community models require the full version hash (owner/name alone hits models/.../predictions and often fails)
const MODEL_VERSION =
    'hjunior29/video-text-remover:247c8385f3c6c322110a6787bd2d257acc3a3d60b9ed7da1726a628f72a42c4d';
const MAX_DATA_URI_BYTES = 8 * 1024 * 1024;

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
    var name = path.basename(filePath);
    return base + '/studio/ranking-uploads/' + encodeURIComponent(name);
}

function friendlyReplicateError(err) {
    var msg = (err && err.message) || 'Text clean failed';
    // ApiError: "Request to https://api.replicate.com/... failed with status 401 ...: {json}"
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
    if (status === '401' || status === '403') {
        return 'Replicate auth failed — check REPLICATE_API_KEY on DigitalOcean.';
    }
    if (status === '402') {
        return 'Replicate billing required — add credit on replicate.com.';
    }
    if (status === '404') {
        return 'Replicate model not found — version may have changed.';
    }
    if (detail) return 'Replicate: ' + String(detail).slice(0, 160);
    if (status) return 'Replicate HTTP ' + status + (detail ? (': ' + detail) : '');
    if (/ECONNREFUSED|ENOTFOUND|fetch failed/i.test(msg)) {
        return 'Could not reach Replicate. Try again shortly.';
    }
    return msg.length > 160 ? msg.slice(0, 160) + '…' : msg;
}

/**
 * Run text removal on a local MP4 and replace the file in place.
 * Video is passed as a public HTTPS URL (preferred) or a data URI for small files.
 * @returns {{ ok: boolean, skipped?: boolean, error?: string }}
 */
async function cleanBurnedInText(filePath, options) {
    options = options || {};
    var token = process.env.REPLICATE_API_KEY || process.env.REPLICATE_API_TOKEN;
    if (!token) {
        return { ok: false, skipped: true, error: 'REPLICATE_API_KEY not configured' };
    }
    if (!filePath || !fs.existsSync(filePath)) {
        return { ok: false, error: 'Clip file not found' };
    }

    var replicate = new Replicate({ auth: token });
    var tmpOut = filePath + '.clean-' + Date.now() + '.mp4';
    var size = fs.statSync(filePath).size;

    var videoInput = options.publicUrl || publicClipUrl(filePath);
    if (!videoInput) {
        if (size <= MAX_DATA_URI_BYTES) {
            videoInput = toDataUri(filePath);
        } else {
            return {
                ok: false,
                error: 'APP_URL not set — needed so Replicate can download the clip (or keep clips under 8MB).'
            };
        }
    }

    try {
        console.log('Text-clean via Replicate:', path.basename(filePath),
            videoInput.indexOf('data:') === 0 ? '(data-uri)' : videoInput);

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
        return { ok: true };
    } catch (err) {
        try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch (e) {}
        var friendly = friendlyReplicateError(err);
        console.warn('Text-clean failed:', err.message);
        return { ok: false, error: friendly };
    }
}

module.exports = { cleanBurnedInText, MODEL_VERSION };
