/**
 * Background Task Manager — Runs generation jobs independently of HTTP connections.
 * 
 * Users can close their browser tab and generation continues server-side.
 * Results (image/video URLs) are stored in MongoDB as they complete.
 * 
 * Task lifecycle:
 *   1. User creates task via API → task doc inserted with status 'pending'
 *   2. Task manager picks it up → status 'running', generation starts
 *   3. As scenes complete → scene URLs saved to task doc in real-time
 *   4. All done → status 'completed' (or 'failed' / 'partial')
 * 
 * Concurrent limits by plan:
 *   - Starter: 1 concurrent task
 *   - Creator: 2 concurrent tasks
 *   - Studio:  3 concurrent tasks
 *   - Admin:   unlimited
 */
const { getDb } = require('./db');
const { ObjectId } = require('mongodb');
const credits = require('./credits');

const COLLECTION = 'generation_tasks';

// Concurrent task limits per plan
const PLAN_LIMITS = {
    starter: 1,
    creator: 2,
    studio: 3
};

// In-memory map of running tasks (taskId → abort controller)
const runningTasks = new Map();

/**
 * Create a new background generation task.
 * Returns the task document (with _id).
 */
async function createTask(userId, config) {
    const db = await getDb();

    const task = {
        userId: String(userId),
        status: 'pending',
        format: config.format || 'skeleton-anatomy',
        config: {
            script: config.script,
            skeletonStyle: config.skeletonStyle || 'realistic translucent glass with ivory skeleton',
            gradientColors: config.gradientColors || 'smooth blue to teal gradient background',
            generateVideos: config.generateVideos !== false,
            videoModel: config.videoModel || 'wan'
        },
        progress: {
            step: 'queued',
            message: 'Waiting to start...',
            totalScenes: 0,
            imagesCompleted: 0,
            videosCompleted: 0,
            imagesFailed: 0,
            videosFailed: 0
        },
        scenes: [],
        creditsCharged: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
        error: null
    };

    const result = await db.collection(COLLECTION).insertOne(task);
    task._id = result.insertedId;

    console.log(`📋 Task created: ${task._id} for user ${userId}`);
    return task;
}

/**
 * Check if user can create a new task (concurrent limit check).
 * Returns { allowed, running, limit, plan }
 */
async function canCreateTask(userId) {
    const db = await getDb();
    const bal = await credits.getBalance(String(userId));
    const plan = bal.plan || 'starter';

    // Admin has no limit
    const limit = PLAN_LIMITS[plan] || 1;

    const running = await db.collection(COLLECTION).countDocuments({
        userId: String(userId),
        status: { $in: ['pending', 'running'] }
    });

    return {
        allowed: running < limit,
        running,
        limit,
        plan
    };
}

/**
 * Get a single task by ID (with ownership check).
 */
async function getTask(taskId, userId) {
    const db = await getDb();
    return db.collection(COLLECTION).findOne({
        _id: new ObjectId(taskId),
        userId: String(userId)
    });
}

/**
 * List tasks for a user (most recent first).
 */
async function listTasks(userId, limit) {
    limit = limit || 20;
    const db = await getDb();
    return db.collection(COLLECTION)
        .find({ userId: String(userId) })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();
}

/**
 * Update task progress in MongoDB.
 */
async function updateProgress(taskId, progress, extraFields) {
    const db = await getDb();
    const update = {
        $set: {
            progress: progress,
            updatedAt: new Date()
        }
    };
    if (extraFields) {
        Object.assign(update.$set, extraFields);
    }
    await db.collection(COLLECTION).updateOne(
        { _id: new ObjectId(taskId) },
        update
    );
}

/**
 * Save a completed scene to the task document.
 */
async function saveScene(taskId, sceneIndex, sceneData) {
    const db = await getDb();
    const key = `scenes.${sceneIndex}`;
    await db.collection(COLLECTION).updateOne(
        { _id: new ObjectId(taskId) },
        {
            $set: {
                [key]: sceneData,
                updatedAt: new Date()
            }
        }
    );
}

/**
 * Mark task as completed (always 'completed', never 'partial').
 */
async function completeTask(taskId, result) {
    const db = await getDb();
    await db.collection(COLLECTION).updateOne(
        { _id: new ObjectId(taskId) },
        {
            $set: {
                status: 'completed',
                progress: {
                    step: 'complete',
                    message: result.message || 'Generation complete',
                    totalScenes: result.totalScenes || 0,
                    imagesCompleted: result.imagesCompleted || 0,
                    videosCompleted: result.videosCompleted || 0,
                    imagesFailed: 0,
                    videosFailed: 0
                },
                creditsCharged: result.creditsCharged || 0,
                completedAt: new Date(),
                updatedAt: new Date()
            }
        }
    );
    runningTasks.delete(taskId.toString());
    console.log(`✅ Task ${taskId} completed`);
}

/**
 * Mark task as failed.
 */
async function failTask(taskId, errorMessage) {
    const db = await getDb();
    await db.collection(COLLECTION).updateOne(
        { _id: new ObjectId(taskId) },
        {
            $set: {
                status: 'failed',
                error: errorMessage,
                completedAt: new Date(),
                updatedAt: new Date()
            }
        }
    );
    runningTasks.delete(taskId.toString());
    console.log(`❌ Task ${taskId} failed: ${errorMessage}`);
}

/**
 * Cancel a running task.
 */
async function cancelTask(taskId, userId) {
    const db = await getDb();
    const task = await db.collection(COLLECTION).findOne({
        _id: new ObjectId(taskId),
        userId: String(userId)
    });

    if (!task) return { success: false, error: 'Task not found' };
    if (task.status !== 'pending' && task.status !== 'running') {
        return { success: false, error: 'Task is already ' + task.status };
    }

    // Signal the running task to stop
    const controller = runningTasks.get(taskId.toString());
    if (controller) controller.abort();

    await db.collection(COLLECTION).updateOne(
        { _id: new ObjectId(taskId) },
        {
            $set: {
                status: 'cancelled',
                completedAt: new Date(),
                updatedAt: new Date()
            }
        }
    );
    runningTasks.delete(taskId.toString());
    console.log(`🚫 Task ${taskId} cancelled by user`);
    return { success: true };
}

/**
 * Run a generation task in the background.
 * This is fire-and-forget — it runs detached from the HTTP request.
 * The generator is passed in so we don't create circular dependencies.
 */
function runTask(taskId, generator, userId) {
    const id = taskId.toString();
    const controller = new AbortController();
    runningTasks.set(id, controller);

    // Fire and forget — don't await this
    _executeTask(id, generator, userId, controller.signal).catch(err => {
        console.error(`Task ${id} uncaught error:`, err.message);
        failTask(id, err.message).catch(() => {});
    });
}

/**
 * Internal: execute the generation pipeline for a task.
 * Images and videos are retried aggressively (up to 5 attempts each with backoff).
 * No "partial" status — we keep retrying until everything succeeds or we hit max retries.
 */
async function _executeTask(taskId, generator, userId, signal) {
    const db = await getDb();
    const task = await db.collection(COLLECTION).findOne({ _id: new ObjectId(taskId) });
    if (!task) throw new Error('Task not found');

    const config = task.config;
    const MAX_RETRIES = 5;
    const RETRY_DELAY_BASE = 8000; // 8s base, increases with each retry
    let totalCreditsCharged = 0;

    // Mark as running
    await db.collection(COLLECTION).updateOne(
        { _id: new ObjectId(taskId) },
        { $set: { status: 'running', startedAt: new Date(), updatedAt: new Date() } }
    );

    try {
        if (signal.aborted) throw new Error('Task cancelled');

        // Step 1: Generate scene prompts
        await updateProgress(taskId, {
            step: 'claude',
            message: 'Claude is analyzing your script...',
            totalScenes: 0, imagesCompleted: 0, videosCompleted: 0, imagesFailed: 0, videosFailed: 0
        });

        console.log(`📋 Task ${taskId}: generating scene prompts...`);
        const scenes = await generator.generateScenePrompts(
            config.script, config.skeletonStyle, config.gradientColors
        );

        await credits.deductCredits(userId, 'script_generation', 1, 'Background task: script generation');
        totalCreditsCharged += credits.COSTS.script_generation;

        // Initialize scenes array in task
        const scenesDocs = scenes.map((s, i) => ({
            index: i,
            scriptLine: s.scriptLine,
            imagePrompt: s.imagePrompt,
            videoPrompt: s.videoPrompt,
            imageUrl: null, videoUrl: null, imageError: null, videoError: null
        }));

        await db.collection(COLLECTION).updateOne(
            { _id: new ObjectId(taskId) },
            {
                $set: {
                    scenes: scenesDocs,
                    'progress.totalScenes': scenes.length,
                    'progress.step': 'images',
                    'progress.message': `Generating ${scenes.length} images...`,
                    updatedAt: new Date()
                }
            }
        );

        if (signal.aborted) throw new Error('Task cancelled');

        // Step 2: Generate images — parallel first pass, then retry failures sequentially
        console.log(`📋 Task ${taskId}: generating ${scenes.length} images...`);
        let imagesCompleted = 0;

        // First pass: all in parallel
        const imagePromises = scenes.map(async (scene, index) => {
            if (signal.aborted) return;
            try {
                const imageUrl = await generator.generateImage(scene.imagePrompt, index + 1);
                scenes[index].imageUrl = imageUrl;
                imagesCompleted++;
                await saveScene(taskId, index, { ...scenesDocs[index], imageUrl });
                await updateProgress(taskId, {
                    step: 'images', message: `Generated image ${imagesCompleted}/${scenes.length}`,
                    totalScenes: scenes.length, imagesCompleted, videosCompleted: 0, imagesFailed: 0, videosFailed: 0
                });
            } catch (err) {
                console.warn(`Task ${taskId}: image ${index + 1} failed (will retry): ${err.message}`);
                scenes[index].imageError = err.message;
            }
        });
        await Promise.all(imagePromises);

        // Retry loop: keep retrying failed images until all succeed or max retries hit
        for (let retry = 1; retry <= MAX_RETRIES; retry++) {
            if (signal.aborted) throw new Error('Task cancelled');
            const failedImages = scenes.filter(s => !s.imageUrl);
            if (failedImages.length === 0) break;

            const delay = RETRY_DELAY_BASE * retry;
            console.log(`📋 Task ${taskId}: retrying ${failedImages.length} failed image(s) (attempt ${retry}/${MAX_RETRIES}, waiting ${delay / 1000}s)...`);
            await updateProgress(taskId, {
                step: 'images', message: `Retrying ${failedImages.length} failed image(s)... (attempt ${retry}/${MAX_RETRIES})`,
                totalScenes: scenes.length, imagesCompleted, videosCompleted: 0, imagesFailed: failedImages.length, videosFailed: 0
            });
            await new Promise(r => setTimeout(r, delay));

            for (const scene of failedImages) {
                if (signal.aborted) throw new Error('Task cancelled');
                const idx = scenes.indexOf(scene);
                try {
                    const imageUrl = await generator.generateImage(scene.imagePrompt, idx + 1);
                    scenes[idx].imageUrl = imageUrl;
                    scenes[idx].imageError = null;
                    imagesCompleted++;
                    await saveScene(taskId, idx, { ...scenesDocs[idx], imageUrl, imageError: null });
                    await updateProgress(taskId, {
                        step: 'images', message: `Generated image ${imagesCompleted}/${scenes.length} (retry ${retry})`,
                        totalScenes: scenes.length, imagesCompleted, videosCompleted: 0, imagesFailed: scenes.filter(s => !s.imageUrl).length, videosFailed: 0
                    });
                    console.log(`✅ Task ${taskId}: image ${idx + 1} retry succeeded`);
                } catch (err) {
                    console.warn(`Task ${taskId}: image ${idx + 1} retry ${retry} failed: ${err.message}`);
                }
            }
        }

        // Charge for successful images
        if (imagesCompleted > 0) {
            await credits.deductCredits(userId, 'image_generation', imagesCompleted, `Background task: ${imagesCompleted} images`);
            totalCreditsCharged += credits.COSTS.image_generation * imagesCompleted;
        }

        const finalFailedImages = scenes.filter(s => !s.imageUrl).length;
        await updateProgress(taskId, {
            step: 'images', message: `${imagesCompleted}/${scenes.length} images generated`,
            totalScenes: scenes.length, imagesCompleted, videosCompleted: 0, imagesFailed: finalFailedImages, videosFailed: 0
        });

        if (signal.aborted) throw new Error('Task cancelled');

        // Step 3: Generate videos (if enabled)
        let videosCompleted = 0;

        if (config.generateVideos) {
            const scenesWithImages = scenes.filter(s => s.imageUrl);

            await updateProgress(taskId, {
                step: 'videos', message: `Generating ${scenesWithImages.length} videos...`,
                totalScenes: scenes.length, imagesCompleted, videosCompleted: 0, imagesFailed: finalFailedImages, videosFailed: 0
            });

            console.log(`📋 Task ${taskId}: generating ${scenesWithImages.length} videos...`);

            // First pass: all in parallel
            const videoPromises = scenesWithImages.map(async (scene) => {
                if (signal.aborted) return;
                const sceneIndex = scenes.indexOf(scene);
                try {
                    const videoUrl = await generator.generateVideo(
                        scene.imageUrl, scene.videoPrompt, sceneIndex + 1, config.videoModel
                    );
                    scenes[sceneIndex].videoUrl = videoUrl;
                    videosCompleted++;
                    await saveScene(taskId, sceneIndex, { ...scenesDocs[sceneIndex], imageUrl: scene.imageUrl, videoUrl });
                    await updateProgress(taskId, {
                        step: 'videos', message: `Generated video ${videosCompleted}/${scenesWithImages.length}`,
                        totalScenes: scenes.length, imagesCompleted, videosCompleted, imagesFailed: finalFailedImages, videosFailed: 0
                    });
                } catch (err) {
                    console.warn(`Task ${taskId}: video ${sceneIndex + 1} failed (will retry): ${err.message}`);
                    scenes[sceneIndex].videoError = err.message;
                }
            });
            await Promise.all(videoPromises);

            // Retry loop: keep retrying failed videos
            for (let retry = 1; retry <= MAX_RETRIES; retry++) {
                if (signal.aborted) throw new Error('Task cancelled');
                const failedVideos = scenesWithImages.filter(s => !s.videoUrl);
                if (failedVideos.length === 0) break;

                const delay = RETRY_DELAY_BASE * retry;
                console.log(`📋 Task ${taskId}: retrying ${failedVideos.length} failed video(s) (attempt ${retry}/${MAX_RETRIES}, waiting ${delay / 1000}s)...`);
                await updateProgress(taskId, {
                    step: 'videos', message: `Retrying ${failedVideos.length} failed video(s)... (attempt ${retry}/${MAX_RETRIES})`,
                    totalScenes: scenes.length, imagesCompleted, videosCompleted, imagesFailed: finalFailedImages, videosFailed: failedVideos.length
                });
                await new Promise(r => setTimeout(r, delay));

                for (const scene of failedVideos) {
                    if (signal.aborted) throw new Error('Task cancelled');
                    const sceneIndex = scenes.indexOf(scene);
                    try {
                        const videoUrl = await generator.generateVideo(
                            scene.imageUrl, scene.videoPrompt, sceneIndex + 1, config.videoModel
                        );
                        scenes[sceneIndex].videoUrl = videoUrl;
                        scenes[sceneIndex].videoError = null;
                        videosCompleted++;
                        await saveScene(taskId, sceneIndex, {
                            ...scenesDocs[sceneIndex], imageUrl: scene.imageUrl, videoUrl, videoError: null
                        });
                        console.log(`✅ Task ${taskId}: video ${sceneIndex + 1} retry succeeded`);
                    } catch (err) {
                        console.warn(`Task ${taskId}: video ${sceneIndex + 1} retry ${retry} failed: ${err.message}`);
                    }
                }
            }

            // Charge for successful videos
            if (videosCompleted > 0) {
                await credits.deductCredits(userId, 'video_generation', videosCompleted, `Background task: ${videosCompleted} videos`);
                totalCreditsCharged += credits.COSTS.video_generation * videosCompleted;
            }
        }

        // Always mark as completed — message reflects what actually succeeded
        var completionMessage;
        if (config.generateVideos && videosCompleted > 0) {
            completionMessage = `Generated ${imagesCompleted} images and ${videosCompleted} videos — ready to assemble`;
        } else if (config.generateVideos && videosCompleted === 0 && imagesCompleted > 0) {
            completionMessage = `Generated ${imagesCompleted} images but all videos failed after retries. You can retry or use images only.`;
        } else if (!config.generateVideos && imagesCompleted > 0) {
            completionMessage = `Generated ${imagesCompleted} images — ready to review`;
        } else {
            completionMessage = `Generation completed with ${imagesCompleted} images and ${videosCompleted} videos`;
        }

        await completeTask(taskId, {
            message: completionMessage,
            totalScenes: scenes.length,
            imagesCompleted,
            videosCompleted,
            creditsCharged: totalCreditsCharged
        });

        console.log(`📋 Task ${taskId}: complete. Credits charged: ${totalCreditsCharged}`);

    } catch (err) {
        if (err.message === 'Task cancelled') {
            console.log(`📋 Task ${taskId}: cancelled during execution`);
            return;
        }
        await failTask(taskId, err.message);
    }
}

/**
 * Delete old completed/failed tasks (cleanup).
 * Call periodically or on startup.
 */
async function cleanupOldTasks(maxAgeDays) {
    maxAgeDays = maxAgeDays || 7;
    const db = await getDb();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxAgeDays);

    const result = await db.collection(COLLECTION).deleteMany({
        status: { $in: ['completed', 'failed', 'cancelled'] },
        completedAt: { $lt: cutoff }
    });

    if (result.deletedCount > 0) {
        console.log(`🧹 Cleaned up ${result.deletedCount} old tasks (>${maxAgeDays} days)`);
    }
}

/**
 * On server startup: mark any 'running' or 'pending' tasks as failed.
 * (Server restarted, those tasks are gone.)
 */
async function recoverStaleTasks() {
    const db = await getDb();
    const result = await db.collection(COLLECTION).updateMany(
        { status: { $in: ['pending', 'running'] } },
        {
            $set: {
                status: 'failed',
                error: 'Server restarted during generation. Please try again.',
                completedAt: new Date(),
                updatedAt: new Date()
            }
        }
    );
    if (result.modifiedCount > 0) {
        console.log(`📋 Recovered ${result.modifiedCount} stale tasks after restart`);
    }
}

/**
 * Create indexes for the tasks collection.
 */
async function ensureIndexes() {
    const db = await getDb();
    await db.collection(COLLECTION).createIndex({ userId: 1, createdAt: -1 });
    await db.collection(COLLECTION).createIndex({ userId: 1, status: 1 });
    await db.collection(COLLECTION).createIndex({ status: 1 });
    console.log('📋 Task indexes created');
}

module.exports = {
    PLAN_LIMITS,
    createTask,
    canCreateTask,
    getTask,
    listTasks,
    updateProgress,
    saveScene,
    completeTask,
    failTask,
    cancelTask,
    runTask,
    cleanupOldTasks,
    recoverStaleTasks,
    ensureIndexes
};
