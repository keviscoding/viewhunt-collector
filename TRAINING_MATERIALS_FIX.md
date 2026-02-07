# Training Materials Fix Plan

## Problem
Training materials (images/videos) uploaded to Anthropic Files API are not being used because:
1. Cache file gets wiped on DigitalOcean deployments (ephemeral filesystem)
2. The API format for referencing files in Claude messages was incorrect

## Solution

### Part 1: Store File IDs in MongoDB (Persistent)
Instead of storing in a JSON file, store in MongoDB which persists across deployments.

**Implementation:**
- Modify upload endpoint to save file IDs to MongoDB
- Modify generator to load file IDs from MongoDB
- Collection: `training_materials` with document structure:
```json
{
  "type": "skeleton-anatomy-v2",
  "uploadedAt": "2026-02-06T...",
  "images": [
    { "name": "...", "fileId": "file-xxx", "mimeType": "image/png" }
  ],
  "videos": [
    { "name": "...", "fileId": "file-yyy", "mimeType": "video/mp4" }
  ]
}
```

### Part 2: Use Correct API Format
According to Anthropic docs, files should be referenced as:

**For Images:**
```javascript
{
  type: 'image',
  source: {
    type: 'url',
    url: 'https://...'  // OR use file_id if uploaded
  }
}
```

**For Documents (PDFs, videos, etc):**
```javascript
{
  type: 'document',
  source: {
    type: 'url',
    url: 'https://...'
  }
}
```

**Note:** The `file` source type with `file_id` may not be supported yet. We should:
1. Try using URLs directly (download from Anthropic and re-upload to our CDN)
2. Or wait for Anthropic to fully support file_id references

### Part 3: Alternative Approach (Simpler)
Since the embedded master prompt already has all the rules, we could:
1. Skip training materials for now
2. Focus on refining the master prompt with more detailed examples
3. Add training materials later when Anthropic's Files API is more stable

## Recommendation
For now, continue with the embedded master prompt (which is working well). Add training materials support later as a v2.1 feature when:
- Anthropic's Files API format is clearer
- We have time to properly test it
- The current results need improvement

The master prompt already contains all the key rules and guidelines, so Claude should generate good prompts even without seeing the actual training videos.
