/**
 * Gemini Analyzer — Hybrid approach:
 *   1. Gemini picks 4-5 hook clips (visual analysis)
 *   2. Body segments come from Claude's scriptLine mapping
 *   3. Gemini analyzes the voiceover audio to find real timestamps
 *      for each scriptLine → scene switches land exactly on the narration
 * 
 * Skips scene 1 (hook line) from body since it's already covered by hook clips.
 */
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');

class GeminiAnalyzer {
    constructor() {
        this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }

    /**
     * Analyze scenes: pick hook clips + build body segments.
     * If voiceoverPath is provided, also timestamps body segments against the audio.
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
            if (num === 1) continue; // skip hook scene
            body.push({
                scene: num,
                scriptLine: s.scriptLine || '',
                startSec: 0
            });
        }

        console.log('📋 Body: ' + body.length + ' segments (scene 1 skipped — hook line)');

        // Try voiceover-aware timestamping
        var timestamps = null;
        if (voiceoverPath) {
            timestamps = await this.analyzeVoiceoverTiming(voiceoverPath, body);
        }

        // Try word-level timestamps for captions
        var wordTimestamps = null;
        if (voiceoverPath) {
            wordTimestamps = await this.analyzeWordTiming(voiceoverPath, script);
        }

        var edl = {
            hook: hookResult.hook,
            body: body,
            timestamps: timestamps, // null if analysis failed/skipped
            wordTimestamps: wordTimestamps, // word-level for captions
            scenes: scenes
        };

        return edl;
    }

    /**
     * Send voiceover audio + scriptLines to Gemini.
     * Ask it to find the timestamp (in seconds) where each scriptLine
     * starts being spoken in the audio.
     * 
     * Returns array of { index, startSec } or null on failure.
     */
    async analyzeVoiceoverTiming(voiceoverPath, bodySegments) {
        console.log('🎧 Gemini: Analyzing voiceover for scene timestamps...');

        try {
            var audioBuffer = fs.readFileSync(voiceoverPath);
            var audioBase64 = audioBuffer.toString('base64');

            var scriptLines = bodySegments.map(function(seg, i) {
                return (i + 1) + '. Scene ' + seg.scene + ': "' + seg.scriptLine + '"';
            }).join('\n');

            var prompt = 'I have a voiceover audio file and a list of script lines. ' +
                'Listen to the audio and tell me the TIMESTAMP (in seconds) where each script line STARTS being spoken.\n\n' +
                'The audio begins with the hook line (first sentence of the script) which is NOT in the list below. ' +
                'The lines below start AFTER the hook.\n\n' +
                'SCRIPT LINES:\n' + scriptLines + '\n\n' +
                'Return ONLY valid JSON — an array of objects:\n' +
                '[\n' +
                '  { "index": 1, "scene": 3, "startSec": 4.2 },\n' +
                '  { "index": 2, "scene": 5, "startSec": 12.8 }\n' +
                ']\n\n' +
                'RULES:\n' +
                '- Listen carefully to the audio for when each line starts\n' +
                '- startSec is seconds from the beginning of the audio file\n' +
                '- Times should be in ascending order\n' +
                '- Be as precise as possible (to 0.1s)\n' +
                '- Include ALL lines from the list';

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

            var timestamps = JSON.parse(jsonText.trim());
            if (!Array.isArray(timestamps) || timestamps.length === 0) {
                throw new Error('Invalid timestamps array');
            }

            // Validate: must be ascending and reasonable
            var valid = true;
            for (var k = 0; k < timestamps.length; k++) {
                if (typeof timestamps[k].startSec !== 'number' || timestamps[k].startSec < 0) {
                    valid = false; break;
                }
                if (k > 0 && timestamps[k].startSec < timestamps[k - 1].startSec) {
                    valid = false; break;
                }
            }

            if (!valid) {
                console.warn('⚠️ Timestamps not ascending or invalid, falling back to proportional');
                return null;
            }

            console.log('✅ Voiceover timestamps: ' + timestamps.map(function(t) {
                return 'S' + t.scene + '@' + t.startSec.toFixed(1) + 's';
            }).join(', '));

            return timestamps;

        } catch (error) {
            console.warn('⚠️ Voiceover analysis failed: ' + error.message + ' — using proportional timing');
            return null;
        }
    }
    /**
     * Get word-level timestamps from voiceover audio for captions.
     * Returns array of { word, startSec, endSec } or null on failure.
     */
    async analyzeWordTiming(voiceoverPath, script) {
        console.log('📝 Gemini: Analyzing word-level timing for captions...');

        try {
            var audioBuffer = fs.readFileSync(voiceoverPath);
            var audioBase64 = audioBuffer.toString('base64');

            var prompt = 'I have a voiceover audio file. I need WORD-LEVEL timestamps for captions.\n\n' +
                'The script being read is:\n"' + script + '"\n\n' +
                'Listen to the audio and return the START and END time (in seconds) for EACH WORD.\n\n' +
                'Return ONLY valid JSON — an array:\n' +
                '[\n' +
                '  { "word": "What", "startSec": 0.0, "endSec": 0.3 },\n' +
                '  { "word": "if", "startSec": 0.3, "endSec": 0.45 }\n' +
                ']\n\n' +
                'RULES:\n' +
                '- Include EVERY word spoken in the audio\n' +
                '- Times must be ascending\n' +
                '- Be precise to 0.1s\n' +
                '- endSec of one word should be close to startSec of the next\n' +
                '- Include pauses (gaps between words are fine)';

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
            if (!Array.isArray(words) || words.length < 5) {
                throw new Error('Too few words returned: ' + (words ? words.length : 0));
            }

            // Validate ascending order
            for (var k = 1; k < words.length; k++) {
                if (words[k].startSec < words[k - 1].startSec) {
                    throw new Error('Word timestamps not ascending');
                }
            }

            console.log('✅ Word timestamps: ' + words.length + ' words (first: "' +
                words[0].word + '" @' + words[0].startSec + 's, last: "' +
                words[words.length - 1].word + '" @' + words[words.length - 1].startSec + 's)');

            return words;

        } catch (error) {
            console.warn('⚠️ Word-level timing failed: ' + error.message + ' — captions will be skipped');
            return null;
        }
    }
}

module.exports = GeminiAnalyzer;
