/**
 * Ranking Commentary Generator
 * Uses Gemini to watch trimmed clips and generate short one-liner commentary.
 * Also generates TTS audio for each line using Gemini TTS.
 * Word timings: OpenAI Whisper when OPENAI_API_KEY is set, else character-weighted.
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
const OpenAI = require('openai');

class RankingCommentary {
    constructor() {
        this.ai = process.env.GEMINI_API_KEY
            ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
            : null;
        this.audioDir = path.join(__dirname, '../../../public/studio/generated/audio');
        if (!fs.existsSync(this.audioDir)) fs.mkdirSync(this.audioDir, { recursive: true });
        this.openai = process.env.OPENAI_API_KEY
            ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
            : null;
        this.lastTtsProvider = null;
        this.lastTtsError = null;
    }

    /**
     * Generate commentary lines for all clips.
     * @returns {Array} Array of { clipIndex, line, audioPath, wordTimings }
     */
    async generateCommentary(clips, rankingTitle, voiceName) {
        console.log(`🎙️ Ranking commentary: generating for ${clips.length} clips, title: "${rankingTitle}", voice: ${voiceName || 'Kore'}`);
        this.voiceName = voiceName || 'Kore';

        const introLine = await this._generateIntroLine(rankingTitle);
        console.log(`  Intro: "${introLine}"`);

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

        const ttsPromises = [];

        ttsPromises.push(
            this._ttsLineWithTimings(introLine, 'intro')
                .then(({ audioPath, wordTimings }) => ({
                    clipIndex: 0, line: introLine, audioPath, wordTimings
                }))
                .catch(err => {
                    console.warn(`  Intro TTS failed: ${err.message}`);
                    return {
                        clipIndex: 0,
                        line: introLine,
                        audioPath: null,
                        wordTimings: this._charWeightedTimings(introLine, 2.0)
                    };
                })
        );

        for (const c of commentaryLines) {
            if (!c.line) {
                ttsPromises.push(Promise.resolve({
                    clipIndex: c.clipIndex, line: null, audioPath: null, wordTimings: []
                }));
                continue;
            }
            ttsPromises.push(
                this._ttsLineWithTimings(c.line, 'clip-' + (c.clipIndex + 1))
                    .then(({ audioPath, wordTimings }) => ({
                        clipIndex: c.clipIndex, line: c.line, audioPath, wordTimings
                    }))
                    .catch(err => {
                        console.warn(`  Clip ${c.clipIndex + 1} TTS failed: ${err.message}`);
                        return {
                            clipIndex: c.clipIndex,
                            line: c.line,
                            audioPath: null,
                            wordTimings: this._charWeightedTimings(c.line, 2.0)
                        };
                    })
            );
        }

        const results = await Promise.all(ttsPromises);

        const successCount = results.filter(r => r.audioPath).length;
        console.log(`🎙️ Commentary complete: ${successCount}/${clips.length} clips have audio` +
            (this.lastTtsProvider ? ` (tts=${this.lastTtsProvider})` : '') +
            (this.lastTtsError ? ` lastError=${this.lastTtsError}` : ''));
        results.ttsProvider = this.lastTtsProvider;
        results.ttsError = this.lastTtsError;
        return results;
    }

    async _generateIntroLine(rankingTitle) {
        if (!this.ai) {
            var t = String(rankingTitle || 'the best moments').trim();
            return t.toLowerCase().startsWith('these are') ? t : ('These are ' + t);
        }

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
        return text.replace(/^["']|["']$/g, '').trim();
    }

    async _analyzeClipAndComment(clipPath, rankingTitle, clipNumber, totalClips) {
        if (!this.ai) throw new Error('GEMINI_API_KEY required for clip commentary');

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

    async _ttsLineWithTimings(line, label) {
        const audioPath = await this._ttsLine(line, label);
        let wordTimings = await this._alignWords(audioPath, line);
        if (!wordTimings || !wordTimings.length) {
            var dur = this._wavDurationSeconds(audioPath);
            if (!dur && this.openai && /\.mp3$/i.test(audioPath)) {
                // Whisper path already failed; estimate ~2s for short lines
                dur = Math.min(4, Math.max(1.2, String(line || '').split(/\s+/).length * 0.28));
            }
            wordTimings = this._charWeightedTimings(line, dur || 2.0);
        }
        return { audioPath, wordTimings };
    }

    async _ttsLine(line, label) {
        var geminiErr = null;
        if (this.ai) {
            try {
                const filepath = await this._ttsGemini(line, label);
                this.lastTtsProvider = 'gemini';
                return filepath;
            } catch (err) {
                geminiErr = err;
                console.warn(`  Gemini TTS failed (${label}): ${err.message}`);
                this.lastTtsError = err.message;
            }
        } else {
            geminiErr = new Error('GEMINI_API_KEY missing');
            this.lastTtsError = geminiErr.message;
        }

        if (this.openai) {
            try {
                const filepath = await this._ttsOpenAI(line, label);
                this.lastTtsProvider = 'openai';
                console.log(`  ✓ OpenAI TTS fallback (${label})`);
                return filepath;
            } catch (err) {
                this.lastTtsError = (geminiErr ? geminiErr.message + '; ' : '') + err.message;
                throw new Error('TTS failed (Gemini + OpenAI): ' + this.lastTtsError);
            }
        }

        throw new Error('TTS failed: ' + (geminiErr && geminiErr.message) +
            ' — set OPENAI_API_KEY for fallback, or enable Gemini billing for gemini-2.5-flash-preview-tts');
    }

    async _ttsGemini(line, label) {
        const ttsPrompt = `Read this in a super fast, upbeat, friendly tone, in about 2 seconds:\n\n${line}`;

        const response = await this.ai.models.generateContent({
            model: 'gemini-2.5-flash-preview-tts',
            contents: [{ parts: [{ text: ttsPrompt }] }],
            config: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: this.voiceName || 'Kore' }
                    }
                }
            }
        });

        const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!audioData) throw new Error('No audio data from Gemini TTS');

        const pcmBuffer = Buffer.from(audioData, 'base64');
        const filename = `ranking-${label}-${Date.now()}.wav`;
        const filepath = path.join(this.audioDir, filename);
        this._writeWav(filepath, pcmBuffer);
        return filepath;
    }

    /** Map Gemini voice picker names to OpenAI TTS voices. */
    _openaiVoice() {
        var map = {
            Kore: 'nova', Puck: 'onyx', Charon: 'echo', Fenrir: 'fable',
            Aoede: 'shimmer', Leda: 'nova', Orus: 'onyx', Zephyr: 'alloy'
        };
        return map[this.voiceName] || 'nova';
    }

    async _ttsOpenAI(line, label) {
        const speech = await this.openai.audio.speech.create({
            model: 'tts-1-hd',
            voice: this._openaiVoice(),
            input: line,
            speed: 1.2,
            response_format: 'mp3'
        });
        const buffer = Buffer.from(await speech.arrayBuffer());
        const filename = `ranking-${label}-${Date.now()}.mp3`;
        const filepath = path.join(this.audioDir, filename);
        fs.writeFileSync(filepath, buffer);
        return filepath;
    }

    /**
     * Align spoken words to the TTS WAV via OpenAI Whisper word timestamps.
     */
    async _alignWords(audioPath, line) {
        if (!this.openai || !audioPath || !fs.existsSync(audioPath)) return null;
        try {
            const transcription = await this.openai.audio.transcriptions.create({
                file: fs.createReadStream(audioPath),
                model: 'whisper-1',
                response_format: 'verbose_json',
                timestamp_granularities: ['word']
            });

            const words = transcription.words || [];
            if (!words.length) return null;

            const timings = words.map(function(w) {
                return {
                    word: String(w.word || '').trim(),
                    start: typeof w.start === 'number' ? w.start : 0,
                    end: typeof w.end === 'number' ? w.end : 0
                };
            }).filter(function(w) { return w.word; });

            if (timings.length) {
                console.log('  ✓ Whisper word timings: ' + timings.length + ' words');
            }
            return timings.length ? timings : null;
        } catch (err) {
            console.warn('  Whisper align failed, using char-weighted:', err.message);
            return null;
        }
    }

    /**
     * Character-weighted word timings across [0, duration].
     */
    _charWeightedTimings(line, durationSeconds) {
        const words = String(line || '').replace(/\n/g, ' ').trim().split(/\s+/).filter(Boolean);
        if (!words.length) return [];
        const dur = Math.max(0.4, durationSeconds || 2);
        const weights = words.map(function(w) { return Math.max(1, w.replace(/[^a-zA-Z0-9]/g, '').length || 1); });
        const total = weights.reduce(function(a, b) { return a + b; }, 0);
        let t = 0;
        const out = [];
        for (let i = 0; i < words.length; i++) {
            const slice = (weights[i] / total) * dur;
            out.push({ word: words[i], start: t, end: t + slice });
            t += slice;
        }
        return out;
    }

    _wavDurationSeconds(filepath) {
        try {
            const buf = fs.readFileSync(filepath);
            if (buf.length < 44) return 0;
            const byteRate = buf.readUInt32LE(28);
            const dataSize = buf.readUInt32LE(40);
            if (!byteRate) return 0;
            return dataSize / byteRate;
        } catch (e) {
            return 0;
        }
    }

    _writeWav(filepath, pcmData) {
        const dataSize = pcmData.length;
        const header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataSize, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(1, 22);
        header.writeUInt32LE(24000, 24);
        header.writeUInt32LE(24000 * 2, 28);
        header.writeUInt16LE(2, 32);
        header.writeUInt16LE(16, 34);
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);
        fs.writeFileSync(filepath, Buffer.concat([header, pcmData]));
    }
}

module.exports = RankingCommentary;
