// Script to replace the stickman SVG with video in the problem section
document.addEventListener('DOMContentLoaded', function() {
    // Target specifically the problem section containing "Endless Scroll Ends Here"
    const problemTitle = Array.from(document.querySelectorAll('.section-title')).find(
        title => title.textContent.includes('Endless Scroll')
    );
    if (!problemTitle) return;
    
    // Find the problem section containing this title
    const problemSection = problemTitle.closest('.problem');
    if (!problemSection) return;
    
    // Find the problem-image container that has the SVG
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
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.controls = false;
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
    
    // Ensure video starts playing
    video.play().catch(e => console.error('Error playing video:', e));
}); 