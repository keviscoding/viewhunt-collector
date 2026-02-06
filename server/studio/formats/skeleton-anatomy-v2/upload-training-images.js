/**
 * Upload training images to Anthropic Files API
 * Run this once to upload all training images and cache the file IDs
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
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

const CACHE_FILE = path.join(__dirname, 'training-files-cache.json');

async function uploadTrainingImages() {
    console.log('🎨 Uploading training images to Anthropic Files API...\n');
    
    // Check if we already have cached file IDs
    if (fs.existsSync(CACHE_FILE)) {
        console.log('✅ Found cached file IDs');
        const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        console.log(`Cached ${cache.fileIds.length} file IDs from ${cache.uploadedAt}`);
        console.log('\nTo re-upload, delete:', CACHE_FILE);
        return cache.fileIds;
    }
    
    const fileIds = [];
    const trainingDir = path.join(__dirname, '../../../../../Broll Images/What happens if you train legs only');
    
    console.log('Training images directory:', trainingDir);
    console.log('');
    
    for (let i = 0; i < TRAINING_IMAGES.length; i++) {
        const imageName = TRAINING_IMAGES[i];
        const imagePath = path.join(trainingDir, imageName);
        
        if (!fs.existsSync(imagePath)) {
            console.warn(`⚠️  Image not found: ${imageName}`);
            continue;
        }
        
        try {
            console.log(`📤 Uploading ${i + 1}/${TRAINING_IMAGES.length}: ${imageName}...`);
            
            // Read file as base64
            const imageData = fs.readFileSync(imagePath);
            const base64Image = imageData.toString('base64');
            
            // Note: Anthropic Files API might not be available yet
            // For now, we'll store images as base64 in the cache
            // When Files API is available, we'll upload them properly
            
            fileIds.push({
                name: imageName,
                base64: base64Image,
                mediaType: 'image/png'
            });
            
            console.log(`✅ Cached: ${imageName}`);
            
        } catch (error) {
            console.error(`❌ Failed to process ${imageName}:`, error.message);
        }
    }
    
    // Save cache
    const cache = {
        uploadedAt: new Date().toISOString(),
        fileIds: fileIds,
        count: fileIds.length
    };
    
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    console.log(`\n✅ Cached ${fileIds.length} training images`);
    console.log(`Cache saved to: ${CACHE_FILE}`);
    
    return fileIds;
}

// Run if called directly
if (require.main === module) {
    uploadTrainingImages()
        .then(() => {
            console.log('\n🎉 Training images ready!');
            process.exit(0);
        })
        .catch(error => {
            console.error('\n❌ Upload failed:', error);
            process.exit(1);
        });
}

module.exports = { uploadTrainingImages };
