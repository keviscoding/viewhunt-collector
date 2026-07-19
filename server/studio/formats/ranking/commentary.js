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

    /**
     * Generate cold-open hook (clip 0), mid reactions, and final subscribe CTA.
     * Each result: { clipIndex, line, label, audioPath, wordTimings }
     * Mutates clips[i].label when Gemini returns a short rank label.
     */
    async generateCommentary(clips, rankingTitle, voiceName) {
        console.log(`🎙️ Ranking commentary: generating for ${clips.length} clips, title: "${rankingTitle}", voice: ${voiceName || 'Kore'}`);
        this.voiceName = voiceName || 'Kore';
        await this._ensureAi();

        const commentaryLines = [];
        for (let i = 0; i < clips.length; i++) {
            const clip = clips[i];
            const role = i === 0 ? 'hook' : (i === clips.length - 1 ? 'cta' : 'react');
            const rankNumber = clip.number != null ? clip.number : (clips.length - i);
            try {
                await this._progress(
                    role === 'hook' ? 'Writing cold-open hook…'
                        : role === 'cta' ? 'Writing subscribe CTA for #1…'
                            : ('Watching clip ' + (i + 1) + ' of ' + clips.length + '…')
                );
                const parsed = await this._analyzeClipAndComment(
                    clip.path, rankingTitle, rankNumber, clips.length, clip, role
                );
                if (parsed.label && clips[i]) clips[i].label = parsed.label;
                commentaryLines.push({ clipIndex: i, line: parsed.line, label: parsed.label || '' });
                console.log(`  Clip ${i + 1} [${role}]: "${parsed.line}"` + (parsed.label ? ` [${parsed.label}]` : ''));
            } catch (err) {
                console.warn(`  Clip ${i + 1}: commentary failed — ${err.message}`);
                var fb = this._fallbackForRole(clip, rankNumber, clips.length, role);
                if (fb.label && clips[i] && !clips[i].label) clips[i].label = fb.label;
                commentaryLines.push({ clipIndex: i, line: fb.line, label: fb.label || '' });
                console.log(`  Clip ${i + 1} fallback [${role}]: "${fb.line}"`);
            }
        }

        await this._progress('Generating voiceover audio…');
        const ttsPromises = commentaryLines.map((c) => {
            if (!c.line) {
                return Promise.resolve({
                    clipIndex: c.clipIndex, line: null, label: c.label || '',
                    audioPath: null, wordTimings: []
                });
            }
            return this._ttsLineWithTimings(c.line, 'clip-' + (c.clipIndex + 1))
                .then(({ audioPath, wordTimings }) => ({
                    clipIndex: c.clipIndex, line: c.line, label: c.label || '',
                    audioPath, wordTimings
                }))
                .catch(err => {
                    console.warn(`  Clip ${c.clipIndex + 1} TTS failed: ${err.message}`);
                    return {
                        clipIndex: c.clipIndex,
                        line: c.line,
                        label: c.label || '',
                        audioPath: null,
                        wordTimings: this._charWeightedTimings(c.line, 2.0)
                    };
                });
        });

        const results = await Promise.all(ttsPromises);

        const successCount = results.filter(r => r.audioPath).length;
        console.log(`🎙️ Commentary complete: ${successCount}/${clips.length} clips have audio` +
            (this.lastTtsProvider ? ` (tts=${this.lastTtsProvider})` : '') +
            (this.lastTtsError ? ` lastError=${this.lastTtsError}` : ''));
        results.ttsProvider = this.lastTtsProvider;
        results.ttsError = this.lastTtsError;
        return results;
    }

    _fallbackForRole(clip, clipNumber, totalClips, role) {
        var label = (clip && clip.label) ? String(clip.label).trim() : '';
        if (role === 'hook') {
            return {
                line: 'Watch this — you need to see what happens.',
                label: (label || 'WATCH THIS').toUpperCase().slice(0, 22)
            };
        }
        if (role === 'cta') {
            return {
                line: 'Subscribe before this ends if you\'re fast.',
                label: (label || 'NUMBER ONE').toUpperCase().slice(0, 22)
            };
        }
        var reactions = [
            { line: 'bro what', label: 'BRO WHAT' },
            { line: 'that was wild', label: 'WILD' },
            { line: 'poor homie', label: 'PAIN' },
            { line: 'no way', label: 'NO WAY' },
            { line: 'he folded', label: 'FOLDED' },
            { line: 'absolute cinema', label: 'CINEMA' }
        ];
        var pick = reactions[(Math.max(1, clipNumber) - 1) % reactions.length];
        if (/fail|fall|crash/i.test(label)) return { line: 'that hurt to watch', label: (label || 'OUCH').toUpperCase() };
        return { line: pick.line, label: (label || pick.label).toUpperCase().slice(0, 22) };
    }

    _parseLineAndLabel(raw, fallbackLine, fallbackLabel) {
        var text = String(raw || '').replace(/^["']|["']$/g, '').trim();
        if (!text) return { line: fallbackLine, label: fallbackLabel };

        // Strip markdown fences
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

        try {
            var jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                var obj = JSON.parse(jsonMatch[0]);
                var line = String(obj.line || obj.commentary || obj.voice || '').trim();
                var lab = String(obj.label || obj.rankLabel || obj.title || '').trim();
                if (line) {
                    return {
                        line: line.replace(/^["']|["']$/g, '').trim(),
                        label: this._normalizeRankLabel(lab || fallbackLabel)
                    };
                }
            }
        } catch (e) { /* fall through */ }

        // "line || LABEL" or "line | LABEL"
        var pipe = text.split(/\s*\|\|\s*|\s*\|\s*/);
        if (pipe.length >= 2) {
            return {
                line: pipe[0].replace(/^["']|["']$/g, '').trim(),
                label: this._normalizeRankLabel(pipe.slice(1).join(' ') || fallbackLabel)
            };
        }

        return { line: text, label: this._normalizeRankLabel(fallbackLabel) };
    }

    _normalizeRankLabel(label) {
        var s = String(label || '')
            .replace(/["']/g, '')
            .replace(/[^a-zA-Z0-9 !?]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toUpperCase();
        if (!s) return 'MOMENT';
        var words = s.split(' ').filter(Boolean).slice(0, 4);
        return words.join(' ').slice(0, 24);
    }

    _rolePrompt(role, rankingTitle, clipNumber, totalClips) {
        var shared = `You are a viral YouTube Shorts ranking narrator (think high-retention countdown compilations).
Ranking title (context only — do NOT read it aloud): "${rankingTitle}"
This clip's rank number on screen: #${clipNumber} of ${totalClips} (countdown; #1 is last).

Return ONLY valid JSON, no markdown:
{"line":"<spoken voiceover>","label":"<1-4 word ALL CAPS rank tag>"}

label examples: NEVER AGAIN, DOUBLE CHECK, GOT LUCKY, BY A THREAD, AARRRGGGGHHHH
Keep labels punchy — not full sentences.`;

        if (role === 'hook') {
            return shared + `

ROLE: COLD-OPEN HOOK on the FIRST clip shown (highest number).
Write "line" as a comment on WHAT IS HAPPENING in this clip — intrigue / reaction, not a title read.
Good vibes (vary each time — invent a fresh line for THIS footage):
- "He'll never do this again."
- "Watch this guy try to explain himself."
- "Bro is about to regret everything."
Rules:
- 4–12 words, casual, spoken aloud
- Do NOT say "ranking", "these are", or repeat the title
- Do NOT use hashtags or emojis
- label = short tag for this moment`;
        }

        if (role === 'cta') {
            return shared + `

ROLE: FINAL CLIP (#1) — subscribe CTA tied to the ON-SCREEN action.
"line" must urge subscribe/follow using whatever is about to happen in THIS clip as the joke/threat/payoff.
Good vibes (ALWAYS invent a new one for THIS footage — never reuse a stock phrase):
- "Subscribe before he cuts the rope if you're fast."
- "Hit subscribe before she drops it."
- "Subscribe before this goes wrong."
Rules:
- 6–14 words, casual, urgent, funny
- Must mention subscribe/follow AND reference something visible in the clip
- Do NOT use hashtags or emojis
- label = short tag for the #1 moment`;
        }

        return shared + `

ROLE: MID-RANK reaction for #${clipNumber}.
"line" = one punchy live reaction (3–10 words).
Style: "bro folded", "where did her shoes go?", "why did he try to grab her?", "that was close"
Rules:
- React — don't narrate literally beat-by-beat
- Match the clip energy
- Do NOT use hashtags or emojis
- Do NOT say subscribe (save that for #1)
- label = short tag for this moment`;
    }

    async _analyzeClipAndComment(clipPath, rankingTitle, clipNumber, totalClips, clip, role) {
        role = role || 'react';
        var fallback = this._fallbackForRole(clip, clipNumber, totalClips, role);
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
            const prompt = this._rolePrompt(role, rankingTitle, clipNumber, totalClips);

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
            var parsed = this._parseLineAndLabel(text, fallback.line, fallback.label);
            // Prefer existing user label if they typed one
            if (clip && clip.label && String(clip.label).trim()) {
                parsed.label = this._normalizeRankLabel(clip.label);
            }
            return parsed;
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
