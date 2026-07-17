/**
 * Fly Machine entry - ranking FFmpeg assembly worker.
 *
 * Env: JOB_ID, APP_URL, MONGODB_URI, WORKER_SECRET, AWS_/SPACES_ vars
 */
const path = require('path');
const fs = require('fs');
const { MongoClient, ObjectId } = require('mongodb');
const https = require('https');
const http = require('http');

// Paths resolve relative to this worker when server code is copied beside it
const RankingAssembler = require('./lib/ranking/assembler');
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
                fs.unlinkSync(destPath);
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

    console.log('Assembly worker starting for job', JOB_ID);

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

    await db.collection('ranking_jobs').updateOne(
        { _id: job._id },
        { $set: { status: 'processing', message: 'Downloading clips on Fly...', worker: 'fly', updatedAt: new Date() } }
    );

    const workDir = path.join('/tmp', 'ranking-' + JOB_ID);
    fs.mkdirSync(workDir, { recursive: true });

    const clipList = [];
    for (var i = 0; i < clipsMeta.length; i++) {
        const c = clipsMeta[i];
        const dest = path.join(workDir, c.filename || ('clip-' + i + '.mp4'));
        const url = APP_URL + '/studio/ranking-uploads/' + encodeURIComponent(c.filename);
        console.log('Downloading', url);
        await downloadFile(url, dest);
        clipList.push({ path: dest, number: c.number || (i + 1), label: c.label || '' });
    }

    await db.collection('ranking_jobs').updateOne(
        { _id: job._id },
        { $set: { message: 'Assembling video (' + clipList.length + ' clips)...', updatedAt: new Date() } }
    );

    // Point assembler dirs at /tmp
    const assembler = new RankingAssembler();
    assembler.tempDir = path.join(workDir, 'temp');
    assembler.outputDir = path.join(workDir, 'final');
    assembler.uploadDir = workDir;
    fs.mkdirSync(assembler.tempDir, { recursive: true });
    fs.mkdirSync(assembler.outputDir, { recursive: true });

    const result = await assembler.assemble(clipList, payload.title || {}, {
        layout: payload.layout || {},
        commentary: [],
        commentaryLines: [],
        colorPalette: payload.colorPalette || 'yellow',
        checkeredMode: !!payload.checkeredMode,
        subtitleFont: payload.subtitleFont || 'Arial',
        subtitleY: payload.subtitleY != null ? payload.subtitleY : 55,
        subtitleColor: payload.subtitleColor || 'yellow',
        hookEnabled: false
    });

    // Local path from assembler
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
        // Upload back to DO via internal API
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

    const finalResult = {
        ...result,
        videoUrl: videoUrl,
        hasCommentary: false,
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

    if (job.usingTrial && job.userId) {
        await trialHelper.recordRankingVideoComplete(db, job.userId);
    }

    console.log('Job complete:', videoUrl);
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
                { $set: { status: 'failed', error: err.message, updatedAt: new Date() } }
            );
            await client.close();
        }
    } catch (e) {
        console.error('Failed to mark job failed:', e.message);
    }
    process.exit(1);
});
