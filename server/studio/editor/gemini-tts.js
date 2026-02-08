/**
 * Gemini TTS — Generates voiceover audio from script using Gemini 2.5 Flash TTS
 * Returns a WAV file path with the narration
 */
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

class GeminiTTS {
    constructor() {
        this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        this.outputDir = path.join(__dirname, '../../public/studio/generated/audio');
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    /**
     * Generate voiceover audio from script
     * @param {string} script - The narration text
     * @param {string} voiceName - Gemini voice name (default: Charon — informative)
     * @returns {string} Path to the generated WAV file
     */
    async generateVoiceover(script, voiceName = 'Charon') {
        console.log(`🎙️ Gemini TTS: Generating voiceover with voice "${voiceName}"...`);

        const ttsPrompt = `Read in a faster pace, engaging and humorous way:

${script}`;

        try {
            const response = await this.ai.models.generateContent({
                model: 'gemini-2.5-flash-preview-tts',
                contents: [{ parts: [{ text: ttsPrompt }] }],
                config: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName }
                        }
                    }
                }
            });

            const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (!audioData) throw new Error('No audio data in Gemini TTS response');

            const pcmBuffer = Buffer.from(audioData, 'base64');

            // Write as WAV (PCM s16le, 24000Hz, mono)
            const filename = `voiceover-${Date.now()}.wav`;
            const filepath = path.join(this.outputDir, filename);
            this.writeWav(filepath, pcmBuffer, 1, 24000, 2);

            console.log(`✅ Voiceover generated: ${filename} (${(pcmBuffer.length / 1024).toFixed(0)}KB PCM)`);
            return filepath;

        } catch (error) {
            console.error('Gemini TTS error:', error.message);
            throw new Error('Failed to generate voiceover: ' + error.message);
        }
    }

    /**
     * Write raw PCM data as a WAV file
     */
    writeWav(filepath, pcmData, channels = 1, sampleRate = 24000, sampleWidth = 2) {
        const dataSize = pcmData.length;
        const header = Buffer.alloc(44);

        // RIFF header
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataSize, 4);
        header.write('WAVE', 8);

        // fmt chunk
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);           // chunk size
        header.writeUInt16LE(1, 20);            // PCM format
        header.writeUInt16LE(channels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(sampleRate * channels * sampleWidth, 28); // byte rate
        header.writeUInt16LE(channels * sampleWidth, 32);              // block align
        header.writeUInt16LE(sampleWidth * 8, 34);                     // bits per sample

        // data chunk
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);

        fs.writeFileSync(filepath, Buffer.concat([header, pcmData]));
    }
}

module.exports = GeminiTTS;
