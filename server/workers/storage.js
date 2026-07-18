/**
 * Durable object storage for assembled videos (AWS S3 or DigitalOcean Spaces).
 * Falls back to null when not configured — callers keep local disk URLs.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

let client = null;

function resolveEndpoint() {
    const explicit = process.env.SPACES_ENDPOINT || process.env.S3_ENDPOINT || '';
    if (explicit) return explicit.replace(/\/$/, '');
    // DO Spaces keys without endpoint would otherwise hit AWS S3 and fail auth.
    // Regions look like sfo3 / nyc3 / fra1 (not AWS-style us-east-1).
    const region = process.env.SPACES_REGION || process.env.AWS_REGION || '';
    if (/^[a-z]{3}\d$/i.test(region)) {
        return 'https://' + region + '.digitaloceanspaces.com';
    }
    return null;
}

function getClient() {
    if (client) return client;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID || process.env.SPACES_KEY;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || process.env.SPACES_SECRET;
    if (!accessKeyId || !secretAccessKey) return null;

    const endpoint = resolveEndpoint();
    const region = process.env.AWS_REGION || process.env.SPACES_REGION || 'us-east-1';

    client = new S3Client({
        region,
        endpoint: endpoint || undefined,
        forcePathStyle: !!endpoint,
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
    const region = process.env.AWS_REGION || process.env.SPACES_REGION || 'us-east-1';
    const endpoint = resolveEndpoint();
    if (endpoint && bucket) {
        // DigitalOcean Spaces style: https://bucket.region.digitaloceanspaces.com
        return endpoint.replace(/\/$/, '').replace('://', '://' + bucket + '.');
    }
    if (bucket) return 'https://' + bucket + '.s3.' + region + '.amazonaws.com';
    return null;
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

    try {
        await s3.send(new PutObjectCommand(Object.assign({}, baseParams, { ACL: 'public-read' })));
    } catch (aclErr) {
        // Bucket owner-enforced / Spaces without ACL support — retry without ACL
        console.warn('S3 upload with ACL failed, retrying without ACL:', aclErr.message);
        await s3.send(new PutObjectCommand(baseParams));
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
    getPublicBaseUrl
};
