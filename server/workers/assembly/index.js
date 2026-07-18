/**
 * Fly Machine entry — full ranking pipeline.
 * Boots with zero heavy requires so a crash in ffmpeg/genai never blocks the heartbeat.
 *
 * Env: JOB_ID, APP_URL, APP_INTERNAL_URL, MONGODB_URI, WORKER_SECRET,
 *      JOB_PAYLOAD_JSON (optional — preferred), GEMINI/OPENAI/SPACES
 */

// Fly is IPv6-first; DO App Platform / many HTTPS hosts are IPv4-only → fetch hangs without this
try {
    require('dns').setDefaultResultOrder('ipv4first');
} catch (e) {}

const JOB_ID = process.env.JOB_ID;
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');
const APP_INTERNAL_URL = (process.env.APP_INTERNAL_URL || '').replace(/\/$/, '');
const MONGODB_URI = process.env.MONGODB_URI || process.env.V2_MONGO_URI || process.env.MONGO_URI;

// Prefer system ffmpeg from the image (more reliable than npm static binaries on Fly)
if (!process.env.FFMPEG_PATH && require('fs').existsSync('/usr/bin/ffmpeg')) {
    process.env.FFMPEG_PATH = '/usr/bin/ffmpeg';
}
if (!process.env.FFPROBE_PATH && require('fs').existsSync('/usr/bin/ffprobe')) {
    process.env.FFPROBE_PATH = '/usr/bin/ffprobe';
}

function appBases() {
    const bases = [];
    if (APP_INTERNAL_URL) bases.push(APP_INTERNAL_URL);
    if (APP_URL && APP_URL !== APP_INTERNAL_URL) bases.push(APP_URL);
    return bases;
}

function clipBaseUrl() {
    return appBases()[0] || APP_URL;
}

async function fetchWithTimeout(url, opts, ms) {
    const controller = new AbortController();
    const timer = setTimeout(function() { controller.abort(); }, ms || 5000);
    try {
        return await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
    } finally {
        clearTimeout(timer);
    }
}

async function reportViaHttp(update) {
    if (!JOB_ID) return false;
    const bases = appBases();
    if (!bases.length) return false;
    const secret = (process.env.WORKER_SECRET || '').trim();
    for (var i = 0; i < bases.length; i++) {
        const base = bases[i];
        try {
            console.log('HTTP heartbeat →', base);
            const res = await fetchWithTimeout(base + '/api/studio/internal/ranking-job-update', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Worker-Secret': secret
                },
                body: JSON.stringify({ jobId: JOB_ID, update: update })
            }, 5000);
            const text = await res.text().catch(function() { return ''; });
            if (!res.ok) {
                console.warn('HTTP job update failed via', base, res.status, text.slice(0, 200));
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

async function bootHeartbeat(msg) {
    console.log('bootHeartbeat:', msg);
    return reportViaHttp({
        status: 'processing',
        message: msg,
        worker: 'fly',
        flyHeartbeatAt: new Date().toISOString()
    });
}

async function main() {
    console.log('Fly assembly boot', {
        node: process.version,
        jobId: JOB_ID || '(none)',
        appUrl: APP_URL || '(none)',
        appInternal: APP_INTERNAL_URL || '(none)',
        hasMongo: !!MONGODB_URI,
        hasWorkerSecret: !!(process.env.WORKER_SECRET || '').trim(),
        hasPayload: !!process.env.JOB_PAYLOAD_JSON,
        ffmpeg: process.env.FFMPEG_PATH || 'npm-static'
    });

    if (!JOB_ID) {
        console.log('No JOB_ID — idle image machine, exiting 0');
        process.exit(0);
    }
    if (!APP_URL && !APP_INTERNAL_URL) {
        throw new Error('APP_URL or APP_INTERNAL_URL required');
    }

    const heartbeatMsg =
        'Fly: worker online' +
        (process.env.GEMINI_API_KEY ? ' (Gemini ok)' : ' (no GEMINI_API_KEY)') +
        (process.env.OPENAI_API_KEY ? ' (OpenAI ok)' : ' (no OPENAI_API_KEY)') +
        ' — starting…';

    // CRITICAL: heartbeat BEFORE heavy requires
    const hbOk = await bootHeartbeat(heartbeatMsg);
    console.log('Initial heartbeat result:', hbOk);
    if (!hbOk) {
        console.warn('Initial HTTP heartbeat failed — will retry after loading modules / Mongo');
    }

    const path = require('path');
    const fs = require('fs');
    const https = require('https');
    const http = require('http');
    const { MongoClient, ObjectId } = require('mongodb');

    let RankingAssembler;
    let RankingCommentary;
    let storage;
    let trialHelper;
    try {
        RankingAssembler = require('./lib/ranking/assembler');
        RankingCommentary = require('./lib/ranking/commentary');
        storage = require('./lib/storage');
        trialHelper = require('./lib/trial');
        console.log('Heavy modules loaded');
    } catch (loadErr) {
        console.error('Module load failed:', loadErr);
        await reportViaHttp({
            status: 'failed',
            error: 'Fly worker failed to load modules: ' + loadErr.message,
            commentaryRefundNeeded: true
        });
        throw loadErr;
    }

    await bootHeartbeat(
        'Fly: worker online' +
        (process.env.GEMINI_API_KEY ? ' (Gemini ok)' : '') +
        (process.env.OPENAI_API_KEY ? ' (OpenAI ok)' : '') +
        ' — downloading clips…'
    );

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

    async function updateJob(db, update) {
        const patch = Object.assign({}, update, { updatedAt: new Date() });
        let mongoOk = false;
        if (db) {
            try {
                await db.collection('ranking_jobs').updateOne(
                    { _id: new ObjectId(JOB_ID) },
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

    let payload = null;
    if (process.env.JOB_PAYLOAD_JSON) {
        try {
            payload = JSON.parse(process.env.JOB_PAYLOAD_JSON);
            console.log('Loaded JOB_PAYLOAD_JSON clips:', (payload.clips || []).length);
        } catch (e) {
            console.warn('JOB_PAYLOAD_JSON parse failed:', e.message);
        }
    }

    let client = null;
    let db = null;
    let job = null;

    if (MONGODB_URI) {
        try {
            client = new MongoClient(MONGODB_URI, {
                serverSelectionTimeoutMS: 12000,
                connectTimeoutMS: 12000,
                family: 4
            });
            await client.connect();
            db = client.db();
            console.log('Mongo connected from Fly');
            job = await db.collection('ranking_jobs').findOne({ _id: new ObjectId(JOB_ID) });
            if (job && job.payload && !payload) payload = job.payload;
            if (job && job.status === 'complete') {
                console.log('Job already complete, exiting');
                await client.close();
                return;
            }
            await updateJob(db, {
                status: 'processing',
                message: 'Fly: worker online — downloading clips…',
                worker: 'fly',
                flyHeartbeatAt: new Date()
            });
        } catch (mongoErr) {
            console.warn('Mongo from Fly failed:', mongoErr.message);
        }
    }

    if (!payload || !payload.clips || !payload.clips.length) {
        throw new Error(
            'No job payload available (Mongo unreachable and JOB_PAYLOAD_JSON missing).'
        );
    }

    const usingTrial = !!(job && job.usingTrial);
    const userId = job && job.userId;
    const commentaryCreditsReserved = !!(job && job.commentaryCreditsReserved);

    const clipsMeta = payload.clips;
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
    fs.mkdirSync(assemblerEarly.outputDir, { recursive: true });

    const base = clipBaseUrl();
    for (var i = 0; i < clipsMeta.length; i++) {
        const c = clipsMeta[i];
        const dest = path.join(workDir, c.filename || ('clip-' + i + '.mp4'));
        const url = base + '/studio/ranking-uploads/' + encodeURIComponent(c.filename);
        console.log('Downloading', url);
        await downloadFile(url, dest);

        await updateJob(db, {
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
            await updateJob(db, { message: 'Fly: generating commentary + TTS...' });
            const commentaryGen = new RankingCommentary();
            commentaryGen.audioDir = audioDir;
            commentaryGen.onProgress = async function(msg) {
                await updateJob(db, { message: 'Fly: ' + msg });
            };
            commentaryResults = await commentaryGen.generateCommentary(
                clipList,
                titleText,
                payload.voiceName || 'Kore'
            );
            ttsProvider = commentaryResults.ttsProvider || commentaryGen.lastTtsProvider || null;
            ttsError = commentaryResults.ttsError || commentaryGen.lastTtsError || null;
            commentaryData = commentaryResults.filter(function(c) { return c.audioPath; });
        }
    }

    await updateJob(db, {
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
        if (uploaded) videoUrl = uploaded;
    } else if (fs.existsSync(localPath) && (APP_INTERNAL_URL || APP_URL)) {
        try {
            const buf = fs.readFileSync(localPath);
            const uploadBase = APP_INTERNAL_URL || APP_URL;
            const uploadRes = await fetchWithTimeout(uploadBase + '/api/studio/internal/ranking-result', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Worker-Secret': (process.env.WORKER_SECRET || '').trim()
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

    await updateJob(db, {
        status: 'complete',
        result: finalResult,
        message: hasCommentary
            ? ('Complete' + (ttsProvider ? ' (voice: ' + ttsProvider + ')' : ''))
            : (enableCommentary ? ('Complete — voiceover missing' + (ttsError ? ': ' + ttsError : '')) : 'Complete')
    });

    if (commentaryCreditsReserved && !hasCommentary) {
        await updateJob(db, { commentaryRefundNeeded: true });
    }

    if (usingTrial && userId && db) {
        await trialHelper.recordRankingVideoComplete(db, userId);
    }

    console.log('Job complete:', videoUrl);
    if (client) await client.close();
}

main().catch(async function(err) {
    console.error('Assembly worker failed:', err && err.stack ? err.stack : err);
    const failUpdate = {
        status: 'failed',
        error: (err && err.message) || String(err),
        commentaryRefundNeeded: true,
        updatedAt: new Date()
    };
    try { await reportViaHttp(failUpdate); } catch (e) {}
    try {
        if (MONGODB_URI && JOB_ID) {
            const { MongoClient, ObjectId } = require('mongodb');
            const client = new MongoClient(MONGODB_URI, {
                serverSelectionTimeoutMS: 10000,
                connectTimeoutMS: 10000,
                family: 4
            });
            await client.connect();
            await client.db().collection('ranking_jobs').updateOne(
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
