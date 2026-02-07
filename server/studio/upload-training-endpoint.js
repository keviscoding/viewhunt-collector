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
const { saveTrainingCache } = require('./formats/skeleton-anatomy-v2/persist-training-cache');

const router = express.Router();

// Configure multer for file uploads
const upload = multer({ 
    dest: '/tmp/training-uploads/',
    limits: { 
        fileSize: 50 * 1024 * 1024, // 50MB per file
        files: 100 // Allow up to 100 files
    }
});

const CACHE_FILE = path.join(__dirname, 'formats/skeleton-anatomy-v2/reference-file-ids.json');

async function uploadToAnthropic(filePath, filename) {
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
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                timeout: 120000 // 2 minute timeout
            }
        );
        
        return response.data;
    } catch (error) {
        if (error.response) {
            // Anthropic API returned an error
            console.error('Anthropic API error:', error.response.status, error.response.data);
            throw new Error(`Anthropic API error: ${error.response.data.error?.message || error.response.statusText}`);
        } else if (error.request) {
            // Request was made but no response
            console.error('No response from Anthropic API');
            throw new Error('No response from Anthropic API - check network connection');
        } else {
            // Something else went wrong
            console.error('Upload setup error:', error.message);
            throw error;
        }
    }
}

// Upload training files endpoint with multer error handling
router.post('/upload-training', (req, res, next) => {
    upload.array('files', 100)(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            console.error('Multer error:', err);
            return res.status(400).json({
                success: false,
                error: `File upload error: ${err.message}. ${err.code === 'LIMIT_FILE_COUNT' ? 'Too many files.' : ''}`
            });
        } else if (err) {
            console.error('Upload error:', err);
            return res.status(500).json({
                success: false,
                error: err.message
            });
        }
        next();
    });
}, async (req, res) => {
    try {
        // Check if files were uploaded
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No files uploaded'
            });
        }
        
        console.log(`Received ${req.files.length} files for upload`);
        
        // Check if ANTHROPIC_API_KEY is set
        if (!process.env.ANTHROPIC_API_KEY) {
            console.error('ANTHROPIC_API_KEY not set in environment');
            return res.status(500).json({
                success: false,
                error: 'Server configuration error: ANTHROPIC_API_KEY not set'
            });
        }
        
        const uploadedImages = [];
        const uploadedVideos = [];
        const errors = [];
        
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
                
                console.log(`✅ Uploaded ${filename} successfully`);
                
            } catch (error) {
                console.error(`❌ Failed to upload ${filename}:`, error.message);
                errors.push({ filename, error: error.message });
            } finally {
                // Clean up temp file
                try {
                    if (fs.existsSync(file.path)) {
                        fs.unlinkSync(file.path);
                    }
                } catch (cleanupError) {
                    console.error(`Failed to cleanup ${file.path}:`, cleanupError.message);
                }
            }
        }
        
        // Save cache in the new format (compatible with reference-file-ids.json)
        const allFiles = [];
        
        // Add images
        uploadedImages.forEach(img => {
            allFiles.push({
                filename: img.name,
                fileId: img.fileId,
                uploadedAt: new Date().toISOString()
            });
        });
        
        // Add videos/docs
        uploadedVideos.forEach(vid => {
            allFiles.push({
                filename: vid.name,
                fileId: vid.fileId,
                uploadedAt: new Date().toISOString()
            });
        });
        
        const cache = {
            uploadedAt: new Date().toISOString(),
            totalFiles: allFiles.length,
            files: allFiles
        };
        
        // Ensure directory exists
        const cacheDir = path.dirname(CACHE_FILE);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
        console.log(`✅ Cache saved to ${CACHE_FILE}`);
        console.log(`Cache contains: ${cache.totalFiles} files (${uploadedImages.length} images, ${uploadedVideos.length} videos/docs)`);
        
        // Also save to in-memory global cache so the generator can always find it
        // This bypasses any filesystem issues on DigitalOcean
        global._trainingCache = cache;
        console.log(`✅ Cache also saved to in-memory global (${cache.totalFiles} files)`);
        
        // Save to MongoDB for persistence across deploys and container restarts
        try {
            await saveTrainingCache(cache);
        } catch (mongoErr) {
            console.error('MongoDB save failed (non-fatal):', mongoErr.message);
        }
        
        // Verify the file was written
        if (fs.existsSync(CACHE_FILE)) {
            const fileSize = fs.statSync(CACHE_FILE).size;
            console.log(`✅ Cache file verified: ${fileSize} bytes`);
        } else {
            console.error('❌ Cache file was not created!');
        }
        
        res.json({
            success: true,
            uploaded: cache.totalFiles,
            images: uploadedImages.length,
            videos: uploadedVideos.length,
            errors: errors.length,
            message: errors.length > 0 
                ? `Uploaded ${cache.totalFiles} files with ${errors.length} errors`
                : 'Training materials uploaded successfully! Claude can now see your reference frames.'
        });
        
    } catch (error) {
        console.error('Upload error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({
            success: false,
            error: error.message || 'Unknown error occurred'
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
                let allFiles = [];
                const fileInput = document.getElementById('fileInput');
                const fileCount = document.getElementById('fileCount');
                const uploadBtn = document.getElementById('uploadBtn');
                const status = document.getElementById('status');
                
                fileInput.addEventListener('change', () => {
                    const newFiles = Array.from(fileInput.files);
                    
                    // Add new files to the collection (avoid duplicates)
                    newFiles.forEach(file => {
                        const exists = allFiles.some(f => f.name === file.name && f.size === file.size);
                        if (!exists) {
                            allFiles.push(file);
                        }
                    });
                    
                    if (allFiles.length > 0) {
                        fileCount.innerHTML = allFiles.length + ' files selected<br><small>Click "Choose Files" again to add more from another folder</small>';
                        uploadBtn.style.display = 'block';
                    }
                    
                    // Reset input so you can select from same folder again
                    fileInput.value = '';
                });
                
                async function uploadFiles() {
                    if (allFiles.length === 0) return;
                    
                    uploadBtn.disabled = true;
                    uploadBtn.textContent = 'Uploading...';
                    status.innerHTML = '<p>⏳ Uploading ' + allFiles.length + ' files to Anthropic...</p>';
                    
                    const formData = new FormData();
                    allFiles.forEach(file => {
                        formData.append('files', file);
                    });
                    
                    try {
                        const response = await fetch('/api/studio/upload-training', {
                            method: 'POST',
                            body: formData
                        });
                        
                        // Check if response is JSON
                        const contentType = response.headers.get('content-type');
                        if (!contentType || !contentType.includes('application/json')) {
                            const text = await response.text();
                            console.error('Non-JSON response:', text);
                            throw new Error('Server returned non-JSON response. Check server logs.');
                        }
                        
                        const result = await response.json();
                        
                        if (result.success) {
                            status.className = 'success';
                            let html = 
                                '<h3>✅ Upload Complete!</h3>' +
                                '<p>Uploaded ' + result.uploaded + ' files:</p>' +
                                '<ul>' +
                                '<li>' + result.images + ' images</li>' +
                                '<li>' + result.videos + ' videos/docs</li>' +
                                '</ul>';
                            
                            if (result.errors > 0) {
                                html += '<p style="color: #856404;">⚠️ ' + result.errors + ' files failed to upload</p>';
                            }
                            
                            html += '<p>You can now use the V2 generator!</p>';
                            status.innerHTML = html;
                            
                            // Clear the file list
                            allFiles = [];
                            fileCount.textContent = '';
                            uploadBtn.style.display = 'none';
                        } else {
                            throw new Error(result.error || 'Upload failed');
                        }
                    } catch (error) {
                        status.className = 'error';
                        status.innerHTML = '<h3>❌ Upload Failed</h3><p>' + error.message + '</p>';
                        console.error('Upload error:', error);
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

// Diagnostic endpoint to check training cache status
router.get('/training-status', (req, res) => {
    const results = {
        timestamp: new Date().toISOString(),
        cacheFilePath: CACHE_FILE,
        __dirname: __dirname,
        cwd: process.cwd()
    };
    
    // Check filesystem cache
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const raw = fs.readFileSync(CACHE_FILE, 'utf8');
            const data = JSON.parse(raw);
            results.filesystemCache = {
                exists: true,
                fileSize: raw.length,
                totalFiles: data.totalFiles,
                uploadedAt: data.uploadedAt,
                sampleFileIds: data.files?.slice(0, 3).map(f => ({ name: f.filename, id: f.fileId?.substring(0, 20) + '...' }))
            };
        } else {
            results.filesystemCache = { exists: false };
        }
    } catch (e) {
        results.filesystemCache = { error: e.message };
    }
    
    // Check in-memory cache
    if (global._trainingCache) {
        results.memoryCache = {
            exists: true,
            totalFiles: global._trainingCache.totalFiles,
            uploadedAt: global._trainingCache.uploadedAt
        };
    } else {
        results.memoryCache = { exists: false };
    }
    
    // Check generator's __dirname
    const generatorDir = path.join(__dirname, 'formats/skeleton-anatomy-v2');
    try {
        const dirFiles = fs.readdirSync(generatorDir);
        results.generatorDir = {
            path: generatorDir,
            files: dirFiles
        };
    } catch (e) {
        results.generatorDir = { path: generatorDir, error: e.message };
    }
    
    res.json(results);
});

module.exports = router;
