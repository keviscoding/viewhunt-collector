// Mobile Scroll Progress Indicator
document.addEventListener('DOMContentLoaded', function() {
    // Only run on mobile devices
    if (window.innerWidth > 768) return;
    
    // Create the progress bar element
    function createProgressBar() {
        // Skip if already exists
        if (document.querySelector('.mobile-scroll-progress')) return;
        
        const progressBar = document.createElement('div');
        progressBar.className = 'mobile-scroll-progress';
        document.body.appendChild(progressBar);
        
        return progressBar;
    }
    
    // Update the progress bar width based on scroll position
    function updateProgressBar() {
        const progressBar = document.querySelector('.mobile-scroll-progress');
        if (!progressBar) return;
        
        // Calculate how far down the page the user has scrolled
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const scrollHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
        const scrollPercent = (scrollTop / scrollHeight) * 100;
        
        // Update the progress bar width
        progressBar.style.setProperty('--scroll-width', `${scrollPercent}%`);
        progressBar.querySelector('::after').style.width = `${scrollPercent}%`;
    }
    
    // Initialize scroll progress tracking
    function initScrollProgress() {
        const progressBar = createProgressBar();
        
        // Set up scroll event listener
        window.addEventListener('scroll', function() {
            // Use requestAnimationFrame to avoid performance issues
            window.requestAnimationFrame(updateProgressBar);
        }, { passive: true });
        
        // Initial update
        updateProgressBar();
    }
    
    // Create "back to top" button that appears after scrolling
    function createBackToTopButton() {
        // Skip if already exists
        if (document.querySelector('.back-to-top')) return;
        
        const backToTopBtn = document.createElement('button');
        backToTopBtn.className = 'back-to-top';
        backToTopBtn.innerHTML = '↑';
        backToTopBtn.setAttribute('aria-label', 'Back to top');
        
        // Initially hidden
        backToTopBtn.style.opacity = '0';
        backToTopBtn.style.visibility = 'hidden';
        
        document.body.appendChild(backToTopBtn);
        
        // Show/hide based on scroll position
        window.addEventListener('scroll', function() {
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
            
            if (scrollTop > window.innerHeight / 2) {
                backToTopBtn.style.opacity = '1';
                backToTopBtn.style.visibility = 'visible';
            } else {
                backToTopBtn.style.opacity = '0';
                backToTopBtn.style.visibility = 'hidden';
            }
        }, { passive: true });
        
        // Scroll to top when clicked
        backToTopBtn.addEventListener('click', function(e) {
            e.preventDefault();
            window.scrollTo({
                top: 0,
                behavior: 'smooth'
            });
        });
    }
    
    // Add styles for progress bar and back to top button
    function addStyles() {
        // Skip if already added
        if (document.querySelector('#mobile-progress-styles')) return;
        
        const styles = document.createElement('style');
        styles.id = 'mobile-progress-styles';
        styles.textContent = `
            .mobile-scroll-progress {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 3px;
                background: rgba(255, 255, 255, 0.1);
                z-index: 101;
                pointer-events: none;
            }
            
            .mobile-scroll-progress::after {
                content: '';
                position: absolute;
                top: 0;
                left: 0;
                height: 100%;
                width: var(--scroll-width, 0%);
                background: linear-gradient(90deg, #4F46E5 0%, #6366F1 100%);
                transition: width 0.1s ease;
            }
            
            .back-to-top {
                position: fixed;
                bottom: 80px;
                right: 20px;
                width: 40px;
                height: 40px;
                border-radius: 50%;
                background: rgba(99, 102, 241, 0.9);
                color: white;
                border: none;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 18px;
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
                cursor: pointer;
                z-index: 90;
                opacity: 0;
                visibility: hidden;
                transition: all 0.3s ease;
            }
        `;
        
        document.head.appendChild(styles);
    }
    
    // Initialize all features
    function init() {
        addStyles();
        initScrollProgress();
        createBackToTopButton();
    }
    
    // Run initialization
    init();
}); 