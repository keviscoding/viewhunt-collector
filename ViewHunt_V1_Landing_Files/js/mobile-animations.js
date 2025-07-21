// Mobile Animations and Micro-interactions
document.addEventListener('DOMContentLoaded', function() {
    // Only enable these animations on mobile devices
    if (window.innerWidth > 768) return;
    
    // Smoother scrolling for iOS
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
        document.body.style.webkitOverflowScrolling = 'touch';
    }
    
    // Optimize animations based on device capabilities
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    
    // Setup scroll-based animations
    function setupAnimations() {
        // Skip if user prefers reduced motion
        if (prefersReducedMotion) return;
        
        // Elements to animate on scroll
        const animateElements = document.querySelectorAll('.fade-in, .fade-in-left, .fade-in-right, .scale-in, .stagger-item');
        
        // IntersectionObserver configuration
        const observerOptions = {
            root: null,
            rootMargin: '0px',
            threshold: 0.15 // Trigger when 15% visible
        };
        
        // Create observer
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('active');
                    
                    // Unobserve after animation is triggered
                    observer.unobserve(entry.target);
                }
            });
        }, observerOptions);
        
        // Observe elements
        animateElements.forEach((el, index) => {
            // Set sequential delays for stagger items
            if (el.classList.contains('stagger-item')) {
                el.style.setProperty('--item-index', index % 10); // Reset after 10 items
            }
            
            observer.observe(el);
        });
    }
    
    // Add tap feedback effects
    function setupTapFeedback() {
        // Elements that should have tap feedback
        const interactiveElements = document.querySelectorAll('a, button, .btn, .feature-card, .pricing-card, .collapsible-header');
        
        interactiveElements.forEach(el => {
            // Add active state on touch start
            el.addEventListener('touchstart', function() {
                this.classList.add('touch-active');
            }, { passive: true });
            
            // Remove active state on touch end
            el.addEventListener('touchend', function() {
                this.classList.remove('touch-active');
            }, { passive: true });
            
            // Also remove on touch cancel
            el.addEventListener('touchcancel', function() {
                this.classList.remove('touch-active');
            }, { passive: true });
        });
    }
    
    // Add subtle parallax effects
    function setupParallax() {
        // Skip if reduced motion is preferred
        if (prefersReducedMotion) return;
        
        // Elements that will have parallax
        const heroTitle = document.querySelector('.hero-title');
        const heroContent = document.querySelector('.hero-content');
        const channelList = document.querySelector('.channel-list-container');
        
        if (heroTitle && heroContent && channelList) {
            // Listen for scroll events
            window.addEventListener('scroll', function() {
                const scrollY = window.scrollY;
                
                // Title moves slightly faster than content
                heroTitle.style.transform = `translateY(${scrollY * 0.1}px)`;
                
                // Channel list moves slightly in opposite direction
                channelList.style.transform = `translateY(${scrollY * -0.05}px)`;
            }, { passive: true });
        }
    }
    
    // Animate CTA button
    function animateCTAButton() {
        // Skip if reduced motion is preferred
        if (prefersReducedMotion) return;
        
        const ctaButtons = document.querySelectorAll('.pulse, .hero-buttons .btn:first-child');
        
        ctaButtons.forEach(btn => {
            // Apply subtle scale animation
            btn.style.animation = 'ctaPulse 3s infinite';
            
            // Add keyframes to the document if they don't exist
            if (!document.querySelector('#cta-animation-keyframes')) {
                const keyframes = document.createElement('style');
                keyframes.id = 'cta-animation-keyframes';
                keyframes.textContent = `
                    @keyframes ctaPulse {
                        0% { transform: scale(1); box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3); }
                        50% { transform: scale(1.03); box-shadow: 0 6px 18px rgba(99, 102, 241, 0.4); }
                        100% { transform: scale(1); box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3); }
                    }
                    
                    .touch-active {
                        transform: scale(0.97) !important;
                        transition: transform 0.15s ease !important;
                    }
                `;
                document.head.appendChild(keyframes);
            }
        });
    }
    
    // Load animations with slight delay to avoid layout thrashing
    setTimeout(() => {
        setupAnimations();
        setupTapFeedback();
        setupParallax();
        animateCTAButton();
    }, 100);
    
    // Reapply on resize
    window.addEventListener('resize', function() {
        if (window.innerWidth <= 768) {
            setupAnimations();
        }
    });
}); 