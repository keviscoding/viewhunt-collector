/**
 * Fly Machines API helpers — spawn ephemeral workers for assembly / scraping.
 *
 * Env:
 *   FLY_API_TOKEN
 *   FLY_ASSEMBLY_APP
 *   FLY_SCRAPER_APP
 *   WORKER_SECRET
 *   APP_URL (base URL of the DigitalOcean app)
 */
const FLY_API = 'https://api.machines.dev/v1';

function flyConfigured(appEnv) {
    return !!(process.env.FLY_API_TOKEN && process.env[appEnv]);
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
        const msg = (data && (data.error || data.message)) || text || res.statusText;
        throw new Error('Fly API ' + res.status + ': ' + msg);
    }
    return data;
}

/**
 * Start an assembly machine for a ranking job.
 * Returns true if a machine was started, false if Fly is not configured.
 */
async function startAssemblyMachine(jobId) {
    const app = process.env.FLY_ASSEMBLY_APP;
    if (!process.env.FLY_API_TOKEN || !app) {
        console.log('Fly assembly not configured — skipping machine start');
        return false;
    }

    const image = process.env.FLY_ASSEMBLY_IMAGE;
    if (!image) {
        console.warn('FLY_ASSEMBLY_IMAGE not set — cannot create machine');
        return false;
    }

    const env = {
        JOB_ID: String(jobId),
        JOB_TYPE: 'ranking_assemble',
        WORKER_SECRET: process.env.WORKER_SECRET || '',
        APP_URL: process.env.APP_URL || '',
        MONGODB_URI: process.env.V2_MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URI || '',
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || process.env.SPACES_KEY || '',
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || process.env.SPACES_SECRET || '',
        AWS_S3_BUCKET_NAME: process.env.AWS_S3_BUCKET_NAME || process.env.SPACES_BUCKET || '',
        AWS_REGION: process.env.AWS_REGION || process.env.SPACES_REGION || 'us-east-1',
        SPACES_ENDPOINT: process.env.SPACES_ENDPOINT || '',
        SPACES_CDN_URL: process.env.SPACES_CDN_URL || '',
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || ''
    };

    // More RAM/CPU when jobs may run Gemini vision + TTS + Whisper + FFmpeg
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

    console.log('Fly assembly machine started:', machine && machine.id, 'for job', jobId);
    return true;
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

    const env = {
        RUN_ID: String(runId),
        JOB_TYPE: 'scrape',
        WORKER_SECRET: process.env.WORKER_SECRET || '',
        APP_URL: process.env.APP_URL || '',
        MONGODB_URI: process.env.V2_MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URI || '',
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
    startAssemblyMachine,
    startScraperMachine
};
