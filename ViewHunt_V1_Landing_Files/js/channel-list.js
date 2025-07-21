document.addEventListener('DOMContentLoaded', function() {
    // Get the channel list container
    const channelList = document.querySelector('.channel-list-inner');
    
    if (!channelList) return;
    
    // Clone the list items to create a seamless loop
    const items = channelList.querySelectorAll('.channel-item');
    const itemsArray = Array.from(items);
    
    // Clone the items and append them to create a seamless loop
    itemsArray.forEach(item => {
        const clone = item.cloneNode(true);
        channelList.appendChild(clone);
    });
    
    // Set animation duration based on the number of items
    channelList.style.animationDuration = `${items.length * 2}s`;
}); 