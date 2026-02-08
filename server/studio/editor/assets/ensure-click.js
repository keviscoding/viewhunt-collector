/**
 * Generates a click.mp3 sound effect using FFmpeg if it doesn't exist.
 * Called once on first use.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const clickPath = path.join(__dirname, 'click.mp3');

function ensureClickSound() {
    if (fs.existsSync(clickPath)) return clickPath;

    console.log('🔊 Generating click sound effect...');
    try {
        execFileSync('ffmpeg', [
            '-f', 'lavfi',
            '-i', 'sine=frequency=800:duration=0.05',
            '-af', 'afade=t=out:st=0.02:d=0.03,volume=2',
            '-y', clickPath
        ]);
        console.log('✅ click.mp3 generated');
    } catch (err) {
        console.warn('⚠️ Could not generate click sound:', err.message);
        return null;
    }
    return clickPath;
}

module.exports = ensureClickSound;
