/**
 * Durable object storage for assembled videos (AWS S3 or DigitalOcean Spaces).
 *
 * DigitalOcean Spaces + AWS SDK v3:
 *   endpoint = https://<dc>.digitaloceanspaces.com  (e.g. sfo3) — NOT the bucket URL
 *   region   = us-east-1  (SDK signing; datacenter comes from endpoint)
 *   forcePathStyle = true  (avoids bucket.endpoint TLS hostname bugs)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

let client = null;
let cachedConfig = null;

/**
 * Normalize Spaces env. Common misconfig:
 *   SPACES_ENDPOINT=https://viewhunt-media.sfo3.digitaloceanspaces.com
 *   SPACES_BUCKET=justselfiesbro
 * → SDK tries justselfiesbro.viewhunt-media.sfo3... and TLS fails.
 */
function getSpacesConfig() {
    if (cachedConfig) return cachedConfig;

    let endpoint = (process.env.SPACES_ENDPOINT || process.env.S3_ENDPOINT || '').replace(/\/$/, '');
    let bucket = process.env.SPACES_BUCKET || process.env.AWS_S3_BUCKET_NAME || null;

    // Virtual-hosted: https://bucket.sfo3.digitaloceanspaces.com
    const vh = endpoint.match(/^https?:\/\/([^.]+)\.([a-z]{3}\d)\.digitaloceanspaces\.com$/i);
    if (vh) {
        const hostBucket = vh[1];
        const dc = vh[2].toLowerCase();
        endpoint = 'https://' + dc + '.digitaloceanspaces.com';
        if (!bucket || bucket !== hostBucket) {
            console.warn(
                'Spaces config: using bucket "' + hostBucket + '" from SPACES_ENDPOINT' +
                (bucket && bucket !== hostBucket ? ' (ignored SPACES_BUCKET=' + bucket + ')' : '')
            );
            bucket = hostBucket;
        }
        cachedConfig = { endpoint: endpoint, bucket: bucket, dc: dc, spaces: true };
        return cachedConfig;
    }

    // Regional: https://sfo3.digitaloceanspaces.com
    const regional = endpoint.match(/^https?:\/\/([a-z]{3}\d)\.digitaloceanspaces\.com$/i);
    if (regional) {
        cachedConfig = {
            endpoint: endpoint,
            bucket: bucket,
            dc: regional[1].toLowerCase(),
            spaces: true
        };
        return cachedConfig;
    }

    // Infer from SPACES_REGION / AWS_REGION like sfo3
    const regionHint = process.env.SPACES_REGION || process.env.AWS_REGION || '';
    if (/^[a-z]{3}\d$/i.test(regionHint) && bucket) {
        cachedConfig = {
            endpoint: 'https://' + regionHint.toLowerCase() + '.digitaloceanspaces.com',
            bucket: bucket,
            dc: regionHint.toLowerCase(),
            spaces: true
        };
        return cachedConfig;
    }

    if (endpoint) {
        cachedConfig = { endpoint: endpoint, bucket: bucket, dc: null, spaces: true };
        return cachedConfig;
    }

    cachedConfig = { endpoint: null, bucket: bucket, dc: null, spaces: false };
    return cachedConfig;
}

function resolveEndpoint() {
    return getSpacesConfig().endpoint;
}

function isSpaces() {
    return getSpacesConfig().spaces;
}

function getClient() {
    if (client) return client;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.SPACES_KEY;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.SPACES_SECRET;
    if (!accessKeyId || !secretAccessKey) return null;

    const cfg = getSpacesConfig();
    const region = cfg.spaces ? 'us-east-1' : (process.env.AWS_REGION || 'us-east-1');

    client = new S3Client({
        region: region,
        endpoint: cfg.endpoint || undefined,
        // Path-style: https://sfo3.digitaloceanspaces.com/bucket/key — cert matches
        forcePathStyle: !!cfg.endpoint,
        credentials: { accessKeyId: accessKeyId, secretAccessKey: secretAccessKey }
    });
    return client;
}

function getBucket() {
    return getSpacesConfig().bucket;
}

function getPublicBaseUrl() {
    if (process.env.SPACES_CDN_URL) return process.env.SPACES_CDN_URL.replace(/\/$/, '');
    if (process.env.S3_PUBLIC_BASE_URL) return process.env.S3_PUBLIC_BASE_URL.replace(/\/$/, '');
    const cfg = getSpacesConfig();
    if (cfg.spaces && cfg.bucket && cfg.dc) {
        return 'https://' + cfg.bucket + '.' + cfg.dc + '.digitaloceanspaces.com';
    }
    if (cfg.endpoint && cfg.bucket) {
        return cfg.endpoint.replace(/\/$/, '').replace('://', '://' + cfg.bucket + '.');
    }
    const region = process.env.AWS_REGION || 'us-east-1';
    if (cfg.bucket) return 'https://' + cfg.bucket + '.s3.' + region + '.amazonaws.com';
    return null;
}

function formatS3Error(err) {
    if (!err) return 'unknown';
    const parts = [
        err.name,
        err.Code || err.code,
        err.message,
        err.$metadata && err.$metadata.httpStatusCode
            ? ('http=' + err.$metadata.httpStatusCode)
            : null
    ].filter(Boolean);
    return parts.join(' | ');
}

/**
 * Upload a local file and return a public URL, or null if storage is not configured.
 */
async function uploadFile(localPath, keyPrefix) {
    const s3 = getClient();
    const bucket = getBucket();
    if (!s3 || !bucket) return null;

    const ext = path.extname(localPath) || '.mp4';
    const key = (keyPrefix || 'studio/final') + '/' + Date.now() + '-' +
        crypto.randomBytes(4).toString('hex') + ext;
    const body = fs.readFileSync(localPath);
    const contentType = ext === '.mp4' ? 'video/mp4' : 'application/octet-stream';
    const baseParams = {
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType
    };

    console.log('Object storage upload', {
        bucket: bucket,
        key: key,
        bytes: body.length,
        endpoint: resolveEndpoint() || '(aws default)',
        spaces: isSpaces(),
        publicBase: getPublicBaseUrl()
    });

    try {
        await s3.send(new PutObjectCommand(baseParams));
    } catch (noAclErr) {
        console.warn('S3 upload without ACL failed, retrying with public-read:', formatS3Error(noAclErr));
        try {
            await s3.send(new PutObjectCommand(Object.assign({}, baseParams, { ACL: 'public-read' })));
        } catch (err2) {
            console.error('S3 upload failed:', formatS3Error(err2));
            throw err2;
        }
    }

    const base = getPublicBaseUrl();
    if (!base) return null;
    return base + '/' + key;
}

function isConfigured() {
    return !!(getClient() && getBucket());
}

module.exports = {
    uploadFile,
    isConfigured,
    getPublicBaseUrl,
    resolveEndpoint,
    formatS3Error
};
