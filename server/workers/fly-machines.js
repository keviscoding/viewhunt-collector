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
async function startAssemblyMachine(jobId) {
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
    if (!mongoUri) {
        // Without Mongo the worker cannot update job status — DO would look "stuck" forever
        console.error('Fly assembly aborted: no Mongo URI in DO env (V2_MONGO_URI / MONGODB_URI / MONGO_URI)');
        return { started: false, reason: 'Mongo URI missing on DigitalOcean — cannot hand off to Fly' };
    }

    const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
    if (!appUrl) {
        console.error('Fly assembly aborted: APP_URL missing');
        return { started: false, reason: 'APP_URL missing — Fly worker cannot download clips' };
    }

    const env = {
        JOB_ID: String(jobId),
        JOB_TYPE: 'ranking_assemble',
        WORKER_SECRET: process.env.WORKER_SECRET || '',
        APP_URL: appUrl,
        MONGODB_URI: mongoUri,
        V2_MONGO_URI: mongoUri,
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || process.env.SPACES_KEY || '',
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || process.env.SPACES_SECRET || '',
        AWS_S3_BUCKET_NAME: process.env.AWS_S3_BUCKET_NAME || process.env.SPACES_BUCKET || '',
        AWS_REGION: process.env.AWS_REGION || process.env.SPACES_REGION || 'us-east-1',
        SPACES_ENDPOINT: process.env.SPACES_ENDPOINT || '',
        SPACES_CDN_URL: process.env.SPACES_CDN_URL || '',
        GEMINI_API_KEY: (process.env.GEMINI_API_KEY || '').trim(),
        OPENAI_API_KEY: (process.env.OPENAI_API_KEY || '').trim(),
        RANKING_TTS_PROVIDER: process.env.RANKING_TTS_PROVIDER || 'openai'
    };

    console.log('Starting Fly assembly machine', {
        app,
        image: image.slice(0, 80),
        jobId: String(jobId),
        hasGemini: !!env.GEMINI_API_KEY,
        hasOpenAI: !!env.OPENAI_API_KEY,
        hasSpaces: !!(env.AWS_ACCESS_KEY_ID && env.AWS_S3_BUCKET_NAME),
        mongoHost: (mongoUri.match(/@([^/]+)/) || [])[1] || '(local)'
    });

    const machine = await flyRequest('POST', '/apps/' + app + '/machines', {
        name: 'rank-' + String(jobId).slice(-12),
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
    console.log('Fly assembly machine started:', machineId, 'for job', jobId);
    return { started: true, machineId: machineId || null };
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
    const env = {
        RUN_ID: String(runId),
        JOB_TYPE: 'scrape',
        WORKER_SECRET: process.env.WORKER_SECRET || '',
        APP_URL: process.env.APP_URL || '',
        MONGODB_URI: mongoUri,
        V2_MONGO_URI: mongoUri,
        YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY || ''
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
    return true;
}

module.exports = {
    flyConfigured,
    resolveMongoUri,
    startAssemblyMachine,
    startScraperMachine
};
