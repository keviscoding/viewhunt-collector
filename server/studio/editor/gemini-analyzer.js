/**
 * Gemini Analyzer — Uses Gemini ONLY for hook clip selection.
 * 
 * Body timing is handled directly by the video editor using Claude's
 * scene-to-scriptLine mapping (each scene already has a scriptLine
 * that tells us exactly which part of the script it covers).
 * 
 * Gemini picks the 4-5 most visually dynamic scenes for the rapid-fire
 * hook at the start of the video.
 */
const { GoogleGenAI } = require('@google/genai');

class GeminiAnalyzer {
    constructor() {
        this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }

    /**
     * Analyze scenes and pick hook clips.
     * Body segments are built directly from the scenes array (no Gemini needed).
     */
    async analyze(script, scenes) {
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

            var result = JSON.parse(jsonText.trim());
            if (!result.hook || !result.hook.clips) {
                throw new Error('Invalid hook structure from Gemini');
            }

            // Build body segments directly from scenes (Claude's scriptLine mapping)
            var body = scenes.map(function(s, i) {
                return {
                    scene: s.sceneNumber || i + 1,
                    scriptLine: s.scriptLine || '',
                    startSec: 0
                };
            });

            var edl = {
                hook: result.hook,
                body: body,
                scenes: scenes
            };

            console.log('✅ Hook: ' + edl.hook.clips.length + ' clips, Body: ' + edl.body.length + ' segments (from Claude scriptLines)');
            return edl;

        } catch (error) {
            console.error('Gemini analysis error:', error.message);
            // Fallback: auto-pick first 5 scenes for hook
            console.log('⚠️ Using fallback hook selection');
            var fallbackHook = [];
            for (var i = 0; i < Math.min(5, scenes.length); i++) {
                fallbackHook.push({
                    scene: scenes[i].sceneNumber || i + 1,
                    startSec: 1.0,
                    duration: 0.5
                });
            }
            return {
                hook: { clips: fallbackHook },
                body: scenes.map(function(s, j) {
                    return { scene: s.sceneNumber || j + 1, scriptLine: s.scriptLine || '', startSec: 0 };
                }),
                scenes: scenes
            };
        }
    }
}

module.exports = GeminiAnalyzer;
