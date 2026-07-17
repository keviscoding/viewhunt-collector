/**
 * Fly Machine entry — full ranking pipeline:
 * download clips → Gemini commentary + TTS → Whisper word timestamps → FFmpeg assemble → upload
 *
 * Env: JOB_ID, APP_URL, MONGODB_URI, WORKER_SECRET, GEMINI_API_KEY, OPENAI_API_KEY, SPACES_/AWS_
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
const MONGODB_URI = process.env.MONGODB_URI || process.env.V2_MONGO_URI || process.env.MONGO_URI;

async function downloadFile(url, destPath) {
    return new Promise(function(resolve, reject) {
        const mod = url.startsWith('https') ? https : http;
        const file = fs.createWriteStream(destPath);
        mod.get(url, function(res) {
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
        }).on('error', function(err) {
            try { fs.unlinkSync(destPath); } catch (e) {}
            reject(err);
        });
    });
}

async function main() {
    if (!JOB_ID) throw new Error('JOB_ID required');
    if (!MONGODB_URI) throw new Error('MONGODB_URI required');
    if (!APP_URL) throw new Error('APP_URL required');

    console.log('Fly assembly worker starting for job', JOB_ID);

    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db();

    const job = await db.collection('ranking_jobs').findOne({ _id: new ObjectId(JOB_ID) });
    if (!job) throw new Error('Job not found: ' + JOB_ID);
    if (job.status === 'complete') {
        console.log('Job already complete, exiting');
        await client.close();
        return;
    }

    const payload = job.payload || {};
    const clipsMeta = payload.clips || [];
    if (!clipsMeta.length) throw new Error('Job has no clips payload');

    const enableCommentary = !!payload.enableCommentary;
    const titleText = (payload.title && payload.title.text) || '';

    await db.collection('ranking_jobs').updateOne(
        { _id: job._id },
        { $set: { status: 'processing', message: 'Downloading clips on Fly...', worker: 'fly', updatedAt: new Date() } }
    );

    const workDir = path.join('/tmp', 'ranking-' + JOB_ID);
    fs.mkdirSync(workDir, { recursive: true });
    const audioDir = path.join(workDir, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });

    const clipList = [];
    for (var i = 0; i < clipsMeta.length; i++) {
        const c = clipsMeta[i];
        const dest = path.join(workDir, c.filename || ('clip-' + i + '.mp4'));
        const url = APP_URL + '/studio/ranking-uploads/' + encodeURIComponent(c.filename);
        console.log('Downloading', url);
        await downloadFile(url, dest);
        clipList.push({ path: dest, number: c.number || (i + 1), label: c.label || '' });
    }

    var commentaryData = [];
    var commentaryResults = [];

    if (enableCommentary && titleText) {
        if (!process.env.GEMINI_API_KEY) {
            console.warn('GEMINI_API_KEY missing on Fly — skipping commentary');
        } else {
            await db.collection('ranking_jobs').updateOne(
                { _id: job._id },
                { $set: { message: 'Fly: Gemini commentary + TTS + word timings...', updatedAt: new Date() } }
            );
            console.log('🎙️ Running RankingCommentary on Fly (Gemini + Whisper if OPENAI_API_KEY set)');
            const commentaryGen = new RankingCommentary();
            commentaryGen.audioDir = audioDir;
            commentaryResults = await commentaryGen.generateCommentary(
                clipList,
                titleText,
                payload.voiceName || 'Kore'
            );
            commentaryData = commentaryResults.filter(function(c) { return c.audioPath; });
            console.log('🎙️ Commentary ready:', commentaryData.length, 'audio lines');
        }
    }

    await db.collection('ranking_jobs').updateOne(
        { _id: job._id },
        { $set: { message: 'Fly: FFmpeg assembling (' + clipList.length + ' clips)...', updatedAt: new Date() } }
    );

    const assembler = new RankingAssembler();
    assembler.tempDir = path.join(workDir, 'temp');
    assembler.outputDir = path.join(workDir, 'final');
    assembler.uploadDir = workDir;
    fs.mkdirSync(assembler.tempDir, { recursive: true });
    fs.mkdirSync(assembler.outputDir, { recursive: true });

    const result = await assembler.assemble(clipList, payload.title || {}, {
        layout: payload.layout || {},
        commentary: commentaryData,
        commentaryLines: commentaryResults,
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
    } else if (fs.existsSync(localPath) && APP_URL) {
        try {
            const buf = fs.readFileSync(localPath);
            const uploadRes = await fetch(APP_URL + '/api/studio/internal/ranking-result', {
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
            });
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
        worker: 'fly'
    };

    await db.collection('ranking_jobs').updateOne(
        { _id: job._id },
        {
            $set: {
                status: 'complete',
                result: finalResult,
                message: 'Complete',
                updatedAt: new Date()
            }
        }
    );

    // If commentary was reserved but failed to produce audio, refund via flag for DO recovery
    if (job.commentaryCreditsReserved && !hasCommentary) {
        await db.collection('ranking_jobs').updateOne(
            { _id: job._id },
            { $set: { commentaryRefundNeeded: true } }
        );
    }

    if (job.usingTrial && job.userId) {
        await trialHelper.recordRankingVideoComplete(db, job.userId);
    }

    console.log('Job complete:', videoUrl, hasCommentary ? '(with commentary)' : '');
    await client.close();
}

main().catch(async function(err) {
    console.error('Assembly worker failed:', err);
    try {
        if (MONGODB_URI && JOB_ID) {
            const client = new MongoClient(MONGODB_URI);
            await client.connect();
            const db = client.db();
            await db.collection('ranking_jobs').updateOne(
                { _id: new ObjectId(JOB_ID) },
                {
                    $set: {
                        status: 'failed',
                        error: err.message,
                        commentaryRefundNeeded: true,
                        updatedAt: new Date()
                    }
                }
            );
            await client.close();
        }
    } catch (e) {
        console.error('Failed to mark job failed:', e.message);
    }
    process.exit(1);
});
