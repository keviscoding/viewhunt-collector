/**
 * Ranking Commentary Generator
 * Uses Gemini to watch short clip samples and generate one-liner commentary.
 * TTS: OpenAI first when available (fast/reliable), else Gemini TTS.
 * Word timings: OpenAI Whisper (short timeout) or character-weighted.
 *
 * NOTE: @google/genai is ESM-only — must use dynamic import(), never require().
 * require() fails on Fly with "ES Module ... not supported" and leaves this.ai null.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const ffmpegPath = process.env.FFMPEG_PATH || require('ffmpeg-static');

let GoogleGenAI = null;
let googleGenAiLoadError = null;
let googleGenAiPromise = null;

async function loadGoogleGenAI() {
    if (GoogleGenAI) return GoogleGenAI;
    if (googleGenAiLoadError) return null;
    if (googleGenAiPromise) return googleGenAiPromise;
    googleGenAiPromise = import('@google/genai')
        .then(function(mod) {
            GoogleGenAI = mod.GoogleGenAI || (mod.default && mod.default.GoogleGenAI) || null;
            if (!GoogleGenAI) {
                googleGenAiLoadError = new Error('@google/genai loaded but GoogleGenAI export missing');
                return null;
            }
            console.log('@google/genai loaded via dynamic import');
            return GoogleGenAI;
        })
        .catch(function(err) {
            googleGenAiLoadError = err;
            console.warn('@google/genai unavailable:', err.message);
            return null;
        });
    return googleGenAiPromise;
}

function loadOpenAI() {
    try {
        return require('openai');
    } catch (err) {
        console.warn('openai unavailable:', err.message);
        return null;
    }
}

class RankingCommentary {
    constructor() {
        this.ai = null;
        this._aiInit = null;
        this.audioDir = (process.env.JOB_ID || process.env.JOB_TYPE === 'ranking_assemble')
            ? path.join('/tmp', 'ranking-audio')
            : path.join(__dirname, '../../../public/studio/generated/audio');
        if (!fs.existsSync(this.audioDir)) fs.mkdirSync(this.audioDir, { recursive: true });
        var OpenAI = loadOpenAI();
        this.openai = (process.env.OPENAI_API_KEY && OpenAI)
            ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
            : null;
        this.lastTtsProvider = null;
        this.lastTtsError = null;
        this.onProgress = null;
    }

    async _ensureAi() {
        if (this.ai) return this.ai;
        if (!process.env.GEMINI_API_KEY) return null;
        if (!this._aiInit) {
            this._aiInit = loadGoogleGenAI().then(function(GenAI) {
                if (!GenAI) return null;
                return new GenAI({ apiKey: process.env.GEMINI_API_KEY });
            }.bind(this));
        }
        this.ai = await this._aiInit;
        if (!this.ai && googleGenAiLoadError) {
            console.warn('GEMINI_API_KEY set but SDK failed to load — OpenAI/fallback path only');
        }
        return this.ai;
    }

    async _progress(msg) {
        console.log('🎙️', msg);
        if (typeof this.onProgress === 'function') {
            try { await this.onProgress(msg); } catch (e) {}
        }
    }

    async _makeVisionSample(clipPath) {
        var out = path.join(this.audioDir, 'vision-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.mp4');
        try {
            await execFileAsync(ffmpegPath, [
                '-y', '-ss', '0', '-i', clipPath,
                '-t', '2.5',
                '-vf', 'scale=360:-2',
                '-an',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32',
                out
            ], { timeout: 30000 });
            if (fs.existsSync(out) && fs.statSync(out).size > 500) return out;
        } catch (err) {
            console.warn('Vision sample failed, using original:', err.message);
        }
        return clipPath;
    }

    async generateCommentary(clips, rankingTitle, voiceName) {
        console.log(`🎙️ Ranking commentary: generating for ${clips.length} clips, title: "${rankingTitle}", voice: ${voiceName || 'Kore'}`);
        this.voiceName = voiceName || 'Kore';
        await this._ensureAi();

        await this._progress('Writing intro line…');
        const introLine = await this._generateIntroLine(rankingTitle);
        console.log(`  Intro: "${introLine}"`);

        const commentaryLines = [];
        for (let i = 1; i < clips.length; i++) {
            const clip = clips[i];
            try {
                await this._progress('Watching clip ' + (i + 1) + ' of ' + clips.length + ' for commentary…');
                const line = await this._analyzeClipAndComment(clip.path, rankingTitle, i + 1, clips.length, clip);
                commentaryLines.push({ clipIndex: i, line });
                console.log(`  Clip ${i + 1}: "${line}"`);
            } catch (err) {
                console.warn(`  Clip ${i + 1}: commentary failed — ${err.message}`);
                var fallback = this._fallbackReaction(clip, i + 1, clips.length);
                commentaryLines.push({ clipIndex: i, line: fallback });
                console.log(`  Clip ${i + 1} fallback: "${fallback}"`);
            }
        }

        await this._progress('Generating voiceover audio…');
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

    _fallbackReaction(clip, clipNumber, totalClips) {
        var label = (clip && (clip.label || clip.filename)) ? String(clip.label || clip.filename) : '';
        var reactions = [
            'bro what',
            'she cooked',
            'that was wild',
            'poor homie',
            'no way',
            'he folded',
            'absolute cinema',
            'I felt that'
        ];
        if (clipNumber === totalClips) return 'number one for a reason';
        if (/fail|fall|crash/i.test(label)) return 'that hurt to watch';
        return reactions[(clipNumber - 1) % reactions.length];
    }

    async _generateIntroLine(rankingTitle) {
        await this._ensureAi();
        var t = String(rankingTitle || 'the best moments').trim();
        var fallback = t.toLowerCase().startsWith('these are') ? t : ('These are ' + t);

        if (!this.ai) return fallback;

        const prompt = `You are a fast-paced, upbeat YouTube Shorts narrator for ranking/compilation videos.

Generate a single intro line that reads out this ranking title. Keep it natural, energetic, and under 12 words.

Examples of good intro lines:
- "These are the funniest fishing moments."
- "These are the best dad reflex moments."
- "These are the best baby in church moments."
- "These are the funniest jump scares on the internet."

Ranking title: "${rankingTitle}"

Reply with ONLY the intro line, nothing else. No quotes, no explanation.`;

        try {
            const response = await this.ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [{ parts: [{ text: prompt }] }]
            });
            const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (!text) return fallback;
            return text.replace(/^["']|["']$/g, '').trim();
        } catch (err) {
            console.warn('Intro Gemini failed, using fallback:', err.message);
            return fallback;
        }
    }

    async _analyzeClipAndComment(clipPath, rankingTitle, clipNumber, totalClips, clip) {
        await this._ensureAi();
        if (!this.ai) {
            throw new Error('Gemini SDK unavailable for clip commentary');
        }

        var samplePath = await this._makeVisionSample(clipPath);
        var cleanupSample = samplePath !== clipPath;
        try {
            const videoBuffer = fs.readFileSync(samplePath);
            if (videoBuffer.length > 4 * 1024 * 1024) {
                throw new Error('Vision sample still too large');
            }
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

            const response = await Promise.race([
                this.ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: [{
                        parts: [
                            { inlineData: { mimeType, data: base64Video } },
                            { text: prompt }
                        ]
                    }]
                }),
                new Promise(function(_, reject) {
                    setTimeout(function() { reject(new Error('Gemini vision timeout (45s)')); }, 45000);
                })
            ]);

            const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (!text) throw new Error('No commentary generated');
            return text.replace(/^["']|["']$/g, '').trim();
        } finally {
            if (cleanupSample) {
                try { fs.unlinkSync(samplePath); } catch (e) {}
            }
        }
    }

    async _ttsLineWithTimings(line, label) {
        const audioPath = await this._ttsLine(line, label);
        let wordTimings = await this._alignWords(audioPath, line);
        if (!wordTimings || !wordTimings.length) {
            var dur = this._wavDurationSeconds(audioPath);
            if (!dur && this.openai && /\.mp3$/i.test(audioPath)) {
                dur = Math.min(4, Math.max(1.2, String(line || '').split(/\s+/).length * 0.28));
            }
            wordTimings = this._charWeightedTimings(line, dur || 2.0);
        }
        return { audioPath, wordTimings };
    }

    async _ttsLine(line, label) {
        await this._ensureAi();
        var preferOpenAI = !!this.openai && process.env.RANKING_TTS_PROVIDER !== 'gemini';

        if (preferOpenAI) {
            try {
                const filepath = await this._ttsOpenAI(line, label);
                this.lastTtsProvider = 'openai';
                return filepath;
            } catch (err) {
                console.warn(`  OpenAI TTS failed (${label}): ${err.message}`);
                this.lastTtsError = err.message;
            }
        }

        if (this.ai) {
            try {
                const filepath = await this._ttsGemini(line, label);
                this.lastTtsProvider = 'gemini';
                return filepath;
            } catch (err) {
                console.warn(`  Gemini TTS failed (${label}): ${err.message}`);
                this.lastTtsError = (this.lastTtsError ? this.lastTtsError + '; ' : '') + err.message;
            }
        }

        if (!preferOpenAI && this.openai) {
            try {
                const filepath = await this._ttsOpenAI(line, label);
                this.lastTtsProvider = 'openai';
                return filepath;
            } catch (err) {
                this.lastTtsError = (this.lastTtsError ? this.lastTtsError + '; ' : '') + err.message;
                throw new Error('TTS failed: ' + this.lastTtsError);
            }
        }

        throw new Error('TTS failed: ' + (this.lastTtsError || 'no provider') +
            ' — set OPENAI_API_KEY or fix Gemini TTS billing');
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

    async _alignWords(audioPath, line) {
        if (!this.openai || !audioPath || !fs.existsSync(audioPath)) return null;
        if (process.env.RANKING_SKIP_WHISPER === '1' || process.env.RANKING_SKIP_WHISPER === 'true') {
            return null;
        }
        try {
            const transcription = await Promise.race([
                this.openai.audio.transcriptions.create({
                    file: fs.createReadStream(audioPath),
                    model: 'whisper-1',
                    response_format: 'verbose_json',
                    timestamp_granularities: ['word']
                }),
                new Promise(function(_, reject) {
                    setTimeout(function() { reject(new Error('Whisper timeout')); }, 12000);
                })
            ]);

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
            console.warn('  Whisper align skipped:', err.message);
            return null;
        }
    }

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
