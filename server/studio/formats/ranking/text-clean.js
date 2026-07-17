/**
 * Burned-in caption / text overlay removal via Replicate API.
 * Model: hjunior29/video-text-remover (not a custom ML stack).
 *
 * Env: REPLICATE_API_KEY (same as rest of Studio)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const Replicate = require('replicate');

const MODEL = 'hjunior29/video-text-remover';

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
        if (typeof output.url === 'function') return output.url();
        if (typeof output.href === 'string') return output.href;
        if (typeof output.url === 'string') return output.url;
    }
    return null;
}

/**
 * Run text removal on a local MP4 and replace the file in place.
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

    try {
        console.log('Text-clean via Replicate:', path.basename(filePath));
        var output = await replicate.run(MODEL, {
            input: {
                video: fs.createReadStream(filePath),
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
        console.warn('Text-clean failed:', err.message);
        return { ok: false, error: err.message || 'Text clean failed' };
    }
}

module.exports = { cleanBurnedInText, MODEL };
