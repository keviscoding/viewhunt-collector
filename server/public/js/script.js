// Countdown Timer
function updateCountdown() {
    const endTime = new Date();
    // Add 3 days to the current time
    endTime.setDate(endTime.getDate() + 3);
    
    // Update the countdown every second
    setInterval(() => {
        const now = new Date();
        const diff = endTime - now;
        
        // Calculate time remaining
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);
        
        // Format the time
        const formattedTime = `${hours}:${minutes < 10 ? '0' + minutes : minutes}:${seconds < 10 ? '0' + seconds : seconds}`;
        
        // Update the timer in the DOM
        const timerElement = document.querySelector('.limited-offer-timer');
        if (timerElement) {
            timerElement.textContent = formattedTime;
        }
    }, 1000);
}

// Pricing Toggle Functionality
function initializePricingToggle() {
    const toggle = document.querySelector('.switch-toggle');
    const monthlyLabel = document.querySelector('.switch-label:first-child');
    const annualLabel = document.querySelector('.switch-label:last-child');
    
    if (toggle && monthlyLabel && annualLabel) {
        toggle.addEventListener('click', () => {
            toggle.classList.toggle('active');
            monthlyLabel.classList.toggle('active');
            annualLabel.classList.toggle('active');
            
            // Here you could also update pricing values if needed
            // For example, switch between monthly and annual prices
        });
    }
}

// Video Play on Scroll
function initVideoPlayOnScroll() {
    const video = document.getElementById('demoVideo');
    if (!video) return;
    
    // Check if video is in viewport
    const isInViewport = (element) => {
        const rect = element.getBoundingClientRect();
        return (
            rect.top <= (window.innerHeight || document.documentElement.clientHeight) * 0.8 &&
            rect.bottom >= 0
        );
    };
    
    // Function to handle scroll
    const handleScroll = () => {
        if (isInViewport(video)) {
            // Use try-catch to handle potential browser issues with video playback
            try {
                if (video.paused) {
                    // Check if browser allows autoplay
                    const playPromise = video.play();
                    
                    if (playPromise !== undefined) {
                        playPromise.catch(error => {
                            console.log("Autoplay prevented by browser:", error);
                            // We'll add a play button overlay if autoplay is blocked
                            addPlayButton(video);
                        });
                    }
                }
            } catch (err) {
                console.log("Video play error:", err);
            }
        }
    };
    
    // Add a play button if autoplay is blocked
    const addPlayButton = (videoElement) => {
        // Check if play button already exists
        if (document.querySelector('.video-play-button')) return;
        
        const playButton = document.createElement('button');
        playButton.className = 'video-play-button';
        playButton.innerHTML = '▶';
        playButton.setAttribute('aria-label', 'Play Demo Video');
        playButton.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(99, 102, 241, 0.8);
            color: white;
            border: none;
            border-radius: 50%;
            width: 60px;
            height: 60px;
            font-size: 24px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10;
        `;
        
        // Add the button to the video container
        const videoContainer = videoElement.parentElement;
        videoContainer.style.position = 'relative';
        videoContainer.appendChild(playButton);
        
        // Add click event to play video
        playButton.addEventListener('click', () => {
            videoElement.play()
                .then(() => {
                    playButton.remove();
                })
                .catch(err => {
                    console.log("Play error:", err);
                    // If still fails, we leave the button there
                });
        });
    };
    
    // Add scroll event listener
    window.addEventListener('scroll', handleScroll);
    
    // Check on page load with a slight delay to ensure DOM is ready
    setTimeout(handleScroll, 1000);
}

// Scroll Animation
function initScrollAnimations() {
    const animatedElements = document.querySelectorAll(
        '.fade-in, .fade-in-left, .fade-in-right, .scale-in'
    );
    
    // Set stagger delays for elements that should have sequential animations
    const staggerContainers = document.querySelectorAll('.stagger-container');
    staggerContainers.forEach(container => {
        const staggerItems = container.querySelectorAll('.stagger-item');
        staggerItems.forEach((item, index) => {
            item.style.setProperty('--item-index', index);
        });
    });
    
    // Check if element is in viewport
    const isInViewport = (element, offset = 0.2) => {
        const rect = element.getBoundingClientRect();
        const windowHeight = window.innerHeight || document.documentElement.clientHeight;
        
        // Element is considered in viewport when it's top is 20% into the viewport by default
        return (
            rect.top <= windowHeight * (1 - offset) && 
            rect.bottom >= 0
        );
    };
    
    // Function to check which elements are visible on scroll
    const checkVisibility = () => {
        animatedElements.forEach(element => {
            if (isInViewport(element)) {
                element.classList.add('active');
            }
        });
    };
    
    // Use requestAnimationFrame for better performance
    let ticking = false;
    window.addEventListener('scroll', () => {
        if (!ticking) {
            window.requestAnimationFrame(() => {
                checkVisibility();
                ticking = false;
            });
            ticking = true;
        }
    });
    
    // Check visibility on initial load
    checkVisibility();
}

// When the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
    try {
        // Initialize all components
        updateCountdown();
        initializePricingToggle();
        initScrollAnimations();
        initVideoPlayOnScroll();
        
        // Smooth scrolling for anchor links
        document.querySelectorAll('a[href^="#"]').forEach(anchor => {
            anchor.addEventListener('click', function(e) {
                e.preventDefault();
                
                const targetId = this.getAttribute('href');
                if (targetId === "#") return; // Skip for links with just "#"
                
                const targetElement = document.querySelector(targetId);
                if (targetElement) {
                    window.scrollTo({
                        top: targetElement.offsetTop,
                        behavior: 'smooth'
                    });
                }
            });
        });

        // --- PROMO CODE EVENT LISTENERS REMOVED --- 

    } catch (err) {
        console.error("Initialization error:", err);
        // Continue execution despite errors
    }
}); 

// --- initiateCheckout FUNCTION REMOVED --- 