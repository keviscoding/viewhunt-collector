/**
 * Simple HTTP endpoint to upload training materials
 * Access via: https://viewhunt.app/api/studio/upload-training
 */

const express = require('express');
const multer = require('multer');
const FormData = require('form-data');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// Configure multer for file uploads
const upload = multer({ 
    dest: '/tmp/training-uploads/',
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

const CACHE_FILE = path.join(__dirname, 'formats/skeleton-anatomy-v2/training-files-cache.json');

async function uploadToAnthropic(filePath, filename) {
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
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        }
    );
    
    return response.data;
}

// Upload training files endpoint
router.post('/upload-training', upload.array('files', 20), async (req, res) => {
    try {
        console.log(`Received ${req.files.length} files for upload`);
        
        const uploadedImages = [];
        const uploadedVideos = [];
        
        for (const file of req.files) {
            const filename = file.originalname;
            console.log(`Uploading ${filename} to Anthropic...`);
            
            try {
                const fileData = await uploadToAnthropic(file.path, filename);
                
                const fileInfo = {
                    name: filename,
                    fileId: fileData.id,
                    mimeType: fileData.mime_type,
                    size: fileData.size_bytes
                };
                
                if (filename.endsWith('.mp4')) {
                    uploadedVideos.push(fileInfo);
                } else if (filename.endsWith('.png') || filename.endsWith('.jpg')) {
                    uploadedImages.push(fileInfo);
                } else if (filename.endsWith('.txt') || filename.endsWith('.md')) {
                    uploadedVideos.push(fileInfo); // Transcripts and docs go with videos
                }
                
                // Clean up temp file
                fs.unlinkSync(file.path);
                
            } catch (error) {
                console.error(`Failed to upload ${filename}:`, error.message);
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
        
        res.json({
            success: true,
            uploaded: cache.totalFiles,
            images: uploadedImages.length,
            videos: uploadedVideos.length,
            message: 'Training materials uploaded successfully!'
        });
        
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Simple upload form
router.get('/upload-training-form', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Upload Training Materials</title>
            <style>
                body { font-family: Arial; max-width: 800px; margin: 50px auto; padding: 20px; }
                h1 { color: #667eea; }
                .upload-area { border: 2px dashed #667eea; padding: 40px; text-align: center; margin: 20px 0; }
                button { background: #667eea; color: white; padding: 15px 30px; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; }
                button:hover { background: #5568d3; }
                #status { margin-top: 20px; padding: 15px; border-radius: 8px; }
                .success { background: #d4edda; color: #155724; }
                .error { background: #f8d7da; color: #721c24; }
            </style>
        </head>
        <body>
            <h1>🎨 Upload Training Materials</h1>
            <p>Select all your training videos and images (you can select multiple files at once)</p>
            
            <div class="upload-area">
                <input type="file" id="fileInput" multiple accept=".mp4,.png,.jpg,.txt,.md" style="display: none;">
                <button onclick="document.getElementById('fileInput').click()">Choose Files</button>
                <p id="fileCount"></p>
            </div>
            
            <button id="uploadBtn" onclick="uploadFiles()" style="display: none;">Upload to Anthropic</button>
            
            <div id="status"></div>
            
            <script>
                const fileInput = document.getElementById('fileInput');
                const fileCount = document.getElementById('fileCount');
                const uploadBtn = document.getElementById('uploadBtn');
                const status = document.getElementById('status');
                
                fileInput.addEventListener('change', () => {
                    const files = fileInput.files;
                    if (files.length > 0) {
                        fileCount.textContent = files.length + ' files selected';
                        uploadBtn.style.display = 'block';
                    }
                });
                
                async function uploadFiles() {
                    const files = fileInput.files;
                    if (files.length === 0) return;
                    
                    uploadBtn.disabled = true;
                    uploadBtn.textContent = 'Uploading...';
                    status.innerHTML = '<p>⏳ Uploading files to Anthropic...</p>';
                    
                    const formData = new FormData();
                    for (let file of files) {
                        formData.append('files', file);
                    }
                    
                    try {
                        const response = await fetch('/api/studio/upload-training', {
                            method: 'POST',
                            body: formData
                        });
                        
                        const result = await response.json();
                        
                        if (result.success) {
                            status.className = 'success';
                            status.innerHTML = 
                                '<h3>✅ Upload Complete!</h3>' +
                                '<p>Uploaded ' + result.uploaded + ' files:</p>' +
                                '<ul>' +
                                '<li>' + result.images + ' images</li>' +
                                '<li>' + result.videos + ' videos</li>' +
                                '</ul>' +
                                '<p>You can now use the V2 generator!</p>';
                        } else {
                            throw new Error(result.error);
                        }
                    } catch (error) {
                        status.className = 'error';
                        status.innerHTML = '<h3>❌ Upload Failed</h3><p>' + error.message + '</p>';
                    } finally {
                        uploadBtn.disabled = false;
                        uploadBtn.textContent = 'Upload to Anthropic';
                    }
                }
            </script>
        </body>
        </html>
    `);
});

module.exports = router;
