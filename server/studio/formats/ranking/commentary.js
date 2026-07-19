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
            // Start slightly in — more of the action than a black/loading first frame
            await execFileAsync(ffmpegPath, [
                '-y', '-ss', '0.35', '-i', clipPath,
                '-t', '3.8',
                '-vf', 'scale=480:-2',
                '-an',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
                out
            ], { timeout: 45000 });
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
                line: label
                    ? ('Watch this — ' + label.toLowerCase() + ' hits different.')
                    : 'Watch closely — this is about to get messy.',
                label: (label || 'WATCH THIS').toUpperCase().slice(0, 22)
            };
        }
        if (role === 'cta') {
            return {
                line: label
                    ? ('Subscribe before ' + label.toLowerCase() + ' if you\'re fast.')
                    : 'Subscribe before the last second if you\'re fast.',
                label: (label || 'NUMBER ONE').toUpperCase().slice(0, 22)
            };
        }
        if (label) {
            return {
                line: 'Hold on — look at ' + label.toLowerCase() + '.',
                label: label.toUpperCase().slice(0, 22)
            };
        }
        return {
            line: 'Pause. Did you catch what just happened?',
            label: ('RANK ' + clipNumber).toUpperCase().slice(0, 22)
        };
    }

    /** Ban vague filler that could fit any clip. */
    _isGenericLine(line) {
        var s = String(line || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
        if (!s) return true;
        var banned = [
            'that was wild', 'so wild', 'bro what', 'no way', 'absolute cinema',
            'I felt that', 'she cooked', 'he folded', 'poor homie', 'that was crazy',
            'that was close', 'insane', 'crazy bro', 'what the heck', 'oh my god',
            'subscribe if you', 'subscribe for more', 'like and subscribe',
            'subscribe before this ends', 'subscribe if you\'re fast',
            'hit subscribe', 'follow for more', 'watch this', 'you need to see this',
            'this is crazy', 'unbelievable', 'no shot', 'I can\'t', 'bro cooked'
        ];
        for (var i = 0; i < banned.length; i++) {
            if (s === banned[i] || s.indexOf(banned[i]) !== -1) return true;
        }
        var words = s.split(' ').filter(Boolean);
        // Very short reactions are almost always generic filler
        if (words.length < 5) return true;
        return false;
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

    _rolePrompt(role, rankingTitle, clipNumber, totalClips, stricter) {
        var shared = `You are a sharp YouTube Shorts ranking narrator. You WATCH the clip and comment on SPECIFIC details only.
Ranking title (context only — never read it aloud): "${rankingTitle}"
On-screen rank: #${clipNumber} of ${totalClips} (countdown; #1 plays last).

Return ONLY valid JSON:
{"line":"<spoken voiceover>","label":"<1-4 word ALL CAPS tag>"}

HARD RULES for "line":
- Must mention at least one CONCRETE detail from THIS footage (object, body part, action, clothing, animal, face, fail, etc.)
- Sound like a comment that would spark replies / ragebait / debate — specific, not filler
- BANNED (never use): "that was wild", "bro what", "no way", "absolute cinema", "that was crazy", "insane", "subscribe if you're fast", "hit subscribe", "watch this", "you need to see this", "I felt that", "she cooked", "he folded"
- No hashtags, no emojis, no reading the ranking title
- label = punchy ALL CAPS tag for THIS moment only`;

        if (stricter) {
            shared += `

STRICT RETRY: your previous line was too generic. Name the exact thing you see (e.g. shoes flying, chair tipping, rope, scream, kid, dog).`;
        }

        if (role === 'hook') {
            return shared + `

ROLE: COLD-OPEN on the FIRST clip.
4–12 words. Comment on the specific moment like:
- "He'll never trust that harness again."
- "Watch his face the second the chair tips."
Do NOT say ranking / these are / the title.`;
        }

        if (role === 'cta') {
            return shared + `

ROLE: FINAL #1 clip — subscribe CTA locked to THIS action.
6–14 words. Must say subscribe/follow AND name a visible detail from the clip as the timer/joke.
Good shape: "Subscribe before [specific thing in frame] if you're fast."
BAD (too generic — never): "Subscribe if you're fast enough", "Subscribe before this ends", "Subscribe for more".
The CTA must only make sense for THIS exact video.`;
        }

        return shared + `

ROLE: MID-RANK reaction for #${clipNumber}.
4–12 words. Ask a spicy question OR call out a specific detail people will argue about.
Good shape: "Where did her shoes even go?" / "Why did he grab the rope like that?"
Do NOT say subscribe. Do NOT use vague hype with no detail.`;
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

            var parsed = await this._visionCommentOnce(
                base64Video, mimeType, role, rankingTitle, clipNumber, totalClips, false, fallback
            );
            if (this._isGenericLine(parsed.line)) {
                console.warn('  Generic line rejected, retrying:', parsed.line);
                parsed = await this._visionCommentOnce(
                    base64Video, mimeType, role, rankingTitle, clipNumber, totalClips, true, fallback
                );
            }
            if (this._isGenericLine(parsed.line)) {
                // Last resort: force a detail-shaped line from label / title words
                parsed.line = fallback.line;
            }
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

    async _visionCommentOnce(base64Video, mimeType, role, rankingTitle, clipNumber, totalClips, stricter, fallback) {
        const prompt = this._rolePrompt(role, rankingTitle, clipNumber, totalClips, stricter);
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
        return this._parseLineAndLabel(text, fallback.line, fallback.label);
    }

    async _ttsLineWithTimings(line, label) {
        const audioPath = await this._ttsLine(line, label);
        let wordTimings = await this._alignWords(audioPath, line);
        if (!wordTimings || !wordTimings.length) {
            var dur = await this._probeAudioDuration(audioPath);
            if (!dur) dur = this._wavDurationSeconds(audioPath);
            if (!dur) {
                dur = Math.min(4, Math.max(1.0, String(line || '').split(/\s+/).length * 0.26));
            }
            wordTimings = this._charWeightedTimings(line, dur);
        }
        // Lead captions slightly so on-screen words never feel late vs speech
        wordTimings = this._nudgeTimingsEarly(wordTimings, 0.08);
        return { audioPath, wordTimings };
    }

    _nudgeTimingsEarly(timings, leadSeconds) {
        var lead = Math.max(0, leadSeconds || 0);
        if (!timings || !timings.length || !lead) return timings || [];
        return timings.map(function(t, i) {
            var start = Math.max(0, (t.start || 0) - lead);
            // Keep order: don't overlap previous word's start
            if (i > 0) {
                var prev = timings[i - 1];
                var prevStart = Math.max(0, (prev.start || 0) - lead);
                if (start < prevStart) start = prevStart;
            }
            var end = Math.max(start + 0.05, (t.end || 0) - lead * 0.25);
            return { word: t.word, start: start, end: end };
        });
    }

    async _probeAudioDuration(audioPath) {
        if (!audioPath || !fs.existsSync(audioPath)) return 0;
        try {
            var ffprobePath = process.env.FFPROBE_PATH || require('ffprobe-static').path;
            var r = await execFileAsync(ffprobePath, [
                '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath
            ], { timeout: 10000 });
            return parseFloat(String(r.stdout || '').trim()) || 0;
        } catch (e) {
            return 0;
        }
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

            var timings = words.map(function(w) {
                return {
                    word: String(w.word || '').trim(),
                    start: typeof w.start === 'number' ? w.start : 0,
                    end: typeof w.end === 'number' ? w.end : 0
                };
            }).filter(function(w) { return w.word; });

            // Prefer script word tokens when Whisper splits oddly; keep Whisper times
            var scriptWords = String(line || '').replace(/\n/g, ' ').trim().split(/\s+/).filter(Boolean);
            if (timings.length && scriptWords.length && Math.abs(timings.length - scriptWords.length) <= 2) {
                var n = Math.min(timings.length, scriptWords.length);
                for (var si = 0; si < n; si++) {
                    timings[si].word = scriptWords[si];
                }
                timings = timings.slice(0, scriptWords.length);
                // If Whisper missed trailing words, estimate from last end
                if (timings.length < scriptWords.length && timings.length) {
                    var last = timings[timings.length - 1];
                    var remain = scriptWords.length - timings.length;
                    var slice = Math.max(0.12, ((last.end || last.start) + 0.4 - (last.end || last.start)) / remain);
                    var tCursor = last.end || last.start || 0;
                    for (var ri = timings.length; ri < scriptWords.length; ri++) {
                        timings.push({ word: scriptWords[ri], start: tCursor, end: tCursor + slice });
                        tCursor += slice;
                    }
                }
            }

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
