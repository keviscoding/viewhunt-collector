/**
 * Durable object storage for assembled videos (AWS S3 or DigitalOcean Spaces).
 * Falls back to null when not configured — callers keep local disk URLs.
 *
 * DigitalOcean Spaces + AWS SDK v3:
 *   endpoint = https://<dc>.digitaloceanspaces.com  (e.g. sfo3)
 *   region   = us-east-1  (SDK signing requirement; DC comes from endpoint)
 *   forcePathStyle = false
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

let client = null;

function spacesDatacenter() {
    const fromEnv = process.env.SPACES_REGION || '';
    if (/^[a-z]{3}\d$/i.test(fromEnv)) return fromEnv.toLowerCase();
    const endpoint = process.env.SPACES_ENDPOINT || process.env.S3_ENDPOINT || '';
    const m = endpoint.match(/https?:\/\/([a-z]{3}\d)\.digitaloceanspaces\.com/i);
    if (m) return m[1].toLowerCase();
    const awsRegion = process.env.AWS_REGION || '';
    if (/^[a-z]{3}\d$/i.test(awsRegion)) return awsRegion.toLowerCase();
    return null;
}

function resolveEndpoint() {
    const explicit = process.env.SPACES_ENDPOINT || process.env.S3_ENDPOINT || '';
    if (explicit) return explicit.replace(/\/$/, '');
    const dc = spacesDatacenter();
    if (dc) return 'https://' + dc + '.digitaloceanspaces.com';
    return null;
}

function isSpaces() {
    return !!resolveEndpoint();
}

function getClient() {
    if (client) return client;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.SPACES_KEY;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.SPACES_SECRET;
    if (!accessKeyId || !secretAccessKey) return null;

    const endpoint = resolveEndpoint();
    // DO Spaces requires AWS region us-east-1 for SDK signing; real DC is the endpoint.
    const region = endpoint ? 'us-east-1' : (process.env.AWS_REGION || 'us-east-1');

    client = new S3Client({
        region,
        endpoint: endpoint || undefined,
        forcePathStyle: false,
        credentials: { accessKeyId, secretAccessKey }
    });
    return client;
}

function getBucket() {
    return process.env.AWS_S3_BUCKET_NAME || process.env.SPACES_BUCKET || null;
}

function getPublicBaseUrl() {
    if (process.env.SPACES_CDN_URL) return process.env.SPACES_CDN_URL.replace(/\/$/, '');
    if (process.env.S3_PUBLIC_BASE_URL) return process.env.S3_PUBLIC_BASE_URL.replace(/\/$/, '');
    const bucket = getBucket();
    const endpoint = resolveEndpoint();
    if (endpoint && bucket) {
        // https://bucket.sfo3.digitaloceanspaces.com
        return endpoint.replace(/\/$/, '').replace('://', '://' + bucket + '.');
    }
    const region = process.env.AWS_REGION || 'us-east-1';
    if (bucket) return 'https://' + bucket + '.s3.' + region + '.amazonaws.com';
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

    // Prefer no ACL first — some Spaces buckets reject canned ACLs with opaque UnknownError
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
