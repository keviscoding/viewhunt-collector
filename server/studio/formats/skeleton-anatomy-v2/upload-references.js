#!/usr/bin/env node

/**
 * ONE-TIME SETUP SCRIPT
 * 
 * Run this once to upload all reference frames to Anthropic Files API.
 * It will save the file IDs to reference-file-ids.json
 * 
 * Usage:
 *   node upload-references.js
 * 
 * Requirements:
 *   - ANTHROPIC_API_KEY environment variable set
 *   - Reference frames in ../../../../../../training-upload/images/
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});

// Path to reference frames
const REFERENCE_FRAMES_DIR = path.join(__dirname, '../../../../../../training-upload/images');
const OUTPUT_FILE = path.join(__dirname, 'reference-file-ids.json');

async function uploadReferenceFrames() {
    console.log('🎬 Starting reference frame upload to Anthropic Files API...\n');
    
    // Check if directory exists
    if (!fs.existsSync(REFERENCE_FRAMES_DIR)) {
        console.error(`❌ Reference frames directory not found: ${REFERENCE_FRAMES_DIR}`);
        console.error('Please make sure training-upload/images/ exists with your reference frames.');
        process.exit(1);
    }
    
    // Get all image files
    const files = fs.readdirSync(REFERENCE_FRAMES_DIR)
        .filter(file => /\.(png|jpg|jpeg)$/i.test(file))
        .sort(); // Sort for consistent ordering
    
    console.log(`Found ${files.length} reference frames to upload\n`);
    
    if (files.length === 0) {
        console.error('❌ No image files found in reference frames directory');
        process.exit(1);
    }
    
    const uploadedFiles = [];
    let successCount = 0;
    let failCount = 0;
    
    // Upload each file
    for (let i = 0; i < files.length; i++) {
        const filename = files[i];
        const filepath = path.join(REFERENCE_FRAMES_DIR, filename);
        
        try {
            console.log(`[${i + 1}/${files.length}] Uploading ${filename}...`);
            
            // Read file as buffer
            const fileBuffer = fs.readFileSync(filepath);
            
            // Create a File object (Node.js 20+ has native File support)
            const file = new File([fileBuffer], filename, {
                type: filename.endsWith('.png') ? 'image/png' : 'image/jpeg'
            });
            
            // Upload to Anthropic Files API
            const uploadedFile = await anthropic.files.create({
                file: file,
                purpose: 'vision'
            });
            
            uploadedFiles.push({
                filename: filename,
                fileId: uploadedFile.id,
                uploadedAt: new Date().toISOString()
            });
            
            successCount++;
            console.log(`✅ Uploaded: ${uploadedFile.id}`);
            
        } catch (error) {
            failCount++;
            console.error(`❌ Failed to upload ${filename}:`, error.message);
        }
    }
    
    // Save file IDs to JSON
    const output = {
        uploadedAt: new Date().toISOString(),
        totalFiles: uploadedFiles.length,
        files: uploadedFiles
    };
    
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
    
    console.log(`\n✅ Upload complete!`);
    console.log(`   Success: ${successCount}`);
    console.log(`   Failed: ${failCount}`);
    console.log(`   File IDs saved to: ${OUTPUT_FILE}`);
    console.log(`\nYou can now use these file IDs in your Claude API calls.`);
}

// Run the upload
uploadReferenceFrames().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
