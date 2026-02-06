#!/bin/bash
# Setup script to run on server deployment
# This will cache training images for Claude vision

echo "🎨 Setting up training images..."

# Run the upload script
node "$(dirname "$0")/upload-training-images.js"

echo "✅ Training images setup complete!"
