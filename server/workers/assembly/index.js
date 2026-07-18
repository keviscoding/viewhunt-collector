/**
 * Fly Machine entry — full ranking pipeline:
 * download clips → FFmpeg trim → Gemini commentary + TTS (OpenAI fallback) →
 * Whisper word timestamps → FFmpeg assemble → upload
 *
 * Env: JOB_ID, APP_URL, MONGODB_URI, WORKER_SECRET, GEMINI_API_KEY, OPENAI_API_KEY, SPACES_/AWS_
 * Optional: APP_INTERNAL_URL (ondigitalocean.app) — preferred for callbacks/downloads from Fly
 */
const path = require('path');
const fs = require('fs');
const { MongoClient, ObjectId } = require('mongodb');
const https = require('https');
const http = require('http');

const RankingAssembler = require('./lib/ranking/assembler');
const RankingCommentary = require('./lib/ranking/commentary');
const storage = require('./lib/storage');
const trialHelper = require('./lib/trial');

const JOB_ID = process.env.JOB_ID;
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const APP_INTERNAL_URL = (process.env.APP_INTERNAL_URL || '').replace(/\/$/, '');
const MONGODB_URI = process.env.MONGODB_URI || process.env.V2_MONGO_URI || process.env.MONGO_URI;

/** Prefer DO ingress for Fly→app calls (avoids Cloudflare hanging custom-domain POSTs). */
function appBases() {
    const bases = [];
    if (APP_INTERNAL_URL) bases.push(APP_INTERNAL_URL);
    if (APP_URL && APP_URL !== APP_INTERNAL_URL) bases.push(APP_URL);
    return bases;
}

function clipBaseUrl() {
    const bases = appBases();
    return bases[0] || APP_URL;
}

async function fetchWithTimeout(url, opts, ms) {
    const controller = new AbortController();
    const timer = setTimeout(function() { controller.abort(); }, ms || 8000);
    try {
        return await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
    } finally {
        clearTimeout(timer);
    }
}

async function downloadFile(url, destPath) {
    return new Promise(function(resolve, reject) {
        const mod = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(destPath);
        const req = mod.get(url, function(res) {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close();
                try { fs.unlinkSync(destPath); } catch (e) {}
                return downloadFile(res.headers.location, destPath).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                file.close();
                return reject(new Error('Download failed ' + res.statusCode + ' for ' + url));
            }
            res.pipe(file);
            file.on('finish', function() { file.close(resolve); });
        });
        req.setTimeout(60000, function() {
            req.destroy(new Error('Download timeout for ' + url));
        });
        req.on('error', function(err) {
            try { fs.unlinkSync(destPath); } catch (e) {}
            reject(err);
        });
    });
}

/** Report progress to DO even when Fly cannot reach Mongo (Atlas IP allowlist, etc.). */
async function reportViaHttp(update) {
    if (!JOB_ID) return false;
    const bases = appBases();
    if (!bases.length) return false;
    const secret = process.env.WORKER_SECRET || '';
    for (var i = 0; i < bases.length; i++) {
        const base = bases[i];
        try {
            const res = await fetchWithTimeout(base + '/api/studio/internal/ranking-job-update', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Worker-Secret': secret
                },
                body: JSON.stringify({ jobId: JOB_ID, update: update })
            }, 8000);
            if (!res.ok) {
                console.warn('HTTP job update failed via', base, res.status, await res.text().catch(function() { return ''; }));
                continue;
            }
            console.log('HTTP job update ok via', base);
            return true;
        } catch (err) {
            console.warn('HTTP job update error via', base + ':', err.name, err.message);
        }
    }
    return false;
}

async function updateJob(db, jobId, update) {
    const patch = Object.assign({}, update, { updatedAt: new Date() });
    let mongoOk = false;
    if (db) {
        try {
            await db.collection('ranking_jobs').updateOne(
                { _id: new ObjectId(jobId) },
                { $set: patch }
            );
            mongoOk = true;
        } catch (err) {
            console.warn('Mongo job update failed:', err.message);
        }
    }
    const httpOk = await reportViaHttp(patch);
    if (!mongoOk && !httpOk) {
        throw new Error('Could not update job via Mongo or APP_URL callback');
    }
}

async function main() {
    // Always-on / accidental fly deploy machines have no JOB_ID — exit cleanly (no crash loop)
    if (!JOB_ID) {
        console.log('No JOB_ID set — idle image machine, exiting 0');
        process.exit(0);
    }
    if (!MONGODB_URI) throw new Error('MONGODB_URI required');
    if (!APP_URL && !APP_INTERNAL_URL) throw new Error('APP_URL or APP_INTERNAL_URL required');

    console.log('Fly assembly worker starting for job', JOB_ID, {
        hasGemini: !!process.env.GEMINI_API_KEY,
        hasOpenAI: !!process.env.OPENAI_API_KEY,
        appUrl: APP_URL,
        appInternal: APP_INTERNAL_URL || '(none)',
        hasWorkerSecret: !!(process.env.WORKER_SECRET || '').trim()
    });

    const heartbeatMsg =
        'Fly: worker online' +
        (process.env.GEMINI_API_KEY ? ' (Gemini ok)' : ' (no GEMINI_API_KEY)') +
        (process.env.OPENAI_API_KEY ? ' (OpenAI ok)' : ' (no OPENAI_API_KEY)') +
        ' — downloading clips…';

    // Mongo first (short timeout) — do NOT hang forever on Cloudflare→custom domain
    const client = new MongoClient(MONGODB_URI, {
        serverSelectionTimeoutMS: 12000,
        connectTimeoutMS: 12000
    });
    let db = null;
    let mongoConnected = false;
    try {
        await client.connect();
        db = client.db();
        mongoConnected = true;
        console.log('Mongo connected from Fly');
    } catch (mongoErr) {
        console.warn('Mongo connect from Fly failed:', mongoErr.message);
    }

    // Fire HTTP heartbeat with timeout (secondary). Never block startup forever.
    const httpPromise = reportViaHttp({
        status: 'processing',
        message: heartbeatMsg,
        worker: 'fly',
        flyHeartbeatAt: new Date().toISOString()
    });

    if (mongoConnected) {
        await db.collection('ranking_jobs').updateOne(
            { _id: new ObjectId(JOB_ID) },
            {
                $set: {
                    status: 'processing',
                    message: heartbeatMsg,
                    worker: 'fly',
                    flyHeartbeatAt: new Date(),
                    updatedAt: new Date()
                }
            }
        );
        console.log('Mongo heartbeat written');
    }

    const httpOk = await httpPromise;
    if (!mongoConnected && !httpOk) {
        throw new Error(
            'Fly worker cannot reach Mongo or APP_URL. ' +
            'Set Atlas Network Access to allow 0.0.0.0/0 (or Fly IPs), and set APP_INTERNAL_URL to your ' +
            '*.ondigitalocean.app URL so callbacks bypass Cloudflare.'
        );
    }
    if (!mongoConnected) {
        // Need Mongo for job payload — fail clearly
        throw new Error(
            'Fly cannot connect to MongoDB (Atlas IP allowlist?). ' +
            'In Atlas → Network Access, allow 0.0.0.0/0 temporarily, or whitelist Fly egress.'
        );
    }

    const job = await db.collection('ranking_jobs').findOne({ _id: new ObjectId(JOB_ID) });
    if (!job) throw new Error('Job not found: ' + JOB_ID);
    if (job.status === 'complete') {
        console.log('Job already complete, exiting');
        await client.close();
        return;
    }

    await updateJob(db, JOB_ID, {
        status: 'processing',
        message: heartbeatMsg,
        worker: 'fly',
        flyHeartbeatAt: new Date()
    });

    const payload = job.payload || {};
    const clipsMeta = payload.clips || [];
    if (!clipsMeta.length) throw new Error('Job has no clips payload');

    const enableCommentary = !!payload.enableCommentary;
    const titleText = (payload.title && payload.title.text) || '';

    const workDir = path.join('/tmp', 'ranking-' + JOB_ID);
    fs.mkdirSync(workDir, { recursive: true });
    const audioDir = path.join(workDir, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });

    const clipList = [];
    const assemblerEarly = new RankingAssembler();
    assemblerEarly.tempDir = path.join(workDir, 'temp');
    assemblerEarly.outputDir = path.join(workDir, 'final');
    assemblerEarly.uploadDir = workDir;
    fs.mkdirSync(assemblerEarly.tempDir, { recursive: true });

    const base = clipBaseUrl();
    for (var i = 0; i < clipsMeta.length; i++) {
        const c = clipsMeta[i];
        const dest = path.join(workDir, c.filename || ('clip-' + i + '.mp4'));
        const url = base + '/studio/ranking-uploads/' + encodeURIComponent(c.filename);
        console.log('Downloading', url);
        await downloadFile(url, dest);

        await updateJob(db, JOB_ID, {
            message: 'Fly: trimming clip ' + (i + 1) + ' of ' + clipsMeta.length + '...'
        });

        var finalPath = dest;
        var startTime = typeof c.startTime === 'number' ? c.startTime : parseFloat(c.startTime) || 0;
        var endTime = typeof c.endTime === 'number' ? c.endTime : (c.endTime != null ? parseFloat(c.endTime) : null);
        var origDur = await assemblerEarly.getDuration(dest);
        var endT = (endTime != null && !isNaN(endTime) && endTime > 0) ? endTime : origDur;
        var needsTrim = startTime > 0.1 || Math.abs(endT - origDur) > 0.1;
        if (needsTrim && endT > startTime + 0.05) {
            var trimmedPath = path.join(workDir, 'trimmed-' + i + '.mp4');
            await assemblerEarly.trimClip(dest, startTime, endT, trimmedPath);
            finalPath = trimmedPath;
        }
        clipList.push({ path: finalPath, number: c.number || (i + 1), label: c.label || '' });
    }

    var commentaryData = [];
    var commentaryResults = [];
    var ttsProvider = null;
    var ttsError = null;

    if (enableCommentary && titleText) {
        if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) {
            console.warn('No GEMINI_API_KEY or OPENAI_API_KEY on Fly — skipping commentary');
        } else {
            await updateJob(db, JOB_ID, { message: 'Fly: generating commentary + TTS...' });
            console.log('🎙️ Running RankingCommentary on Fly');
            const commentaryGen = new RankingCommentary();
            commentaryGen.audioDir = audioDir;
            commentaryGen.onProgress = async function(msg) {
                await updateJob(db, JOB_ID, { message: 'Fly: ' + msg });
            };
            commentaryResults = await commentaryGen.generateCommentary(
                clipList,
                titleText,
                payload.voiceName || 'Kore'
            );
            ttsProvider = commentaryResults.ttsProvider || commentaryGen.lastTtsProvider || null;
            ttsError = commentaryResults.ttsError || commentaryGen.lastTtsError || null;
            commentaryData = commentaryResults.filter(function(c) { return c.audioPath; });
            console.log('🎙️ Commentary ready:', commentaryData.length, 'audio lines', ttsProvider || '');
        }
    }

    await updateJob(db, JOB_ID, {
        message: 'Fly: FFmpeg assembling (' + clipList.length + ' clips)...'
    });

    const assembler = assemblerEarly;
    fs.mkdirSync(assembler.outputDir, { recursive: true });

    const result = await assembler.assemble(clipList, payload.title || {}, {
        layout: payload.layout || {},
        commentary: commentaryData,
        commentaryLines: enableCommentary ? commentaryResults : [],
        colorPalette: payload.colorPalette || 'yellow',
        checkeredMode: !!payload.checkeredMode,
        subtitleFont: payload.subtitleFont || 'Arial',
        subtitleY: payload.subtitleY != null ? payload.subtitleY : 55,
        subtitleColor: payload.subtitleColor || 'yellow',
        hookEnabled: enableCommentary && commentaryData.length > 0
    });

    const localName = path.basename(result.videoUrl);
    const localPath = path.join(assembler.outputDir, localName);
    let videoUrl = result.videoUrl;

    if (fs.existsSync(localPath) && storage.isConfigured()) {
        const uploaded = await storage.uploadFile(localPath, 'studio/ranking-final');
        if (uploaded) {
            videoUrl = uploaded;
            console.log('Uploaded final to object storage:', videoUrl);
        }
    } else if (fs.existsSync(localPath) && (APP_INTERNAL_URL || APP_URL)) {
        try {
            const buf = fs.readFileSync(localPath);
            const uploadBase = APP_INTERNAL_URL || APP_URL;
            const uploadRes = await fetchWithTimeout(uploadBase + '/api/studio/internal/ranking-result', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Worker-Secret': process.env.WORKER_SECRET || ''
                },
                body: JSON.stringify({
                    jobId: JOB_ID,
                    filename: localName,
                    base64: buf.toString('base64')
                })
            }, 120000);
            if (uploadRes.ok) {
                const data = await uploadRes.json();
                if (data.videoUrl) videoUrl = data.videoUrl;
            } else {
                console.warn('Internal result upload failed:', uploadRes.status);
            }
        } catch (uploadErr) {
            console.warn('Could not upload result to app:', uploadErr.message);
        }
    }

    const hasCommentary = commentaryData.length > 0;
    const finalResult = {
        ...result,
        videoUrl: videoUrl,
        hasCommentary: hasCommentary,
        ttsProvider: ttsProvider,
        ttsError: hasCommentary ? null : ttsError,
        worker: 'fly'
    };

    await updateJob(db, JOB_ID, {
        status: 'complete',
        result: finalResult,
        message: hasCommentary
            ? ('Complete' + (ttsProvider ? ' (voice: ' + ttsProvider + ')' : ''))
            : (enableCommentary ? ('Complete — voiceover missing' + (ttsError ? ': ' + ttsError : '')) : 'Complete')
    });

    if (job.commentaryCreditsReserved && !hasCommentary) {
        await updateJob(db, JOB_ID, { commentaryRefundNeeded: true });
    }

    if (job.usingTrial && job.userId) {
        await trialHelper.recordRankingVideoComplete(db, job.userId);
    }

    console.log('Job complete:', videoUrl, hasCommentary ? '(with commentary)' : '');
    await client.close();
}

main().catch(async function(err) {
    console.error('Assembly worker failed:', err);
    const failUpdate = {
        status: 'failed',
        error: err.message,
        commentaryRefundNeeded: true,
        updatedAt: new Date()
    };
    try {
        await reportViaHttp(failUpdate);
    } catch (e) {
        console.error('HTTP fail report error:', e.message);
    }
    try {
        if (MONGODB_URI && JOB_ID) {
            const client = new MongoClient(MONGODB_URI, {
                serverSelectionTimeoutMS: 10000,
                connectTimeoutMS: 10000
            });
            await client.connect();
            const db = client.db();
            await db.collection('ranking_jobs').updateOne(
                { _id: new ObjectId(JOB_ID) },
                { $set: failUpdate }
            );
            await client.close();
        }
    } catch (e) {
        console.error('Failed to mark job failed:', e.message);
    }
    process.exit(1);
});
