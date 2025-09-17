#!/bin/bash

echo "🚀 Starting background enhancement of recent channels..."
echo "This will find the last 500 channels with 500K+ avg views and add enhanced data"
echo ""

# Check if environment variables are set
if [ -z "$V2_MONGO_URI" ] && [ -z "$MONGO_URI" ]; then
    echo "❌ Error: MongoDB URI not set. Please set V2_MONGO_URI or MONGO_URI environment variable"
    exit 1
fi

if [ -z "$APIFY_TOKEN" ]; then
    echo "❌ Error: APIFY_TOKEN not set. Please set APIFY_TOKEN environment variable"
    exit 1
fi

echo "✅ Environment variables configured"
echo "📊 Starting enhancement process..."
echo ""

# Run the enhancement script
node enhance-recent-channels.js

echo ""
echo "🎉 Enhancement process completed!"