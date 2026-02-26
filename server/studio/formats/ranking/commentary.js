/**
 * Ranking Commentary Generator
 * Uses Gemini to watch trimmed clips and generate short one-liner commentary.
 * Also generates TTS audio for each line using Gemini TTS.
 * 
 * Output per clip:
 *   - Clip 1 (first): intro line reading out the ranking title
 *   - Clips 2+: short 3-10 word reaction/commentary
 * 
 * Style: super fast, upbeat, friendly, casual
 */
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

class RankingCommentary {
    constructor() {
        this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        this.audioDir = path.join(__dirname, '../../../public/studio/generated/audio');
        if (!fs.existsSync(this.audioDir)) fs.mkdirSync(this.audioDir, { recursive: true });
    }

    /**
     * Generate commentary lines for all clips.
     * @param {Array} clips - Array of { path, number, label } (already trimmed)
     * @param {string} rankingTitle - The ranking title (e.g. "Ranking the Funniest Trampoline Moments")
     * @returns {Array} Array of { clipIndex, line, audioPath } — audioPath is the TTS wav file
     */
    async generateCommentary(clips, rankingTitle) {
        console.log(`🎙️ Ranking commentary: generating for ${clips.length} clips, title: "${rankingTitle}"`);

        // Step 1: Generate intro line for clip 1
        const introLine = await this._generateIntroLine(rankingTitle);
        console.log(`  Intro: "${introLine}"`);

        // Step 2: Analyze clips 2+ and generate one-liners
        const commentaryLines = [];
        for (let i = 1; i < clips.length; i++) {
            const clip = clips[i];
            try {
                const line = await this._analyzeClipAndComment(clip.path, rankingTitle, i + 1, clips.length);
                commentaryLines.push({ clipIndex: i, line });
                console.log(`  Clip ${i + 1}: "${line}"`);
            } catch (err) {
                console.warn(`  Clip ${i + 1}: commentary failed — ${err.message}`);
                commentaryLines.push({ clipIndex: i, line: null });
            }
        }

        // Step 3: TTS all lines (intro + commentary)
        const results = [];

        // Intro TTS
        try {
            const introAudio = await this._ttsLine(introLine, 'intro');
            results.push({ clipIndex: 0, line: introLine, audioPath: introAudio });
        } catch (err) {
            console.warn(`  Intro TTS failed: ${err.message}`);
            results.push({ clipIndex: 0, line: introLine, audioPath: null });
        }

        // Commentary TTS
        for (const c of commentaryLines) {
            if (!c.line) {
                results.push({ clipIndex: c.clipIndex, line: null, audioPath: null });
                continue;
            }
            try {
                const audioPath = await this._ttsLine(c.line, 'clip-' + (c.clipIndex + 1));
                results.push({ clipIndex: c.clipIndex, line: c.line, audioPath });
            } catch (err) {
                console.warn(`  Clip ${c.clipIndex + 1} TTS failed: ${err.message}`);
                results.push({ clipIndex: c.clipIndex, line: c.line, audioPath: null });
            }
        }

        const successCount = results.filter(r => r.audioPath).length;
        console.log(`🎙️ Commentary complete: ${successCount}/${clips.length} clips have audio`);
        return results;
    }

    /**
     * Generate the intro line — reads out the ranking title in an upbeat way.
     */
    async _generateIntroLine(rankingTitle) {
        const prompt = `You are a fast-paced, upbeat YouTube Shorts narrator for ranking/compilation videos.

Generate a single intro line that reads out this ranking title. Keep it natural, energetic, and under 12 words.

Examples of good intro lines:
- "These are the funniest fishing moments."
- "These are the best dad reflex moments."
- "These are the best baby in church moments."
- "These are the funniest jump scares on the internet."

Ranking title: "${rankingTitle}"

Reply with ONLY the intro line, nothing else. No quotes, no explanation.`;

        const response = await this.ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ parts: [{ text: prompt }] }]
        });

        const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!text) throw new Error('No intro line generated');
        // Clean up — remove quotes if Gemini added them
        return text.replace(/^["']|["']$/g, '').trim();
    }

    /**
     * Analyze a single clip video and generate a short one-liner commentary.
     * Sends the video file to Gemini for visual understanding.
     */
    async _analyzeClipAndComment(clipPath, rankingTitle, clipNumber, totalClips) {
        const videoBuffer = fs.readFileSync(clipPath);
        const base64Video = videoBuffer.toString('base64');
        const mimeType = 'video/mp4';

        const prompt = `You are a fast-paced, upbeat YouTube Shorts narrator for ranking/compilation videos.

This is clip #${clipNumber} of ${totalClips} in a ranking video titled: "${rankingTitle}"

Watch this clip and write ONE short commentary line (3-10 words max) that reacts to what happens in the clip. 

Style guide:
- Super casual, like you're reacting live
- Short punchy reactions: "bro folded", "she didn't expect that", "poor homie", "that was close", "he got what he wanted"
- Match the energy of the clip — funny clips get funny reactions, intense clips get hype reactions
- Do NOT describe what happens literally — react to it
- Do NOT use hashtags or emojis

Reply with ONLY the commentary line, nothing else. No quotes, no explanation.`;

        const response = await this.ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{
                parts: [
                    { inlineData: { mimeType, data: base64Video } },
                    { text: prompt }
                ]
            }]
        });

        const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!text) throw new Error('No commentary generated');
        return text.replace(/^["']|["']$/g, '').trim();
    }

    /**
     * Generate TTS audio for a single line using Gemini TTS.
     * Returns the path to the generated WAV file.
     */
    async _ttsLine(line, label) {
        const ttsPrompt = `Read this in a super fast, upbeat, friendly tone, in about 2 seconds:\n\n${line}`;

        const response = await this.ai.models.generateContent({
            model: 'gemini-2.5-flash-preview-tts',
            contents: [{ parts: [{ text: ttsPrompt }] }],
            config: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: 'Kore' }
                    }
                }
            }
        });

        const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!audioData) throw new Error('No audio data from TTS');

        const pcmBuffer = Buffer.from(audioData, 'base64');
        const filename = `ranking-${label}-${Date.now()}.wav`;
        const filepath = path.join(this.audioDir, filename);
        this._writeWav(filepath, pcmBuffer);
        return filepath;
    }

    /**
     * Write raw PCM data as WAV (same format as GeminiTTS)
     */
    _writeWav(filepath, pcmData) {
        const dataSize = pcmData.length;
        const header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataSize, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(1, 22);        // mono
        header.writeUInt32LE(24000, 24);     // 24kHz
        header.writeUInt32LE(24000 * 2, 28); // byte rate
        header.writeUInt16LE(2, 32);         // block align
        header.writeUInt16LE(16, 34);        // 16-bit
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);
        fs.writeFileSync(filepath, Buffer.concat([header, pcmData]));
    }
}

module.exports = RankingCommentary;
