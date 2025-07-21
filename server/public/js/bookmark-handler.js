// Bookmark handler functionality V2 (Event Delegation)
document.addEventListener('DOMContentLoaded', function() {
  console.log("Bookmark Handler V2 (Event Delegation) Loaded.");

  // Attach one listener to a static parent (e.g., document.body or a main container)
  document.body.addEventListener('click', async function(event) {
    // Check if the clicked element or its ancestor is a bookmark button
    const bookmarkButton = event.target.closest('.bookmark-btn');

    if (bookmarkButton) {
      event.preventDefault();
      event.stopPropagation();
      console.log("Bookmark button clicked via delegation.");

      const channelId = bookmarkButton.getAttribute('data-id');
      if (!channelId) {
        console.error('No channel ID found on bookmark button');
        return;
      }

      // If the button is on the saved-channels page and already active, this means unbookmark
      // For other pages, the initial state is "not saved" visually for dynamic buttons.
      // The API call will toggle and return the true state.

      try {
        const response = await fetch('/channels/save', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ channelId }),
        });

        if (!response.ok) {
          throw new Error(`Server returned ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();

        if (result.success) {
          if (result.saved) {
            bookmarkButton.classList.add('active');
            bookmarkButton.innerHTML = '<i class="fas fa-bookmark"></i>';
            bookmarkButton.title = 'Remove from saved';
          } else {
            bookmarkButton.classList.remove('active');
            bookmarkButton.innerHTML = '<i class="far fa-bookmark"></i>';
            bookmarkButton.title = 'Save channel';
            // If on saved-channels page and item is removed, you might want to hide/remove the card
            if (window.location.pathname.includes('/saved-channels')) {
              const card = bookmarkButton.closest('.channel-card, .random-channel-card'); // Adjust selector if needed
              if (card) card.remove();
            }
          }
        } else {
          console.error('Error from server:', result.message);
          alert('Error: ' + result.message);
        }
      } catch (error) {
        console.error('Error saving/unsaving channel:', error);
        alert('An error occurred. Please try again.');
      }
    }
  });

  // Initial check for statically loaded bookmark buttons 
  // (e.g., on /app if channels are rendered server-side initially, or on /saved-channels)
  const initialBookmarkButtons = document.querySelectorAll('.bookmark-btn');
  initialBookmarkButtons.forEach(btn => {
    const channelId = btn.getAttribute('data-id');
    checkSavedStatus(btn, channelId); 
  });

  async function checkSavedStatus(buttonElement, channelId) {
    if (!channelId || !buttonElement) return;
    // Avoid re-checking if it's already part of a delegated click that will update it
    // This is mainly for initial load of static buttons.

    try {
      const response = await fetch(`/channels/is-saved/${channelId}`);
      if (!response.ok) {
        // Don't throw an error that stops other things, just log it for this non-critical check
        console.warn(`Could not check saved status for ${channelId}: ${response.statusText}`);
        return;
      }
      const result = await response.json();
      if (result.success && result.saved) {
        buttonElement.classList.add('active');
        buttonElement.innerHTML = '<i class="fas fa-bookmark"></i>';
        buttonElement.title = 'Remove from saved';
      } else {
        buttonElement.classList.remove('active');
        buttonElement.innerHTML = '<i class="far fa-bookmark"></i>';
        buttonElement.title = 'Save channel';
      }
    } catch (error) {
      console.warn('Error during initial checkSavedStatus:', error);
    }
  }
}); 