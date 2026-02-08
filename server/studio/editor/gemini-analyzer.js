/**
 * Gemini Analyzer — Uses Gemini to create an edit decision list from script + scenes
 * Decides: scene-to-sentence mapping, hook clip selection, click sound placement
 */
const { GoogleGenAI } = require('@google/genai');

class GeminiAnalyzer {
    constructor() {
        this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }

    /**
     * Analyze script + scenes and produce a structured edit decision list
     * @param {string} script - The full narration script
     * @param {Array} scenes - Array of { sceneNumber, scriptLine, imagePrompt, videoPrompt, videoUrl }
     * @returns {Object} Edit decision list
     */
    async analyze(script, scenes) {
        console.log('🧠 Gemini: Analyzing script for edit decisions...');

        const sceneDescriptions = scenes.map((s, i) => 
            `Scene ${s.sceneNumber || i + 1}: "${s.scriptLine}" [${s.shotType || 'medium'}] — Video prompt: "${s.videoPrompt}"`
        ).join('\n');

        const prompt = `You are a video editor for short-form vertical content (YouTube Shorts / TikTok / Reels).

I have a narration script and a set of generated video clips (scenes). I need you to create an edit decision list (EDL) that tells my automated editor exactly how to assemble the final video.

SCRIPT:
${script}

AVAILABLE SCENES:
${sceneDescriptions}

RULES:
1. Break the script into sentences. Scene switches ONLY happen on sentence boundaries (period, question mark, exclamation mark). NEVER mid-sentence.
2. Map each sentence (or group of short sentences) to the most relevant scene based on content match.
3. For the HOOK (first ~3 seconds): Pick the 4-5 most visually dynamic/interesting scenes. These will be rapid-fire 0.4-0.5 second clips that tease the video. The hook plays OVER the first sentence of narration.
4. Identify where the hook ends and the main body begins (usually after the opening question/statement).
5. For click sounds: randomly assign click sounds to ~40-50% of scene transitions in the body. The hook transitions ALWAYS get click sounds.
6. Each scene clip is ~5 seconds long. You can use a portion of it (specify startSec and duration).

Return ONLY valid JSON in this exact format:
{
  "hook": {
    "clips": [
      { "scene": 3, "startSec": 1.0, "duration": 0.5, "clickSound": true },
      { "scene": 7, "startSec": 2.0, "duration": 0.4, "clickSound": true }
    ]
  },
  "hookEndSentenceIndex": 1,
  "body": [
    {
      "sentenceIndex": 1,
      "sentence": "The actual sentence text",
      "scene": 2,
      "startSec": 0,
      "clickSound": false
    }
  ],
  "sentences": ["First sentence.", "Second sentence.", "..."]
}

IMPORTANT:
- "scene" numbers must match the available scene numbers above
- "sentenceIndex" is 0-based
- Hook clips should be from different scenes for visual variety
- Body scenes should match the content of each sentence
- Keep it simple and effective`;

        try {
            const response = await this.ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
                config: {
                    responseMimeType: 'application/json'
                }
            });

            const text = response.text || response.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error('Empty response from Gemini');

            // Parse JSON (handle markdown wrapping)
            let jsonText = text;
            const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch) jsonText = jsonMatch[1];

            const edl = JSON.parse(jsonText.trim());

            // Validate structure
            if (!edl.hook || !edl.body || !edl.sentences) {
                throw new Error('Invalid EDL structure from Gemini');
            }

            console.log(`✅ Gemini EDL: ${edl.hook.clips.length} hook clips, ${edl.body.length} body segments, ${edl.sentences.length} sentences`);
            return edl;

        } catch (error) {
            console.error('Gemini analysis error:', error.message);
            throw new Error('Failed to generate edit decision list: ' + error.message);
        }
    }
}

module.exports = GeminiAnalyzer;
