// Script to replace the stickman placeholder with a video that plays only when scrolled into view
document.addEventListener('DOMContentLoaded', function() {
    // Target the problem section with "The Endless Scroll Ends Here" heading
    const problemSection = document.querySelector('.problem');
    if (!problemSection) return;
    
    // Find the problem-image container that has the stickman SVG
    const targetContainer = problemSection.querySelector('.problem-image');
    if (!targetContainer) return;
    
    // Create video element
    const videoContainer = document.createElement('div');
    videoContainer.className = 'problem-video';
    videoContainer.style.cssText = `
        width: 100%;
        height: auto;
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
        position: relative;
        margin: 0 auto;
    `;
    
    // Create the video element
    const video = document.createElement('video');
    video.src = '/videos/first-placeholder1.mp4';
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.controls = false;
    // Don't autoplay initially
    video.autoplay = false;
    video.style.cssText = `
        width: 100%;
        height: auto;
        object-fit: cover;
        border-radius: 12px;
        display: block;
    `;
    
    // Create play/pause functionality on click
    video.addEventListener('click', function() {
        if (video.paused) {
            video.play();
        } else {
            video.pause();
        }
    });
    
    // Add video to container
    videoContainer.appendChild(video);
    
    // Replace the existing content
    targetContainer.innerHTML = '';
    targetContainer.appendChild(videoContainer);
    
    // Set up Intersection Observer to play video when it becomes visible
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            // If video is at least 50% visible in the viewport
            if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
                video.play().catch(e => console.error('Error playing video:', e));
            } else {
                video.pause();
            }
        });
    }, {
        threshold: 0.5 // Trigger when 50% of the video is visible
    });
    
    // Start observing the video element
    observer.observe(video);
}); 