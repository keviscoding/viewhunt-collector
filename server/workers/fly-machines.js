/**
 * Fly Machines API helpers — spawn ephemeral workers for assembly / scraping.
 *
 * Env:
 *   FLY_API_TOKEN
 *   FLY_ASSEMBLY_APP
 *   FLY_SCRAPER_APP
 *   FLY_ASSEMBLY_IMAGE / FLY_SCRAPER_IMAGE
 *   WORKER_SECRET
 *   APP_URL
 *   Mongo: V2_MONGO_URI | MONGODB_URI | MONGO_URI | DATABASE_URL
 */
const FLY_API = 'https://api.machines.dev/v1';

function flyConfigured(appEnv) {
    return !!(process.env.FLY_API_TOKEN && process.env[appEnv]);
}

function resolveMongoUri() {
    return (
        process.env.V2_MONGO_URI ||
        process.env.MONGODB_URI ||
        process.env.MONGO_URI ||
        process.env.DATABASE_URL ||
        process.env.DB_URI ||
        ''
    ).trim();
}

async function flyRequest(method, path, body) {
    const token = process.env.FLY_API_TOKEN;
    if (!token) throw new Error('FLY_API_TOKEN not set');

    const res = await fetch(FLY_API + path, {
        method,
        headers: {
            Authorization: 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }

    if (!res.ok) {
        const msg = (data && (data.error || data.message || data.detail)) || text || res.statusText;
        throw new Error('Fly API ' + res.status + ': ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)));
    }
    return data;
}

/**
 * Start an assembly machine for a ranking job.
 * Returns { started: true, machineId } or { started: false, reason }.
 */
async function startAssemblyMachine(jobId, payload) {
    const app = process.env.FLY_ASSEMBLY_APP;
    if (!process.env.FLY_API_TOKEN || !app) {
        console.log('Fly assembly not configured — skipping machine start');
        return { started: false, reason: 'FLY_API_TOKEN or FLY_ASSEMBLY_APP missing' };
    }

    const image = process.env.FLY_ASSEMBLY_IMAGE;
    if (!image) {
        console.warn('FLY_ASSEMBLY_IMAGE not set — cannot create machine');
        return { started: false, reason: 'FLY_ASSEMBLY_IMAGE missing' };
    }

    const mongoUri = resolveMongoUri();
    // Mongo preferred but not required when JOB_PAYLOAD_JSON is provided
    const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
    if (!appUrl) {
        console.error('Fly assembly aborted: APP_URL missing');
        return { started: false, reason: 'APP_URL missing — Fly worker cannot download clips' };
    }

    // Prefer DO default ingress for Fly→app (Cloudflare on custom domains can hang POSTs from Fly)
    const appInternal = (process.env.APP_INTERNAL_URL || process.env.DIGITALOCEAN_APP_URL || '')
        .replace(/\/$/, '');

    let payloadJson = '';
    if (payload && typeof payload === 'object') {
        try {
            payloadJson = JSON.stringify(payload);
            // Fly env practical limit — keep under ~80KB
            if (payloadJson.length > 80000) {
                console.warn('JOB_PAYLOAD_JSON too large (' + payloadJson.length + ') — worker will rely on Mongo');
                payloadJson = '';
            }
        } catch (e) {
            payloadJson = '';
        }
    }

    if (!mongoUri && !payloadJson) {
        console.error('Fly assembly aborted: need Mongo URI or job payload');
        return { started: false, reason: 'Mongo URI missing and no job payload to embed' };
    }

    const env = {
        JOB_ID: String(jobId),
        JOB_TYPE: 'ranking_assemble',
        WORKER_SECRET: (process.env.WORKER_SECRET || '').trim(),
        APP_URL: appUrl,
        APP_INTERNAL_URL: appInternal,
        MONGODB_URI: mongoUri || '',
        V2_MONGO_URI: mongoUri || '',
        JOB_PAYLOAD_JSON: payloadJson,
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || process.env.SPACES_KEY || '',
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || process.env.SPACES_SECRET || '',
        AWS_S3_BUCKET_NAME: process.env.AWS_S3_BUCKET_NAME || process.env.SPACES_BUCKET || '',
        // Spaces SDK signing requires us-east-1; datacenter comes from SPACES_ENDPOINT
        AWS_REGION: 'us-east-1',
        SPACES_KEY: process.env.SPACES_KEY || process.env.AWS_ACCESS_KEY_ID || '',
        SPACES_SECRET: process.env.SPACES_SECRET || process.env.AWS_SECRET_ACCESS_KEY || '',
        SPACES_BUCKET: process.env.SPACES_BUCKET || process.env.AWS_S3_BUCKET_NAME || '',
        SPACES_REGION: (process.env.SPACES_REGION && /^[a-z]{3}\d$/i.test(process.env.SPACES_REGION))
            ? process.env.SPACES_REGION
            : '',
        SPACES_ENDPOINT: process.env.SPACES_ENDPOINT || (
            process.env.SPACES_REGION && /^[a-z]{3}\d$/i.test(process.env.SPACES_REGION)
                ? ('https://' + process.env.SPACES_REGION + '.digitaloceanspaces.com')
                : ''
        ),
        SPACES_CDN_URL: process.env.SPACES_CDN_URL || '',
        GEMINI_API_KEY: (process.env.GEMINI_API_KEY || '').trim(),
        OPENAI_API_KEY: (process.env.OPENAI_API_KEY || '').trim(),
        RANKING_TTS_PROVIDER: process.env.RANKING_TTS_PROVIDER || 'openai'
    };

    if (!env.WORKER_SECRET) {
        console.error('Fly assembly aborted: WORKER_SECRET missing on DigitalOcean');
        return { started: false, reason: 'WORKER_SECRET missing on DigitalOcean' };
    }

    console.log('Starting Fly assembly machine', {
        app,
        image: image.slice(0, 100),
        jobId: String(jobId),
        hasGemini: !!env.GEMINI_API_KEY,
        hasOpenAI: !!env.OPENAI_API_KEY,
        hasSpaces: !!(env.AWS_ACCESS_KEY_ID && env.AWS_S3_BUCKET_NAME),
        spacesEndpoint: env.SPACES_ENDPOINT || '(auto/none)',
        spacesRegion: env.AWS_REGION || '',
        hasWorkerSecret: true,
        hasPayload: !!payloadJson,
        appInternal: appInternal || '(none — set APP_INTERNAL_URL to *.ondigitalocean.app)',
        mongoHost: mongoUri ? ((mongoUri.match(/@([^/]+)/) || [])[1] || '(local)') : '(none)'
    });
    if (env.AWS_ACCESS_KEY_ID && env.AWS_S3_BUCKET_NAME && !env.SPACES_ENDPOINT) {
        console.warn('SPACES_ENDPOINT missing — Fly worker may fail Spaces upload (set https://REGION.digitaloceanspaces.com)');
    }

    const machine = await flyRequest('POST', '/apps/' + app + '/machines', {
        name: 'rank-' + String(jobId).slice(-12),
        region: process.env.FLY_ASSEMBLY_REGION || 'iad',
        config: {
            image,
            env,
            guest: {
                cpu_kind: 'shared',
                cpus: 4,
                memory_mb: 8192
            },
            auto_destroy: true,
            restart: { policy: 'no' }
        }
    });

    const machineId = machine && machine.id;
    if (!machineId) {
        return { started: false, reason: 'Fly created machine without id' };
    }

    // Wait until started. Do NOT call /start while state is 'created' (Fly returns 412 —
    // launch is already in progress). After started, watch ~15s for exit_code=1 crashes.
    var lastState = machine.state || 'created';
    var sawStarted = false;
    var startedAt = 0;
    for (var attempt = 0; attempt < 50; attempt++) {
        await new Promise(function(r) { setTimeout(r, 1500); });
        try {
            var live = await flyRequest('GET', '/apps/' + app + '/machines/' + machineId);
            lastState = (live && live.state) || lastState;

            if (lastState === 'started') {
                if (!sawStarted) {
                    sawStarted = true;
                    startedAt = Date.now();
                    console.log('Fly machine reached started:', machineId);
                }
                // Worker historically crashes ~12s after start with no heartbeat — wait it out
                if (Date.now() - startedAt >= 15000) {
                    break;
                }
                continue;
            }

            if (lastState === 'destroyed' || lastState === 'stopped') {
                console.error('Fly assembly machine died early:', machineId, lastState, 'sawStarted=', sawStarted);
                return {
                    started: false,
                    reason: 'Fly worker exited immediately (' + lastState +
                        '). Falling back to DigitalOcean assembly.'
                };
            }
        } catch (pollErr) {
            if (/404|not found/i.test(pollErr.message || '')) {
                return {
                    started: false,
                    reason: 'Fly machine vanished right after start (crash + auto_destroy). Falling back to DigitalOcean assembly.'
                };
            }
            console.warn('Fly machine poll error:', pollErr.message);
        }
    }

    if (lastState !== 'started') {
        return {
            started: false,
            reason: 'Fly machine never reached started (last state=' + lastState + '). Try again or check Fly capacity in region.'
        };
    }

    console.log('Fly assembly machine started:', machineId, 'state=' + lastState, 'for job', jobId);
    return { started: true, machineId: machineId, state: lastState };
}

/**
 * Start a scraper machine for a scrape_runs document.
 */
async function startScraperMachine(runId) {
    const app = process.env.FLY_SCRAPER_APP;
    if (!process.env.FLY_API_TOKEN || !app) {
        console.log('Fly scraper not configured — skipping machine start');
        return false;
    }

    const image = process.env.FLY_SCRAPER_IMAGE;
    if (!image) {
        console.warn('FLY_SCRAPER_IMAGE not set — cannot create machine');
        return false;
    }

    const mongoUri = resolveMongoUri();
    if (!mongoUri) {
        console.warn('Fly scraper aborted: Mongo URI missing');
        return false;
    }
    const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
    const appInternal = (process.env.APP_INTERNAL_URL || process.env.DIGITALOCEAN_APP_URL || '')
        .replace(/\/$/, '');
    const env = {
        RUN_ID: String(runId),
        JOB_TYPE: 'scrape',
        WORKER_SECRET: (process.env.WORKER_SECRET || '').trim(),
        APP_URL: appUrl,
        APP_INTERNAL_URL: appInternal,
        MONGODB_URI: mongoUri,
        V2_MONGO_URI: mongoUri,
        YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY || '',
        SCRAPE_SCROLL_COUNT: process.env.SCRAPE_SCROLL_COUNT || '25',
        SCRAPE_MAX_CHANNELS: process.env.SCRAPE_MAX_CHANNELS || '40'
    };

    const machine = await flyRequest('POST', '/apps/' + app + '/machines', {
        name: 'scrape-' + String(runId).slice(-12),
        config: {
            image,
            env,
            guest: {
                cpu_kind: 'shared',
                cpus: 2,
                memory_mb: 2048
            },
            auto_destroy: true,
            restart: { policy: 'no' }
        }
    });

    console.log('Fly scraper machine started:', machine && machine.id, 'for run', runId);
    return !!(machine && machine.id);
}

/**
 * Max concurrent ranking Fly machines (default 3).
 * Extra jobs stay queued in Mongo until a slot frees.
 */
function assemblyMaxConcurrent() {
    const n = parseInt(process.env.FLY_ASSEMBLY_MAX_CONCURRENT || '3', 10);
    return Number.isFinite(n) && n > 0 ? n : 3;
}

async function countActiveFlyAssemblyJobs(db) {
    const cutoff = new Date(Date.now() - 45 * 60 * 1000);
    return db.collection('ranking_jobs').countDocuments({
        worker: 'fly',
        status: 'processing',
        flyStartedAt: { $gte: cutoff }
    });
}

/**
 * Start queued Fly ranking jobs until concurrency limit is reached.
 * Returns number of machines started.
 */
async function drainFlyAssemblyQueue(db, updateJobFn) {
    if (!db || typeof updateJobFn !== 'function') return 0;
    let started = 0;
    const max = assemblyMaxConcurrent();

    while (true) {
        const active = await countActiveFlyAssemblyJobs(db);
        if (active >= max) break;

        const next = await db.collection('ranking_jobs').findOne(
            { status: 'queued', flyQueued: true, payload: { $exists: true } },
            { sort: { createdAt: 1 } }
        );
        if (!next) break;

        const jobId = String(next._id);
        try {
            const flyResult = await startAssemblyMachine(jobId, next.payload || null);
            if (flyResult && flyResult.started) {
                var existing = await db.collection('ranking_jobs').findOne({ _id: next._id });
                var live = existing && (
                    existing.flyHeartbeatAt ||
                    (existing.message && /^Fly: /i.test(existing.message) && !/waiting for worker heartbeat/i.test(existing.message))
                );
                var patch = {
                    worker: 'fly',
                    flyQueued: false,
                    flyMachineId: flyResult.machineId || null,
                    flyStartedAt: new Date()
                };
                if (!live) {
                    patch.status = 'processing';
                    patch.message = 'Fly machine started — waiting for worker heartbeat…';
                }
                await updateJobFn(jobId, patch);
                started += 1;
            } else {
                await updateJobFn(jobId, {
                    status: 'failed',
                    error: 'Fly start failed: ' + (flyResult && flyResult.reason ? flyResult.reason : 'unknown'),
                    flyQueued: false,
                    commentaryRefundNeeded: !!next.commentaryCreditsReserved
                });
                break;
            }
        } catch (err) {
            await updateJobFn(jobId, {
                status: 'failed',
                error: 'Fly start failed: ' + err.message,
                flyQueued: false,
                commentaryRefundNeeded: !!next.commentaryCreditsReserved
            });
            break;
        }
    }
    return started;
}

module.exports = {
    flyConfigured,
    resolveMongoUri,
    startAssemblyMachine,
    startScraperMachine,
    assemblyMaxConcurrent,
    countActiveFlyAssemblyJobs,
    drainFlyAssemblyQueue
};
