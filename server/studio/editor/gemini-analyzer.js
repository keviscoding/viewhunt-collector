/**
 * Analyzer — Voiceover-driven approach:
 *   1. Gemini picks 4-5 hook clips (visual analysis)
 *   2. Body segments come from Claude's scriptLine mapping
 *   3. OpenAI Whisper transcribes voiceover word-by-word (~50ms accuracy)
 *      → We match words back to script lines for exact scene start times
 *      → Word timestamps drive captions directly
 *   4. Falls back to Gemini transcription if OPENAI_API_KEY not set
 * 
 * Skips scene 1 (hook line) from body since it's already covered by hook clips.
 */
const { GoogleGenAI } = require('@google/genai');
const OpenAI = require('openai');
const fs = require('fs');

class GeminiAnalyzer {
    constructor() {
        this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        if (process.env.OPENAI_API_KEY) {
            this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        }
    }

    /**
     * Analyze scenes: pick hook clips + build body segments.
     * Transcribes voiceover for word-level timestamps.
     */
    async analyze(script, scenes, voiceoverPath) {
        console.log('🧠 Gemini: Selecting hook clips...');

        var sceneList = scenes.map(function(s, i) {
            return 'Scene ' + (s.sceneNumber || i + 1) + ': "' + (s.scriptLine || '') + '" [' + (s.shotType || 'medium') + ']';
        }).join('\n');

        var prompt = 'You are editing a short-form vertical video (YouTube Shorts).\n\n' +
            'I have these video scenes. Pick the 4-5 most visually dynamic/interesting ones for a rapid-fire HOOK ' +
            '(the first ~3 seconds of the video that teases what\'s coming).\n\n' +
            'SCENES:\n' + sceneList + '\n\n' +
            'Return ONLY valid JSON:\n' +
            '{\n' +
            '  "hook": {\n' +
            '    "clips": [\n' +
            '      { "scene": 3, "startSec": 1.0, "duration": 0.5 },\n' +
            '      { "scene": 7, "startSec": 2.0, "duration": 0.4 }\n' +
            '    ]\n' +
            '  }\n' +
            '}\n\n' +
            'RULES:\n' +
            '- Pick scenes that would look most dramatic/interesting as quick flashes\n' +
            '- Each clip should be 0.4-0.5 seconds\n' +
            '- Use different scenes for variety\n' +
            '- startSec is where in the 5-second clip to grab from (0-4)\n' +
            '- Pick 4-5 clips total';

        var hookResult;
        try {
            var response = await this.ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: { responseMimeType: 'application/json' }
            });

            var text = response.text || (response.candidates && response.candidates[0] &&
                response.candidates[0].content && response.candidates[0].content.parts &&
                response.candidates[0].content.parts[0] && response.candidates[0].content.parts[0].text);
            if (!text) throw new Error('Empty response from Gemini');

            var jsonText = text;
            var jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) jsonText = jsonMatch[1];

            hookResult = JSON.parse(jsonText.trim());
            if (!hookResult.hook || !hookResult.hook.clips) {
                throw new Error('Invalid hook structure');
            }
            console.log('✅ Hook: ' + hookResult.hook.clips.length + ' clips selected');
        } catch (error) {
            console.error('Gemini hook selection error:', error.message);
            console.log('⚠️ Using fallback hook selection');
            hookResult = { hook: { clips: [] } };
            for (var i = 0; i < Math.min(5, scenes.length); i++) {
                hookResult.hook.clips.push({
                    scene: scenes[i].sceneNumber || i + 1,
                    startSec: 1.0,
                    duration: 0.5
                });
            }
        }

        // Build body segments — skip scene 1 (hook line already processed)
        var body = [];
        for (var j = 0; j < scenes.length; j++) {
            var s = scenes[j];
            var num = s.sceneNumber || j + 1;
            if (num === 1) continue;
            body.push({
                scene: num,
                scriptLine: s.scriptLine || '',
                startSec: 0
            });
        }

        console.log('📋 Body: ' + body.length + ' segments (scene 1 skipped — hook line)');

        // Transcribe voiceover word-by-word with timestamps
        var transcription = null;
        var timestamps = null;
        var wordTimestamps = null;

        if (voiceoverPath) {
            // Try Whisper first (most accurate), fall back to Gemini
            if (this.openai) {
                transcription = await this.transcribeWithWhisper(voiceoverPath);
            }
            if (!transcription) {
                transcription = await this.transcribeWithGemini(voiceoverPath);
            }
        }

        if (transcription && transcription.length > 0) {
            var matched = this.matchWordsToScenes(transcription, body);
            timestamps = matched.sceneTimestamps;
            wordTimestamps = matched.wordTimestamps;
        }

        var edl = {
            hook: hookResult.hook,
            body: body,
            timestamps: timestamps,
            wordTimestamps: wordTimestamps,
            transcription: transcription,
            scenes: scenes
        };

        return edl;
    }

    /**
     * Transcribe voiceover using OpenAI Whisper API.
     * Returns word-level timestamps with ~50ms accuracy.
     * 
     * Whisper response.words = [{ word: "hello", start: 0.0, end: 0.5 }, ...]
     * We normalize to our format: { word, startSec, endSec }
     */
    async transcribeWithWhisper(voiceoverPath) {
        console.log('🎧 Whisper: Transcribing voiceover word-by-word...');

        try {
            var response = await this.openai.audio.transcriptions.create({
                file: fs.createReadStream(voiceoverPath),
                model: 'whisper-1',
                response_format: 'verbose_json',
                timestamp_granularities: ['word']
            });

            if (!response.words || response.words.length === 0) {
                throw new Error('No words in Whisper response');
            }

            // Normalize to our format
            var words = response.words.map(function(w) {
                return {
                    word: w.word || '',
                    startSec: w.start,
                    endSec: w.end
                };
            });

            // Validate ascending order
            var valid = true;
            for (var k = 0; k < words.length; k++) {
                if (typeof words[k].startSec !== 'number' || words[k].startSec < 0) {
                    valid = false; break;
                }
                if (k > 0 && words[k].startSec < words[k - 1].startSec - 0.05) {
                    valid = false; break;
                }
            }

            if (!valid) {
                console.warn('⚠️ Whisper timestamps invalid, falling back to Gemini');
                return null;
            }

            console.log('✅ Whisper: ' + words.length + ' words (' +
                words[0].word + ' @ ' + words[0].startSec.toFixed(2) + 's → ' +
                words[words.length - 1].word + ' @ ' + words[words.length - 1].startSec.toFixed(2) + 's)');

            return words;

        } catch (error) {
            console.warn('⚠️ Whisper transcription failed: ' + error.message + ' — trying Gemini');
            return null;
        }
    }

    /**
     * Fallback: Transcribe voiceover using Gemini 2.5 Flash.
     * Less accurate than Whisper but works without OpenAI key.
     */
    async transcribeWithGemini(voiceoverPath) {
        console.log('🎧 Gemini: Transcribing voiceover word-by-word (fallback)...');

        try {
            var audioBuffer = fs.readFileSync(voiceoverPath);
            var audioBase64 = audioBuffer.toString('base64');

            var prompt = 'Listen to this audio and give me word-level timestamps for EVERY word spoken.\n\n' +
                'Return ONLY valid JSON — an array of objects, one per word:\n' +
                '[\n' +
                '  { "word": "what", "startSec": 0.0, "endSec": 0.2 },\n' +
                '  { "word": "happens", "startSec": 0.2, "endSec": 0.5 },\n' +
                '  { "word": "if", "startSec": 0.5, "endSec": 0.6 }\n' +
                ']\n\n' +
                'RULES:\n' +
                '- Include EVERY single word spoken in the audio, in order\n' +
                '- startSec = when the word starts being spoken (seconds from beginning)\n' +
                '- endSec = when the word finishes being spoken\n' +
                '- Be as precise as possible (to 0.1s)\n' +
                '- Times must be in ascending order\n' +
                '- Do NOT skip any words\n' +
                '- The word field should be lowercase';

            var response = await this.ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [
                    {
                        parts: [
                            {
                                inlineData: {
                                    mimeType: 'audio/wav',
                                    data: audioBase64
                                }
                            },
                            { text: prompt }
                        ]
                    }
                ],
                config: { responseMimeType: 'application/json' }
            });

            var text = response.text || (response.candidates && response.candidates[0] &&
                response.candidates[0].content && response.candidates[0].content.parts &&
                response.candidates[0].content.parts[0] && response.candidates[0].content.parts[0].text);
            if (!text) throw new Error('Empty response');

            var jsonText = text;
            var jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) jsonText = jsonMatch[1];

            var words = JSON.parse(jsonText.trim());
            if (!Array.isArray(words) || words.length === 0) {
                throw new Error('Invalid word array');
            }

            var valid = true;
            for (var k = 0; k < words.length; k++) {
                if (typeof words[k].startSec !== 'number' || words[k].startSec < 0) {
                    valid = false; break;
                }
                if (k > 0 && words[k].startSec < words[k - 1].startSec - 0.1) {
                    valid = false; break;
                }
            }

            if (!valid) {
                console.warn('⚠️ Gemini timestamps invalid, using proportional fallback');
                return null;
            }

            console.log('✅ Gemini: ' + words.length + ' words (' +
                words[0].word + ' @ ' + words[0].startSec.toFixed(1) + 's → ' +
                words[words.length - 1].word + ' @ ' + words[words.length - 1].startSec.toFixed(1) + 's)');

            return words;

        } catch (error) {
            console.warn('⚠️ Gemini transcription failed: ' + error.message + ' — using proportional timing');
            return null;
        }
    }

    /**
     * Match transcribed words back to script lines.
     * 
     * For each body segment's scriptLine, find where its first few words
     * appear in the transcription. The timestamp of the first matched word
     * = when that scene line starts being spoken.
     */
    matchWordsToScenes(transcription, bodySegments) {
        var sceneTimestamps = [];
        var wordTimestamps = [];

        var tWords = transcription.map(function(w) {
            return {
                word: (w.word || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
                startSec: w.startSec,
                endSec: w.endSec || w.startSec + 0.2,
                original: w.word || ''
            };
        });

        var searchFrom = 0;

        for (var i = 0; i < bodySegments.length; i++) {
            var seg = bodySegments[i];
            var line = (seg.scriptLine || '').toLowerCase();
            var lineWords = line.split(/\s+/).filter(function(w) { return w.length > 0; });
            if (lineWords.length === 0) continue;

            var matchWords = [];
            for (var m = 0; m < Math.min(4, lineWords.length); m++) {
                matchWords.push(lineWords[m].replace(/[^a-z0-9]/g, ''));
            }

            var bestMatch = -1;
            for (var t = searchFrom; t < tWords.length - matchWords.length + 1; t++) {
                var matched = 0;
                for (var mw = 0; mw < matchWords.length; mw++) {
                    if (tWords[t + mw].word === matchWords[mw]) {
                        matched++;
                    }
                }
                var threshold = Math.min(2, matchWords.length);
                if (matched >= threshold) {
                    bestMatch = t;
                    break;
                }
            }

            if (bestMatch >= 0) {
                sceneTimestamps.push({
                    index: i + 1,
                    scene: seg.scene,
                    startSec: tWords[bestMatch].startSec
                });
                seg._transcriptionStart = bestMatch;
                searchFrom = bestMatch + 1;
            } else {
                seg._transcriptionStart = -1;
            }
        }

        // Build per-scene word timestamps
        for (var i = 0; i < bodySegments.length; i++) {
            var seg = bodySegments[i];
            var tStart = seg._transcriptionStart;
            if (tStart < 0) continue;

            var tEnd = tWords.length;
            for (var j = i + 1; j < bodySegments.length; j++) {
                if (bodySegments[j]._transcriptionStart >= 0) {
                    tEnd = bodySegments[j]._transcriptionStart;
                    break;
                }
            }

            for (var w = tStart; w < tEnd; w++) {
                wordTimestamps.push({
                    word: tWords[w].original,
                    startSec: tWords[w].startSec,
                    endSec: tWords[w].endSec,
                    scene: seg.scene
                });
            }
            delete seg._transcriptionStart;
        }

        for (var i = 0; i < bodySegments.length; i++) {
            delete bodySegments[i]._transcriptionStart;
        }

        console.log('📍 Scene matching: ' + sceneTimestamps.length + '/' + bodySegments.length +
            ' scenes matched, ' + wordTimestamps.length + ' words mapped');

        if (sceneTimestamps.length > 0) {
            console.log('  ' + sceneTimestamps.map(function(t) {
                return 'S' + t.scene + '@' + t.startSec.toFixed(1) + 's';
            }).join(', '));
        }

        return {
            sceneTimestamps: sceneTimestamps.length > 0 ? sceneTimestamps : null,
            wordTimestamps: wordTimestamps.length > 0 ? wordTimestamps : null
        };
    }
}

module.exports = GeminiAnalyzer;
