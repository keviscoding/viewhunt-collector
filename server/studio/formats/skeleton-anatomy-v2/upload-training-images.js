/**
 * Upload training images AND videos to Anthropic Files API
 * Run this once to upload all training materials and cache the file IDs
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');
require('dotenv').config();

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});

// Select key training images (diverse examples)
const TRAINING_IMAGES = [
    'Screenshot 2026-02-06 at 12.09.19.png', // Opening shot
    'Screenshot 2026-02-06 at 12.09.23.png', // Close-up face
    'Screenshot 2026-02-06 at 12.09.28.png', // Medium shot
    'Screenshot 2026-02-06 at 12.09.36.png', // Different angle
    'Screenshot 2026-02-06 at 12.09.50.png', // Macro detail
    'Screenshot 2026-02-06 at 12.10.00.png', // Interior body shot
    'Screenshot 2026-02-06 at 12.10.13.png', // Wide shot
    'Screenshot 2026-02-06 at 12.10.27.png', // Degradation example
    'Screenshot 2026-02-06 at 12.10.42.png', // Different lighting
    'Screenshot 2026-02-06 at 12.11.04.png', // Action shot
];

// Select key training videos (full examples)
const TRAINING_VIDEOS = [
    'Training LEGS Only？(1).mp4',
    'What If You Were Raised by Lions_ [DownSub.com].txt', // Transcript
];

const CACHE_FILE = path.join(__dirname, 'training-files-cache.json');

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

async function uploadTrainingMaterials() {
    console.log('🎨 Uploading training materials to Anthropic Files API...\n');
    
    // Check if we already have cached file IDs
    if (fs.existsSync(CACHE_FILE)) {
        console.log('✅ Found cached file IDs');
        const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        console.log(`Cached ${cache.images.length} images and ${cache.videos.length} videos from ${cache.uploadedAt}`);
        console.log('\nTo re-upload, delete:', CACHE_FILE);
        return cache;
    }
    
    const uploadedImages = [];
    const uploadedVideos = [];
    
    const imagesDir = path.join(__dirname, '../../../../../Broll Images/What happens if you train legs only');
    const videosDir = path.join(__dirname, '../../../../../Skeleton Training DATA');
    
    console.log('Images directory:', imagesDir);
    console.log('Videos directory:', videosDir);
    console.log('');
    
    // Upload images
    console.log('📸 Uploading training images...\n');
    for (const imageName of TRAINING_IMAGES) {
        const imagePath = path.join(imagesDir, imageName);
        
        if (!fs.existsSync(imagePath)) {
            console.warn(`⚠️  Image not found: ${imageName}`);
            continue;
        }
        
        try {
            const fileData = await uploadFileToAnthropic(imagePath, imageName);
            uploadedImages.push({
                name: imageName,
                fileId: fileData.id,
                mimeType: fileData.mime_type,
                size: fileData.size_bytes
            });
        } catch (error) {
            console.error(`Failed to upload image: ${imageName}`);
        }
    }
    
    // Upload videos
    console.log('\n🎥 Uploading training videos...\n');
    for (const videoName of TRAINING_VIDEOS) {
        const videoPath = path.join(videosDir, videoName);
        
        if (!fs.existsSync(videoPath)) {
            console.warn(`⚠️  Video not found: ${videoName}`);
            continue;
        }
        
        try {
            const fileData = await uploadFileToAnthropic(videoPath, videoName);
            uploadedVideos.push({
                name: videoName,
                fileId: fileData.id,
                mimeType: fileData.mime_type,
                size: fileData.size_bytes
            });
        } catch (error) {
            console.error(`Failed to upload video: ${videoName}`);
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

// Run if called directly
if (require.main === module) {
    uploadTrainingMaterials()
        .then(() => {
            console.log('\n🎉 Training materials ready!');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n❌ Upload failed:', error);
            process.exit(1);
        });
}

module.exports = { uploadTrainingMaterials };
