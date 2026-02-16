/**
 * Simple in-memory job queue for video assembly.
 * Processes one job at a time to stay within memory limits.
 * Jobs persist only for the lifetime of the process.
 */

const GeminiAnalyzer = require('./gemini-analyzer');
const GeminiTTS = require('./gemini-tts');
const VideoEditor = require('./video-editor');

// Job states
const STATES = {
    QUEUED: 'queued',
    TTS: 'generating_voiceover',
    ANALYZING: 'analyzing_edit_points',
    ASSEMBLING: 'assembling_video',
    COMPLETE: 'complete',
    FAILED: 'failed'
};

class JobQueue {
    constructor() {
        this.jobs = new Map();
        this.queue = [];
        this.processing = false;
    }

    /**
     * Submit a new assembly job. Returns immediately with a jobId.
     */
    submit(script, scenes, voiceName, userId) {
        // Prevent queue flooding — max 10 pending jobs
        if (this.queue.length >= 10) {
            throw new Error('Queue is full. Please wait for current jobs to finish.');
        }

        const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        this.jobs.set(jobId, {
            id: jobId,
            status: STATES.QUEUED,
            message: 'Waiting in queue...',
            position: this.queue.length + 1,
            script,
            scenes,
            voiceName: voiceName || 'Charon',
            userId: userId || null,
            result: null,
            error: null,
            _refunded: false,
            createdAt: Date.now()
        });

        this.queue.push(jobId);
        console.log(`📋 Job ${jobId} queued (position ${this.queue.length})`);

        // Start processing if not already running
        this.processNext();

        return jobId;
    }

    /**
     * Get job status
     */
    getStatus(jobId) {
        const job = this.jobs.get(jobId);
        if (!job) return null;

        // Calculate queue position
        const queuePos = this.queue.indexOf(jobId);

        return {
            id: job.id,
            status: job.status,
            message: job.message,
            position: queuePos >= 0 ? queuePos + 1 : 0,
            queueLength: this.queue.length,
            result: job.result,
            error: job.error,
            _refunded: job._refunded || false
        };
    }

    /**
     * Mark a job as refunded (prevents double-refund)
     */
    markRefunded(jobId) {
        const job = this.jobs.get(jobId);
        if (job) job._refunded = true;
    }

    /**
     * Process next job in queue
     */
    async processNext() {
        if (this.processing || this.queue.length === 0) return;

        this.processing = true;
        const jobId = this.queue[0]; // peek, don't remove yet
        const job = this.jobs.get(jobId);

        if (!job) {
            this.queue.shift();
            this.processing = false;
            this.processNext();
            return;
        }

        console.log(`\n🎬 Processing job ${jobId}...`);

        try {
            // Step 1: TTS
            this.updateJob(jobId, STATES.TTS, 'Generating voiceover...');
            const tts = new GeminiTTS();
            const voiceoverPath = await tts.generateVoiceover(job.script, job.voiceName);

            // Step 2: Analyze (hook selection + voiceover-aware timestamps)
            this.updateJob(jobId, STATES.ANALYZING, 'Analyzing edit points...');
            const analyzer = new GeminiAnalyzer();
            const edl = await analyzer.analyze(job.script, job.scenes, voiceoverPath);

            // Step 3: Assemble
            this.updateJob(jobId, STATES.ASSEMBLING, 'Assembling video...');
            const editor = new VideoEditor();
            const result = await editor.assemble(edl, job.scenes, voiceoverPath);

            // Done
            job.result = {
                videoUrl: result.videoUrl,
                duration: result.duration,
                hookClips: edl.hook.clips.length,
                bodySegments: edl.body.length
            };
            this.updateJob(jobId, STATES.COMPLETE, 'Video assembled!');

        } catch (error) {
            console.error(`Job ${jobId} failed:`, error.message);
            job.error = error.message;
            this.updateJob(jobId, STATES.FAILED, error.message);
        } finally {
            // Remove from queue
            this.queue.shift();
            this.processing = false;

            // Clean up old jobs (keep last 20)
            this.cleanupOldJobs();

            // Process next
            this.processNext();
        }
    }

    updateJob(jobId, status, message) {
        const job = this.jobs.get(jobId);
        if (job) {
            job.status = status;
            job.message = message;
            console.log(`  [${jobId}] ${status}: ${message}`);
        }
    }

    cleanupOldJobs() {
        const maxAge = 10 * 60 * 1000; // 10 minutes
        const now = Date.now();
        for (const [id, job] of this.jobs) {
            if (now - job.createdAt > maxAge && job.status !== STATES.QUEUED) {
                this.jobs.delete(id);
            } else if (job.status === STATES.COMPLETE || job.status === STATES.FAILED) {
                // Free heavy data from finished jobs (keep status/result only)
                job.script = null;
                job.scenes = null;
            }
        }
    }
}

// Singleton
const queue = new JobQueue();
module.exports = queue;
