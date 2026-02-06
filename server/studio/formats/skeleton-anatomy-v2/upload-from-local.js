/**
 * Upload training materials from local server directory
 * This runs ON the DigitalOcean server after you've uploaded files there
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');
require('dotenv').config();

const CACHE_FILE = path.join(__dirname, 'training-files-cache.json');

// Training materials to upload (relative to /workspace)
const TRAINING_MATERIALS = {
    videos: [
        'training-data/Training LEGS Only.mp4',
        'training-data/What If You Were Raised by Lions.mp4',
    ],
    images: [
        'training-data/images/Screenshot 2026-02-06 at 12.09.19.png',
        'training-data/images/Screenshot 2026-02-06 at 12.09.23.png',
        'training-data/images/Screenshot 2026-02-06 at 12.09.28.png',
        'training-data/images/Screenshot 2026-02-06 at 12.09.36.png',
        'training-data/images/Screenshot 2026-02-06 at 12.09.50.png',
        'training-data/images/Screenshot 2026-02-06 at 12.10.00.png',
        'training-data/images/Screenshot 2026-02-06 at 12.10.13.png',
        'training-data/images/Screenshot 2026-02-06 at 12.10.27.png',
        'training-data/images/Screenshot 2026-02-06 at 12.10.42.png',
        'training-data/images/Screenshot 2026-02-06 at 12.11.04.png',
    ]
};

async function uploadFileToAnthropic(filePath, filename) {
    console.log(`📤 Uploading: ${filename}...`);
    
    try {
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath), filename);
        
        const response = await axios.post(
            'https://api.anthropic.com/v1/files',
            formData,
            {
                headers: {
                    ...formData.getHeaders(),
                    'anthropic-version': '2023-06-01',
                    'anthropic-beta': 'files-api-2025-04-14',
                    'X-Api-Key': process.env.ANTHROPIC_API_KEY
                }
            }
        );
        
        console.log(`✅ Uploaded: ${filename} (ID: ${response.data.id})`);
        return response.data;
        
    } catch (error) {
        console.error(`❌ Failed to upload ${filename}:`, error.response?.data || error.message);
        throw error;
    }
}

async function uploadFromLocal() {
    console.log('🎨 Uploading training materials from local server...\n');
    
    // Check if cache exists
    if (fs.existsSync(CACHE_FILE)) {
        console.log('✅ Found existing cache');
        const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        console.log(`Already uploaded: ${cache.images.length} images, ${cache.videos.length} videos`);
        console.log('\nTo re-upload, delete:', CACHE_FILE);
        return cache;
    }
    
    const uploadedImages = [];
    const uploadedVideos = [];
    const baseDir = '/workspace';
    
    // Upload videos
    console.log('🎥 Uploading videos...\n');
    for (const videoPath of TRAINING_MATERIALS.videos) {
        const fullPath = path.join(baseDir, videoPath);
        const filename = path.basename(videoPath);
        
        if (!fs.existsSync(fullPath)) {
            console.warn(`⚠️  Video not found: ${fullPath}`);
            continue;
        }
        
        try {
            const fileData = await uploadFileToAnthropic(fullPath, filename);
            uploadedVideos.push({
                name: filename,
                fileId: fileData.id,
                mimeType: fileData.mime_type,
                size: fileData.size_bytes
            });
        } catch (error) {
            console.error(`Failed to upload video: ${filename}`);
        }
    }
    
    // Upload images
    console.log('\n📸 Uploading images...\n');
    for (const imagePath of TRAINING_MATERIALS.images) {
        const fullPath = path.join(baseDir, imagePath);
        const filename = path.basename(imagePath);
        
        if (!fs.existsSync(fullPath)) {
            console.warn(`⚠️  Image not found: ${fullPath}`);
            continue;
        }
        
        try {
            const fileData = await uploadFileToAnthropic(fullPath, filename);
            uploadedImages.push({
                name: filename,
                fileId: fileData.id,
                mimeType: fileData.mime_type,
                size: fileData.size_bytes
            });
        } catch (error) {
            console.error(`Failed to upload image: ${filename}`);
        }
    }
    
    // Save cache
    const cache = {
        uploadedAt: new Date().toISOString(),
        images: uploadedImages,
        videos: uploadedVideos,
        totalFiles: uploadedImages.length + uploadedVideos.length
    };
    
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log(`\n✅ Uploaded ${cache.totalFiles} files to Anthropic`);
    console.log(`   - ${uploadedImages.length} images`);
    console.log(`   - ${uploadedVideos.length} videos`);
    console.log(`Cache saved to: ${CACHE_FILE}`);
    
    return cache;
}

if (require.main === module) {
    uploadFromLocal()
        .then(() => {
            console.log('\n🎉 Training materials ready!');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n❌ Upload failed:', error);
            process.exit(1);
        });
}

module.exports = { uploadFromLocal };
