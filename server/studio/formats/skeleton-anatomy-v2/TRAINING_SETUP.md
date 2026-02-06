# Training Materials Setup

## Problem
DigitalOcean's filesystem is ephemeral - files get wiped on each deployment. The training materials cache needs to be re-uploaded after every deployment.

## Solution Options

### Option 1: Re-upload after each deployment (Current)
1. After each deployment, go to: https://viewhunt.app/api/studio/upload-training-form
2. Select all files from your `training-upload` folder
3. Click "Upload to Anthropic"
4. Wait 2-3 minutes for upload to complete

**Pros**: Simple, no code changes needed
**Cons**: Manual step after each deployment

### Option 2: Store file IDs in environment variables (Recommended)
After uploading once, copy the file IDs from the cache and add them to DigitalOcean environment variables.

**Implementation**: Add to `.env`:
```
TRAINING_IMAGE_IDS=file-abc123,file-def456,...
TRAINING_VIDEO_IDS=file-ghi789,file-jkl012,...
```

Then modify `loadTrainingImages()` to read from env vars if cache file doesn't exist.

### Option 3: Store in MongoDB (Best for production)
Store the training file IDs in MongoDB so they persist across deployments.

## Current Status
Using Option 1 - manual re-upload after deployments.

## Next Steps
If you deploy frequently, implement Option 2 or 3 for automatic persistence.
