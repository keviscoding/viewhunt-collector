// Fix to disable mobile progress bar
document.addEventListener('DOMContentLoaded', function() {
    // Disable the mobile progress bar functionality
    const progressBar = document.querySelector('.mobile-scroll-progress');
    if (progressBar) {
        progressBar.style.display = 'none';
    }
    
    // Remove any swipe hints that might be causing the loading bars
    const swipeHints = document.querySelectorAll('.swipe-hint');
    swipeHints.forEach(hint => {
        if (hint) hint.parentNode.removeChild(hint);
    });
});

