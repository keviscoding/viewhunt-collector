/**
 * AI Avatar Generator — Higgsfield Soul ID Integration
 * 
 * Creates consistent AI characters from user photos, then generates
 * images of that character in any scenario. Optionally converts to video.
 * 
 * Flow:
 *   1. Upload training photos to S3 (public-read)
 *   2. Create character via Higgsfield custom-references API
 *   3. Poll until character training completes
 *   4. Generate images with character likeness via Soul API
 *   5. Optionally describe reference images via GPT-4o Vision
 */
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const axios = require('axios');
const crypto = require('crypto');

const HF_BASE = 'https://platform.higgsfield.ai';
const DEFAULT_STYLE_ID = '464ea177-8d40-4940-8d9d-b438bab269c7';

class AvatarGenerator {
    constructor() {
        this.s3 = null;
    }

    _getS3() {
        if (!this.s3) {
            this.s3 = new S3Client({
                region: process.env.AWS_REGION || 'us-east-1',
                credentials: {
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
                }
            });
        }
        return this.s3;
    }

    _hfHeaders() {
        return {
            'Content-Type': 'application/json',
            'hf-api-key': process.env.HIGGSFIELD_API_KEY,
            'hf-secret': process.env.HIGGSFIELD_SECRET
        };
    }

    /**
     * Upload a buffer to S3 with public-read ACL.
     * Returns the public URL.
     */
    async uploadToS3(buffer, fileName, contentType) {
        var bucket = process.env.AWS_S3_BUCKET_NAME;
        var region = process.env.AWS_REGION || 'us-east-1';
        var key = 'avatar-photos/' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '-' + fileName;

        var cmd = new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: buffer,
            ContentType: contentType || 'image/jpeg',
            ACL: 'public-read'
        });

        await this._getS3().send(cmd);
        return 'https://' + bucket + '.s3.' + region + '.amazonaws.com/' + key;
    }

    /**
     * Create a character from an array of S3 image URLs.
     * Returns { id, name, status }
     */
    async createCharacter(name, imageUrls) {
        var inputImages = imageUrls.map(function(url) {
            return { type: 'image_url', image_url: url };
        });

        var res = await axios.post(HF_BASE + '/v1/custom-references', {
            name: name,
            input_images: inputImages
        }, { headers: this._hfHeaders(), timeout: 30000 });

        console.log('🎭 Avatar: character created — id=' + res.data.id + ' name=' + name);
        return res.data;
    }

    /**
     * Get character status. Poll until status === 'completed'.
     */
    async getCharacterStatus(characterId) {
        var res = await axios.get(HF_BASE + '/v1/custom-references/' + characterId, {
            headers: this._hfHeaders(), timeout: 15000
        });
        return res.data;
    }

    /**
     * Poll character training until complete or failed.
     * Returns the final character object.
     */
    async waitForCharacter(characterId, maxAttempts) {
        maxAttempts = maxAttempts || 120; // 10 min at 5s intervals
        for (var i = 0; i < maxAttempts; i++) {
            var char = await this.getCharacterStatus(characterId);
            if (char.status === 'completed') return char;
            if (char.status === 'failed') throw new Error('Character training failed');
            await new Promise(function(r) { setTimeout(r, 5000); });
        }
        throw new Error('Character training timed out');
    }

    /**
     * Fetch available soul styles from Higgsfield.
     */
    async getStyles() {
        var res = await axios.get(HF_BASE + '/v1/text2image/soul-styles', {
            headers: this._hfHeaders(), timeout: 15000
        });
        return res.data;
    }

    /**
     * Generate images using Soul API.
     * Returns { jobSetId, jobs }
     */
    async generateImages(opts) {
        var params = {
            prompt: opts.prompt,
            width_and_height: opts.size || '1152x2048',
            enhance_prompt: opts.enhancePrompt !== false,
            style_id: opts.styleId || DEFAULT_STYLE_ID,
            style_strength: opts.styleStrength || 1,
            quality: opts.quality || '1080p',
            seed: opts.seed || null,
            custom_reference_id: opts.characterId,
            custom_reference_strength: opts.referenceStrength || 1,
            batch_size: opts.batchSize || 4
        };

        var res = await axios.post(HF_BASE + '/v1/text2image/soul', {
            params: params
        }, { headers: this._hfHeaders(), timeout: 30000 });

        console.log('🎭 Avatar: generation started — jobSet=' + res.data.id);
        return { jobSetId: res.data.id, jobs: res.data.jobs || [] };
    }

    /**
     * Poll a job set until all jobs complete or fail.
     * Returns array of result objects { status, imageUrl, rawUrl }
     */
    async pollJobSet(jobSetId, maxAttempts) {
        maxAttempts = maxAttempts || 60; // 5 min at 5s intervals
        for (var i = 0; i < maxAttempts; i++) {
            var res = await axios.get(HF_BASE + '/v1/job-sets/' + jobSetId, {
                headers: this._hfHeaders(), timeout: 15000
            });
            var jobs = res.data.jobs || [];
            var allDone = jobs.every(function(j) {
                return j.status === 'completed' || j.status === 'failed' || j.status === 'nsfw';
            });

            if (allDone) {
                return jobs.map(function(j) {
                    var result = { status: j.status, imageUrl: null, rawUrl: null };
                    if (j.status === 'completed' && j.results) {
                        result.imageUrl = j.results.min ? j.results.min.url : null;
                        result.rawUrl = j.results.raw ? j.results.raw.url : null;
                    }
                    return result;
                });
            }
            await new Promise(function(r) { setTimeout(r, 5000); });
        }
        throw new Error('Image generation timed out');
    }

    /**
     * Use GPT-4o Vision to describe a reference image (scene only, not person).
     * Returns a prompt string.
     */
    async describeReferenceImage(imageUrl, userPrompt) {
        var openai = require('openai');
        var client = new openai.OpenAI({ apiKey: process.env.OPENAI_API_KEY });

        var systemPrompt = 'You are a prompt engineer for an AI image generation tool. Given a reference photo, describe the SCENE, POSE, SETTING, LIGHTING, CLOTHING, and COMPOSITION in detail — but DO NOT describe the person\'s physical appearance (skin color, ethnicity, facial features, hair color, body type, etc). The AI will use a separate character model for the person\'s identity.\n\nFocus on:\n- The pose and body language\n- The setting/location\n- Lighting conditions\n- Clothing and accessories\n- Camera angle and framing\n- Mood and atmosphere\n- Any props or objects in the scene\n\nOutput ONLY the prompt text, nothing else. Keep it under 200 words.';

        var res = await client.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: [
                    { type: 'text', text: 'Describe this photo for AI image generation:' },
                    { type: 'image_url', image_url: { url: imageUrl } }
                ]}
            ],
            max_tokens: 300
        });

        var description = res.choices[0].message.content.trim();
        if (userPrompt) {
            description = description + '. ' + userPrompt;
        }
        return description;
    }
}

module.exports = AvatarGenerator;
