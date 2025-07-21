/**
 * Shooting Stars Background Effect
 * Vanilla JavaScript implementation
 */

// Create the static starry background
function createStarryBackground() {
  const starsContainer = document.querySelector('.stars-background');
  if (!starsContainer) return;
  
  const screenWidth = window.innerWidth;
  const screenHeight = window.innerHeight;
  const starCount = 300; // More static stars for better effect
  
  // Remove the twinkling animation styles - we don't need them anymore
  if (document.getElementById('star-styles')) {
    document.getElementById('star-styles').remove();
  }
  
  for (let i = 0; i < starCount; i++) {
    const star = document.createElement('div');
    star.className = 'star';
    
    // Random position
    const xPos = Math.random() * screenWidth;
    const yPos = Math.random() * screenHeight;
    
    // Random size
    const size = Math.random() * 1.8 + 0.4; // Slightly varied sizes
    
    // Random opacity - keep these very subtle
    const opacity = Math.random() * 0.5 + 0.05; // Much more subtle stars
    
    // Set star styles - no animation
    star.style.cssText = `
      position: absolute;
      left: ${xPos}px;
      top: ${yPos}px;
      width: ${size}px;
      height: ${size}px;
      background-color: #ffffff;
      border-radius: 50%;
      opacity: ${opacity};
      box-shadow: 0 0 ${size * 1.5}px rgba(255, 255, 255, 0.3);
      z-index: 0;
    `;
    
    starsContainer.appendChild(star);
  }
}

// Initialize shooting stars animation
class ShootingStars {
  constructor(options = {}) {
    this.container = document.querySelector('.shooting-stars-container');
    if (!this.container) return;
    
    this.starColor = options.starColor || '#ffffff';
    this.trailColor = options.trailColor || '#ffffff';
    this.minSpeed = options.minSpeed || 6;  // Much slower speed
    this.maxSpeed = options.maxSpeed || 15; // Much slower speed
    this.minDelay = options.minDelay || 5000;  // 5-12 seconds between stars
    this.maxDelay = options.maxDelay || 12000;
    this.minSize = options.minSize || 80;
    this.maxSize = options.maxSize || 150;
    this.count = options.count || 0;
    this.maxStars = options.maxStars || 1; // Only 1 star at a time maximum
    this.activeStars = 0;
  }
  
  init() {
    if (!this.container) return;
    
    // Make sure container has proper z-index
    this.container.style.zIndex = "-5";
    
    // Create first star with a longer initial delay
    setTimeout(() => this.createStar(), 3000);
  }
  
  createStar() {
    if (this.activeStars >= this.maxStars) {
      setTimeout(() => this.createStar(), this.getRandomDelay());
      return;
    }
    
    this.activeStars++;
    const star = document.createElement('div');
    star.className = 'shooting-star';
    
    // Random start position (always from top of viewport)
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    
    // Create start position from top-left corner for a more diagonal path
    const startX = -100;
    const startY = Math.random() * (screenHeight * 0.6); // Top 60% of screen
    
    // Diagonal angle with slight downward component
    const angle = Math.random() * 15 + 350; // Between 350-365 degrees (nearly horizontal with slight downward angle)
    const rad = angle * Math.PI / 180;
    
    // Calculate end position (exit right side of screen)
    const distance = screenWidth + 300;
    const endX = startX + distance * Math.cos(rad);
    const endY = startY + distance * Math.sin(rad);
    
    // Random speed and size - much slower now
    const speed = Math.random() * (this.maxSpeed - this.minSpeed) + this.minSpeed;
    const duration = distance / speed * 300; // Make animation MUCH slower (5-10 seconds per star)
    const size = Math.random() * (this.maxSize - this.minSize) + this.minSize;
    
    // Longer, more dramatic gradient with more transparent trail
    const gradient = `linear-gradient(to right, 
      ${this.trailColor}00 0%, 
      ${this.trailColor}10 20%, 
      ${this.trailColor}30 50%, 
      ${this.trailColor}70 80%, 
      ${this.starColor}90 100%)`;
    
    // Style the star - make it more dramatic
    star.style.cssText = `
      position: absolute;
      left: ${startX}px;
      top: ${startY}px;
      width: ${size}px;
      height: 2px;
      background: ${gradient};
      transform: rotate(${angle}deg);
      z-index: 1;
      border-radius: 1px;
      box-shadow: 0 0 8px ${this.starColor}60, 0 0 15px ${this.starColor}40;
      opacity: 0;
      pointer-events: none;
    `;
    
    this.container.appendChild(star);
    
    // Handle animation
    // First make it visible with a fade-in
    setTimeout(() => {
      star.style.opacity = "0.8"; // Slightly brighter
      star.style.transition = "opacity 1s ease-in";
      
      // Then animate it across the screen - much slower
      setTimeout(() => {
        star.style.transition = `transform ${duration}ms cubic-bezier(0.1, 0.4, 0.2, 1), opacity 3s ease-out`;
        star.style.transform = `rotate(${angle}deg) translateX(${distance}px)`;
        star.style.opacity = "0";
        
        // Remove the star after animation completes
        setTimeout(() => {
          star.remove();
          this.activeStars--;
          this.count++;
          
          // Create next star after a longer random delay
          setTimeout(() => this.createStar(), this.getRandomDelay());
        }, duration + 500);
      }, 1000);
    }, 10);
  }
  
  getRandomDelay() {
    return Math.random() * (this.maxDelay - this.minDelay) + this.minDelay;
  }
}

// Automatically initialize background effects when the script loads
document.addEventListener('DOMContentLoaded', function() {
  // Create static starry background
  createStarryBackground();
  
  // Initialize just one shooting star effect with a dramatic color
  // Make it very rare but impressive when it happens
  const shootingStars = new ShootingStars({
    starColor: '#9E00FF',       // Vivid purple
    trailColor: '#2EB9DF',      // Bright blue
    minSpeed: 3,                // Very slow
    maxSpeed: 7,                // Still slow
    minDelay: 15000,            // At least 15 seconds between stars
    maxDelay: 45000,            // Up to 45 seconds wait
    minSize: 100,               // Larger minimum size
    maxSize: 200,               // Larger maximum size
    maxStars: 1                 // Only one at a time
  });
  
  // Initialize star effect
  shootingStars.init();
}); 