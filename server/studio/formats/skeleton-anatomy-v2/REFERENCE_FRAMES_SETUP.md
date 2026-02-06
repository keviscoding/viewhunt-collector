# Reference Frames Setup - Anthropic Files API

## Overview

This system uploads your reference frames to Anthropic's Files API once, then includes them in every Claude API call so Claude can see and learn from your visual style.

## The Flow

```
┌─────────────────────────────────────────────────────────────┐
│ PART 1: ONE-TIME SETUP (run once)                          │
└─────────────────────────────────────────────────────────────┘

1. Put reference frames in: training-upload/images/
2. Run: node upload-references.js
3. Get: reference-file-ids.json (saved automatically)

┌─────────────────────────────────────────────────────────────┐
│ PART 2: EVERY TIME A USER SUBMITS A SCRIPT                 │
└─────────────────────────────────────────────────────────────┘

1. User submits script
2. Generator loads reference-file-ids.json
3. Sends to Claude:
   - System prompt (DR_DATA style guide)
   - Reference frame IDs (Claude sees all frames)
   - User's script
4. Claude returns scene prompts (informed by reference frames)
```

## Setup Instructions

### Step 1: Prepare Reference Frames

Put all your reference frames (screenshots from videos) in:
```
training-upload/images/
```

Supported formats: `.png`, `.jpg`, `.jpeg`

### Step 2: Upload to Anthropic (One-Time)

```bash
cd temp-viewhunt/server/studio/formats/skeleton-anatomy-v2
node upload-references.js
```

This will:
- Upload all images to Anthropic Files API
- Save file IDs to `reference-file-ids.json`
- Take ~5-10 minutes for 74 images

**Output:**
```
🎬 Starting reference frame upload to Anthropic Files API...

Found 74 reference frames to upload

[1/74] Uploading Screenshot 2026-02-06 at 12.05.55.png...
✅ Uploaded: file-abc123...
[2/74] Uploading Screenshot 2026-02-06 at 12.05.59.png...
✅ Uploaded: file-def456...
...

✅ Upload complete!
   Success: 74
   Failed: 0
   File IDs saved to: reference-file-ids.json
```

### Step 3: Deploy to DigitalOcean

The `reference-file-ids.json` file needs to be on your server:

```bash
# Commit the file
git add server/studio/formats/skeleton-anatomy-v2/reference-file-ids.json
git commit -m "Add reference frame IDs for Claude"
git push origin main
```

DigitalOcean will deploy automatically.

### Step 4: Test

Generate a video at https://viewhunt.app/studio/v2

Check server logs for:
```
✅ Loaded 74 reference frame IDs
   Uploaded at: 2026-02-06T...
Including 74 reference frames for Claude to analyze...
```

## How It Works

### Upload Script (`upload-references.js`)

```javascript
// For each image file:
const file = new File([fileBuffer], filename, { type: 'image/png' });
const uploadedFile = await anthropic.files.create({
    file: file,
    purpose: 'vision'
});

// Save file ID
{ filename: "...", fileId: "file-abc123..." }
```

### Generator (`generator.js`)

```javascript
// Load reference IDs
this.trainingImages = this.loadTrainingImages();
// Returns: { files: [{ filename, fileId, uploadedAt }] }

// Include in Claude API call
const content = [];
for (const file of this.trainingImages.files) {
    content.push({
        type: 'image',
        source: {
            type: 'file',
            file_id: file.fileId
        }
    });
}

// Add instruction
content.push({
    type: 'text',
    text: 'Study these reference frames carefully...'
});

// Add user prompt
content.push({
    type: 'text',
    text: `Generate prompts for this script: ${script}`
});

// Send to Claude
await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    system: masterPrompt,
    messages: [{ role: 'user', content: content }]
});
```

## File Structure

```
server/studio/formats/skeleton-anatomy-v2/
├── upload-references.js          # One-time upload script
├── reference-file-ids.json       # Generated file IDs (commit this)
├── generator.js                  # Uses file IDs in API calls
└── REFERENCE_FRAMES_SETUP.md    # This file
```

## Benefits

✅ **Claude sees your actual reference frames** - not just text descriptions
✅ **One-time upload** - file IDs persist forever
✅ **No re-upload needed** - IDs work across all API calls
✅ **Better prompts** - Claude learns from visual examples
✅ **Consistent style** - matches your reference videos exactly

## Troubleshooting

### "No reference file IDs found"

Run the upload script:
```bash
node upload-references.js
```

### "Reference frames directory not found"

Make sure `training-upload/images/` exists with your frames:
```bash
ls -la ../../../../../../training-upload/images/
```

### "Failed to upload"

Check your `ANTHROPIC_API_KEY`:
```bash
echo $ANTHROPIC_API_KEY
```

### "File IDs not working in API calls"

Check the file format in `reference-file-ids.json`:
```json
{
  "uploadedAt": "2026-02-06T...",
  "totalFiles": 74,
  "files": [
    {
      "filename": "Screenshot...",
      "fileId": "file-abc123...",
      "uploadedAt": "2026-02-06T..."
    }
  ]
}
```

## Cost

- **Upload:** Free (one-time)
- **Storage:** Free (Anthropic hosts the files)
- **API calls:** Same as before (file IDs don't add cost)

## Limits

- **Max files per call:** 100 images (we have 74, so we're good)
- **File size:** 5MB per image (screenshots are ~100KB, so we're good)
- **File retention:** Permanent (files don't expire)

## Summary

1. Run `upload-references.js` once
2. Commit `reference-file-ids.json`
3. Deploy to DigitalOcean
4. Claude now sees your reference frames in every API call!

That's it. Simple, permanent, and effective.
