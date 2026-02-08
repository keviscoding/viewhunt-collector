#!/bin/bash
# Generate a short click/pop sound effect using FFmpeg
# Run this once to create the click.mp3 asset
ffmpeg -f lavfi -i "sine=frequency=800:duration=0.05" -af "afade=t=out:st=0.02:d=0.03,volume=2" -y click.mp3
echo "✅ click.mp3 generated"
