/**
 * Seedance 2.0 Video Generator — Kie.ai API
 * Text-to-Video and Image-to-Video using bytedance/seedance-2
 * 480p for fast + cheap generation
 */
const axios = require('axios');

class Seedance2Generator {
    constructor() {
        this.kieApiKey = process.env.KIEAI_API_KEY;
        this.kieBaseUrl = 'https://api.kie.ai';
    }

    /**
     * Generate a video from text prompt (and optional first frame image)
     */
    async generate(options) {
        var prompt = options.prompt;
        var firstFrameUrl = options.firstFrameUrl || null;
        var lastFrameUrl = options.lastFrameUrl || null;
        var duration = options.duration || 8;
        var aspectRatio = options.aspectRatio || '9:16';
        var generateAudio = options.generateAudio !== false;

        // Validate duration
        if ([4, 8, 12].indexOf(duration) === -1) duration = 8;

        console.log('🎬 Seedance 2.0: Generating ' + duration + 's video at 480p (' + aspectRatio + ')');
        if (firstFrameUrl) console.log('  First frame: ' + firstFrameUrl.substring(0, 80) + '...');

        var input = {
            prompt: prompt,
            resolution: '480p',
            aspect_ratio: aspectRatio,
            duration: duration,
            generate_audio: generateAudio,
            web_search: false
        };

        if (firstFrameUrl) input.first_frame_url = firstFrameUrl;
        if (lastFrameUrl) input.last_frame_url = lastFrameUrl;

        // Create task
        var createResponse = await axios.post(
            this.kieBaseUrl + '/api/v1/jobs/createTask',
            { model: 'bytedance/seedance-2', input: input },
            {
                headers: {
                    'Authorization': 'Bearer ' + this.kieApiKey,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        var respData = createResponse.data;
        if (respData.code !== 200 || !respData.data?.taskId) {
            var msg = respData.msg || 'Unknown error';
            console.error('  Seedance 2 createTask failed: ' + msg);
            if (respData.code === 402) throw new Error('Out of Kie.ai credits.');
            throw new Error('Seedance 2 failed: ' + msg);
        }

        var taskId = respData.data.taskId;
        console.log('  Seedance 2 task created: ' + taskId);

        // Poll for result
        var videoUrl = await this.pollTask(taskId);
        console.log('✅ Seedance 2 video generated: ' + videoUrl.substring(0, 80) + '...');
        return { videoUrl: videoUrl, taskId: taskId };
    }

    async pollTask(taskId, timeout) {
        timeout = timeout || 600000; // 10 min
        var startTime = Date.now();
        var pollInterval = 5000;
        var pollCount = 0;

        while (Date.now() - startTime < timeout) {
            pollCount++;
            try {
                var response = await axios.get(
                    this.kieBaseUrl + '/api/v1/jobs/recordInfo',
                    {
                        params: { taskId: taskId },
                        headers: { 'Authorization': 'Bearer ' + this.kieApiKey }
                    }
                );

                if (response.data.code !== 200) {
                    throw new Error('Kie.ai API error: ' + response.data.msg);
                }

                var state = response.data.data.state;
                if (pollCount % 6 === 0) {
                    var elapsed = Math.floor((Date.now() - startTime) / 1000);
                    console.log('  Seedance 2 task ' + taskId + ': ' + state + ' (' + elapsed + 's)');
                }

                if (state === 'success') {
                    var resultJson = JSON.parse(response.data.data.resultJson);
                    var urls = resultJson.resultUrls || resultJson.videoUrls || [];
                    if (urls.length === 0) throw new Error('Seedance 2 returned success but no video URLs');
                    return urls[0];
                }

                if (state === 'fail') {
                    throw new Error('Seedance 2 generation failed: ' + (response.data.data.failMsg || 'Unknown'));
                }

                await new Promise(function(resolve) { setTimeout(resolve, pollInterval); });
            } catch (error) {
                if (error.response?.status === 401) throw new Error('Kie.ai auth failed.');
                if (error.response?.status === 402) throw new Error('Out of Kie.ai credits.');
                if (error.message.includes('Seedance') || error.message.includes('Kie.ai')) throw error;
                await new Promise(function(resolve) { setTimeout(resolve, pollInterval); });
            }
        }
        throw new Error('Seedance 2 task timeout after ' + Math.floor(timeout / 1000) + 's');
    }
}

module.exports = Seedance2Generator;
