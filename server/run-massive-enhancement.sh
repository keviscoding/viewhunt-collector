#!/bin/bash

echo "🚀 MASSIVE DATABASE ENHANCEMENT SCRIPT"
echo "======================================"
echo ""
echo "This will enhance EVERY SINGLE CHANNEL in your database with:"
echo "✨ Recent Avg calculations from last 10 shorts"
echo "🎬 Video previews with clickable thumbnails"
echo "📊 Enhanced analytics and performance data"
echo "🎯 NO VIEW LIMITATIONS - All channels get enhanced!"
echo ""

# Check if environment variables are set
if [ -z "$V2_MONGO_URI" ] && [ -z "$MONGO_URI" ]; then
    echo "❌ Error: MongoDB URI not set. Please set V2_MONGO_URI or MONGO_URI environment variable"
    exit 1
fi

if [ -z "$YOUTUBE_API_KEY" ]; then
    echo "❌ Error: YOUTUBE_API_KEY not set. Please set YOUTUBE_API_KEY environment variable"
    echo "   You can use: export YOUTUBE_API_KEY='your_api_key_here'"
    exit 1
fi

echo "✅ Environment variables configured"
echo ""

# Show quota warning
echo "⚠️  QUOTA WARNING:"
echo "   This script will use ~3 YouTube API quota units per channel"
echo "   With 150K daily quota, you can enhance ~50,000 channels per day"
echo "   🚀 Processing ALL channels regardless of view count!"
echo ""

# Ask for confirmation
read -p "🤔 Are you ready to enhance your entire database? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ Enhancement cancelled"
    exit 1
fi

echo ""
echo "🔥 Starting massive database enhancement..."
echo "📊 This may take 30-60 minutes depending on your database size"
echo ""

# Run the enhancement script
node enhance-all-channels.js

echo ""
echo "🎉 Enhancement process completed!"
echo "🚀 ViewHunt is now fully enhanced with Recent Avg + Video Previews!"