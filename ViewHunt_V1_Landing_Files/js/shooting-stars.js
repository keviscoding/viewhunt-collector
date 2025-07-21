// Function to generate random shooting stars
function createShootingStars() {
    const starsContainer = document.getElementById('shooting-stars-container');
    if (!starsContainer) return;
    
    // Clear existing stars
    starsContainer.innerHTML = '';
    
    // Create random number of shooting stars (3-7)
    const starCount = Math.floor(Math.random() * 5) + 3;
    
    for (let i = 0; i < starCount; i++) {
        const star = document.createElement('div');
        star.className = 'shooting-star';
        
        // Random position
        const topPos = Math.floor(Math.random() * 80); // 0-80% from top
        const leftPos = Math.floor(Math.random() * 60) + 40; // 40-100% from left
        star.style.top = `${topPos}%`;
        star.style.left = `${leftPos}%`;
        
        // Random delay
        const delay = Math.floor(Math.random() * 15);
        star.style.animationDelay = `${delay}s`;
        
        // Random duration
        const duration = Math.floor(Math.random() * 4) + 3; // 3-7s
        star.style.animationDuration = `${duration}s`;
        
        starsContainer.appendChild(star);
    }
}

// Create shooting stars on load and periodically
document.addEventListener('DOMContentLoaded', function() {
    createShootingStars();
    // Recreate stars every 10 seconds
    setInterval(createShootingStars, 10000);
}); 