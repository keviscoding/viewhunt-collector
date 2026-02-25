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
 * Mark task as completed.
 */
async function completeTask(taskId, result) {
    const db = await getDb();
    await db.collection(COLLECTION).updateOne(
        { _id: new ObjectId(taskId) },
        {
            $set: {
                status: result.success ? 'completed' : 'partial',
                progress: {
                    step: 'complete',
                    message: result.message || 'Generation complete',
                    totalScenes: result.totalScenes || 0,
                    imagesCompleted: result.imagesCompleted || 0,
                    videosCompleted: result.videosCompleted || 0,
                    imagesFailed: result.imagesFailed || 0,
                    videosFailed: result.videosFailed || 0
                },
                creditsCharged: result.creditsCharged || 0,
                completedAt: new Date(),
                updatedAt: new Date()
            }
        }
    );
    runningTasks.delete(taskId.toString());
    console.log(`✅ Task ${taskId} completed (${result.success ? 'success' : 'partial'})`);
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
 */
async function _executeTask(taskId, generator, userId, signal) {
    const db = await getDb();
    const task = await db.collection(COLLECTION).findOne({ _id: new ObjectId(taskId) });
    if (!task) throw new Error('Task not found');

    const config = task.config;
    let totalCreditsCharged = 0;

    // Mark as running
    await db.collection(COLLECTION).updateOne(
        { _id: new ObjectId(taskId) },
        { $set: { status: 'running', startedAt: new Date(), updatedAt: new Date() } }
    );

    try {
        // Check for cancellation
        if (signal.aborted) throw new Error('Task cancelled');

        // Step 1: Generate scene prompts
        await updateProgress(taskId, {
            step: 'claude',
            message: 'Claude is analyzing your script...',
            totalScenes: 0,
            imagesCompleted: 0,
            videosCompleted: 0,
            imagesFailed: 0,
            videosFailed: 0
        });

        console.log(`📋 Task ${taskId}: generating scene prompts...`);
        const scenes = await generator.generateScenePrompts(
            config.script,
            config.skeletonStyle,
            config.gradientColors
        );

        // Charge for script generation
        await credits.deductCredits(userId, 'script_generation', 1, 'Background task: script generation');
        totalCreditsCharged += credits.COSTS.script_generation;

        // Initialize scenes array in task
        const scenesDocs = scenes.map((s, i) => ({
            index: i,
            scriptLine: s.scriptLine,
            imagePrompt: s.imagePrompt,
            videoPrompt: s.videoPrompt,
            imageUrl: null,
            videoUrl: null,
            imageError: null,
            videoError: null
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

        // Step 2: Generate images in parallel
        console.log(`📋 Task ${taskId}: generating ${scenes.length} images...`);
        let imagesCompleted = 0;
        let imagesFailed = 0;

        const imagePromises = scenes.map(async (scene, index) => {
            if (signal.aborted) return { success: false, error: 'cancelled' };
            try {
                const imageUrl = await generator.generateImage(scene.imagePrompt, index + 1);
                scenes[index].imageUrl = imageUrl;
                imagesCompleted++;

                // Save to DB immediately
                await saveScene(taskId, index, {
                    ...scenesDocs[index],
                    imageUrl: imageUrl
                });
                await updateProgress(taskId, {
                    step: 'images',
                    message: `Generated image ${imagesCompleted}/${scenes.length}`,
                    totalScenes: scenes.length,
                    imagesCompleted,
                    videosCompleted: 0,
                    imagesFailed,
                    videosFailed: 0
                });

                return { success: true, index };
            } catch (err) {
                imagesFailed++;
                scenes[index].imageError = err.message;
                await saveScene(taskId, index, {
                    ...scenesDocs[index],
                    imageError: err.message
                });
                return { success: false, index, error: err.message };
            }
        });

        await Promise.all(imagePromises);

        // Charge for successful images only
        if (imagesCompleted > 0) {
            await credits.deductCredits(userId, 'image_generation', imagesCompleted,
                `Background task: ${imagesCompleted} images`);
            totalCreditsCharged += credits.COSTS.image_generation * imagesCompleted;
        }

        await updateProgress(taskId, {
            step: 'images',
            message: `${imagesCompleted}/${scenes.length} images generated`,
            totalScenes: scenes.length,
            imagesCompleted,
            videosCompleted: 0,
            imagesFailed,
            videosFailed: 0
        });

        if (signal.aborted) throw new Error('Task cancelled');

        // Step 3: Generate videos (if enabled)
        let videosCompleted = 0;
        let videosFailed = 0;

        if (config.generateVideos) {
            const scenesWithImages = scenes.filter((s, i) => s.imageUrl);

            await updateProgress(taskId, {
                step: 'videos',
                message: `Generating ${scenesWithImages.length} videos...`,
                totalScenes: scenes.length,
                imagesCompleted,
                videosCompleted: 0,
                imagesFailed,
                videosFailed: 0
            });

            console.log(`📋 Task ${taskId}: generating ${scenesWithImages.length} videos...`);

            const videoPromises = scenesWithImages.map(async (scene, idx) => {
                if (signal.aborted) return { success: false, error: 'cancelled' };
                const sceneIndex = scenes.indexOf(scene);
                try {
                    const videoUrl = await generator.generateVideo(
                        scene.imageUrl,
                        scene.videoPrompt,
                        sceneIndex + 1,
                        config.videoModel
                    );
                    scenes[sceneIndex].videoUrl = videoUrl;
                    videosCompleted++;

                    await saveScene(taskId, sceneIndex, {
                        ...scenesDocs[sceneIndex],
                        imageUrl: scene.imageUrl,
                        videoUrl: videoUrl
                    });
                    await updateProgress(taskId, {
                        step: 'videos',
                        message: `Generated video ${videosCompleted}/${scenesWithImages.length}`,
                        totalScenes: scenes.length,
                        imagesCompleted,
                        videosCompleted,
                        imagesFailed,
                        videosFailed
                    });

                    return { success: true, sceneIndex };
                } catch (err) {
                    videosFailed++;
                    scenes[sceneIndex].videoError = err.message;
                    await saveScene(taskId, sceneIndex, {
                        ...scenesDocs[sceneIndex],
                        imageUrl: scene.imageUrl,
                        videoError: err.message
                    });
                    return { success: false, sceneIndex, error: err.message };
                }
            });

            await Promise.all(videoPromises);

            // Retry failed videos sequentially
            const failedVideoScenes = scenes.filter(s => s.imageUrl && !s.videoUrl && s.videoError);
            if (failedVideoScenes.length > 0 && !signal.aborted) {
                console.log(`📋 Task ${taskId}: retrying ${failedVideoScenes.length} failed videos...`);
                for (const scene of failedVideoScenes) {
                    if (signal.aborted) break;
                    const sceneIndex = scenes.indexOf(scene);
                    try {
                        const videoUrl = await generator.generateVideo(
                            scene.imageUrl, scene.videoPrompt, sceneIndex + 1, config.videoModel
                        );
                        scenes[sceneIndex].videoUrl = videoUrl;
                        scenes[sceneIndex].videoError = null;
                        videosCompleted++;
                        videosFailed--;
                        await saveScene(taskId, sceneIndex, {
                            ...scenesDocs[sceneIndex],
                            imageUrl: scene.imageUrl,
                            videoUrl: videoUrl,
                            videoError: null
                        });
                    } catch (err) {
                        console.error(`Task ${taskId}: retry failed for scene ${sceneIndex + 1}: ${err.message}`);
                    }
                }
            }

            // Charge for successful videos only
            if (videosCompleted > 0) {
                await credits.deductCredits(userId, 'video_generation', videosCompleted,
                    `Background task: ${videosCompleted} videos`);
                totalCreditsCharged += credits.COSTS.video_generation * videosCompleted;
            }
        }

        // Done
        const allSuccess = imagesFailed === 0 && videosFailed === 0;
        await completeTask(taskId, {
            success: allSuccess,
            message: allSuccess
                ? `Generated ${imagesCompleted} images and ${videosCompleted} videos`
                : `Completed with ${imagesFailed} image failures and ${videosFailed} video failures`,
            totalScenes: scenes.length,
            imagesCompleted,
            videosCompleted,
            imagesFailed,
            videosFailed,
            creditsCharged: totalCreditsCharged
        });

        console.log(`📋 Task ${taskId}: complete. Credits charged: ${totalCreditsCharged}`);

    } catch (err) {
        if (err.message === 'Task cancelled') {
            console.log(`📋 Task ${taskId}: cancelled during execution`);
            return; // cancelTask already updated the status
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
        status: { $in: ['completed', 'failed', 'cancelled', 'partial'] },
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
