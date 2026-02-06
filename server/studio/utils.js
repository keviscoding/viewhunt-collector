/**
 * Utility functions for Content Studio
 */

/**
 * Parse script into scenes
 * Handles different script formats and separators
 */
function parseScriptIntoScenes(script) {
    // Try splitting by double newlines first
    let scenes = script.split('\n\n').filter(s => s.trim().length > 0);
    
    // If that doesn't work, try single newlines
    if (scenes.length < 2) {
        scenes = script.split('\n').filter(s => s.trim().length > 0);
    }
    
    // If still not enough scenes, split by sentences
    if (scenes.length < 2) {
        scenes = script.match(/[^.!?]+[.!?]+/g) || [script];
    }
    
    return scenes.map(s => s.trim());
}

/**
 * Estimate video duration from script
 * Assumes ~150 words per minute speaking rate
 */
function estimateDuration(script) {
    const words = script.split(/\s+/).length;
    const wordsPerMinute = 150;
    const durationMinutes = words / wordsPerMinute;
    return Math.ceil(durationMinutes * 60); // Return seconds
}

/**
 * Validate API keys are present
 */
function validateApiKeys() {
    const required = ['OPENAI_API_KEY', 'REPLICATE_API_KEY'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
        throw new Error(`Missing required API keys: ${missing.join(', ')}`);
    }
    
    return true;
}

/**
 * Format file size for display
 */
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * Generate unique filename
 */
function generateFilename(prefix, extension) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    return `${prefix}-${timestamp}-${random}.${extension}`;
}

/**
 * Sanitize topic for use in prompts
 */
function sanitizeTopic(topic) {
    return topic
        .trim()
        .replace(/[^\w\s-]/g, '') // Remove special chars
        .substring(0, 100); // Limit length
}

/**
 * Log generation metrics
 */
function logGenerationMetrics(format, duration, success) {
    console.log(`[METRICS] Format: ${format}, Duration: ${duration}ms, Success: ${success}`);
    // TODO: Store in database for analytics
}

module.exports = {
    parseScriptIntoScenes,
    estimateDuration,
    validateApiKeys,
    formatFileSize,
    generateFilename,
    sanitizeTopic,
    logGenerationMetrics
};
