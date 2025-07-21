// Mobile Navigation Enhancements
document.addEventListener('DOMContentLoaded', function() {
    // Create mobile menu elements
    function setupMobileMenu() {
        // Only setup if we're on mobile and elements don't already exist
        if (window.innerWidth > 768 || document.querySelector('.mobile-menu-toggle')) return;
        
        const header = document.querySelector('header .header-container');
        const nav = document.querySelector('.nav');
        
        if (!header || !nav) return;
        
        // Create hamburger toggle
        const toggle = document.createElement('div');
        toggle.className = 'mobile-menu-toggle';
        toggle.innerHTML = `
            <span></span>
            <span></span>
            <span></span>
            <span></span>
        `;
        
        // Create backdrop
        const backdrop = document.createElement('div');
        backdrop.className = 'mobile-backdrop';
        
        // Add to DOM
        header.appendChild(toggle);
        document.body.appendChild(backdrop);
        
        // Handle menu toggle
        toggle.addEventListener('click', function() {
            toggle.classList.toggle('open');
            nav.classList.toggle('open');
            backdrop.classList.toggle('visible');
            
            // Prevent body scrolling when menu is open
            document.body.style.overflow = nav.classList.contains('open') ? 'hidden' : '';
        });
        
        // Close menu when backdrop is clicked
        backdrop.addEventListener('click', function() {
            toggle.classList.remove('open');
            nav.classList.remove('open');
            backdrop.classList.remove('visible');
            document.body.style.overflow = '';
        });
        
        // Close menu when nav links are clicked
        const navLinks = nav.querySelectorAll('a');
        navLinks.forEach(link => {
            link.addEventListener('click', function() {
                toggle.classList.remove('open');
                nav.classList.remove('open');
                backdrop.classList.remove('visible');
                document.body.style.overflow = '';
            });
        });
    }
    
    // Setup swipe hints for horizontal scrollable content
    function setupSwipeHints() {
        if (window.innerWidth > 768) return;
        
        const scrollableContainers = [
            '.channel-list-container'
        ];
        
        scrollableContainers.forEach(containerSelector => {
            const container = document.querySelector(containerSelector);
            if (!container || container.querySelector('.swipe-hint')) return;
            
            const swipeHint = document.createElement('div');
            swipeHint.className = 'swipe-hint';
            
            // Insert after the container
            container.parentNode.insertBefore(swipeHint, container.nextSibling);
            
            // Remove the hint after user has interacted with the container
            let hasInteracted = false;
            container.addEventListener('touchstart', function() {
                if (!hasInteracted) {
                    swipeHint.style.opacity = '0';
                    setTimeout(() => {
                        swipeHint.remove();
                    }, 500);
                    hasInteracted = true;
                }
            });
        });
    }
    
    // Add additional step indicators for How It Works section on mobile
    function enhanceStepsSection() {
        if (window.innerWidth > 768) return;
        
        const steps = document.querySelectorAll('.step');
        
        steps.forEach((step, index) => {
            // Skip if already enhanced
            if (step.querySelector('.step-content')) return;
            
            // Restructure the step for mobile
            const title = step.querySelector('.step-title');
            const description = step.querySelector('.step-description');
            const number = step.querySelector('.step-number');
            
            if (!title || !description || !number) return;
            
            // Create content container
            const content = document.createElement('div');
            content.className = 'step-content';
            
            // Move title and description into content container
            content.appendChild(title.cloneNode(true));
            content.appendChild(description.cloneNode(true));
            
            // Clear and rebuild step
            step.innerHTML = '';
            step.appendChild(number);
            step.appendChild(content);
        });
    }
    
    // Create sticky footer CTAs for mobile
    function createStickyFooterCTA() {
        if (window.innerWidth > 768 || document.querySelector('.mobile-sticky-cta')) return;
        
        const mobileCTA = document.createElement('div');
        mobileCTA.className = 'mobile-sticky-cta';
        mobileCTA.innerHTML = `
            <a href="#pricing" class="btn">Get Started</a>
        `;
        
        document.body.appendChild(mobileCTA);
        
        // Hide when footer is visible (scroll listener)
        const footer = document.querySelector('footer');
        if (footer) {
            window.addEventListener('scroll', function() {
                const footerRect = footer.getBoundingClientRect();
                const isFooterVisible = footerRect.top < window.innerHeight;
                
                mobileCTA.style.transform = isFooterVisible ? 'translateY(100%)' : 'translateY(0)';
            });
        }
    }
    
    // Run all enhancements
    function enhanceMobileExperience() {
        setupMobileMenu();
        setupSwipeHints();
        enhanceStepsSection();
        createStickyFooterCTA();
    }
    
    // Run initially
    enhanceMobileExperience();
    
    // Update on resize
    window.addEventListener('resize', function() {
        enhanceMobileExperience();
    });
}); 