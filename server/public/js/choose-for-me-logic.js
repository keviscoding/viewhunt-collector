document.addEventListener('DOMContentLoaded', function() {
  console.log('Choose For Me Logic Loaded (choose-for-me-logic.js V4.3.4)');

  const modal = document.getElementById('choose-for-me-modal');
  const chooseForMeBtn = document.getElementById('choose-for-me-btn');
  const closeModalBtn = document.querySelector('.close-modal');
  const animationStage = document.getElementById('animation-stage');
  const resultsStage = document.getElementById('results-stage');
  const loadingProgress = document.querySelector('.loading-progress');
  const tryAgainBtn = document.querySelector('.try-again-btn');
  const loadingText = document.querySelector('.loading-text');
  const diceElements = document.querySelectorAll('.dice');
  const randomChannelsContainer = document.getElementById('random-channels-container');

  let criticalElementMissing = false;
  const elements = {
    modal, chooseForMeBtn, closeModalBtn, animationStage, resultsStage,
    loadingProgress, tryAgainBtn, loadingText, randomChannelsContainer
  };
  const elementNames = Object.keys(elements);

  for (const name of elementNames) {
    if (!elements[name]) {
      console.error(`Choose For Me V4.3.4: Element '${name}' NOT FOUND.`);
      criticalElementMissing = true;
    } else {
      // console.log(`Choose For Me: Element '${name}' found.`);
    }
  }
  if (!diceElements || diceElements.length === 0) {
      console.error(`Choose For Me V4.3.4: Element 'diceElements' (querySelectorAll .dice) NOT FOUND or empty.`);
      criticalElementMissing = true;
  }

  if (criticalElementMissing) {
    console.error('Choose For Me V4.3.4: One or more critical modal elements missing. Button functionality will be disabled.');
    if (chooseForMeBtn) {
        chooseForMeBtn.disabled = true;
        chooseForMeBtn.title = "Choose For Me feature is currently unavailable.";
    }
    return; 
  }

  // Open modal when Choose For Me button is clicked
  chooseForMeBtn.addEventListener('click', function() {
    console.log('Choose For Me button clicked - opening modal.');
    modal.style.display = 'block';
    animationStage.style.display = 'block';
    resultsStage.style.display = 'none';
    startChooseForMeAnimation();
  });

  // Close modal when X is clicked
  closeModalBtn.addEventListener('click', function() {
    modal.style.display = 'none';
  });

  // Close modal when clicking outside of it
  window.addEventListener('click', function(event) {
    if (event.target === modal) {
      modal.style.display = 'none';
    }
  });

  // Try Again button
  tryAgainBtn.addEventListener('click', function() {
    animationStage.style.display = 'block';
    resultsStage.style.display = 'none';
    startChooseForMeAnimation();
  });

  function startChooseForMeAnimation() {
    if (!loadingProgress || !diceElements.length || !loadingText) {
        console.error("Choose For Me V4.3.4: Animation elements missing.");
        if(loadingText) loadingText.textContent = "Animation error. Please try again.";
        if(animationStage) animationStage.style.display = 'none'; 
        if(resultsStage) resultsStage.style.display = 'block'; 
        if(randomChannelsContainer) randomChannelsContainer.innerHTML = '<p style="color:red;">Animation error.</p>';
        return;
    }
    loadingProgress.style.width = '0%';
    diceElements.forEach(dice => { dice.classList.add('rolling'); });

    const loadingTexts = [
      "Analyzing over 1,000 channels...",
      "Checking view-to-sub ratios...",
      "Finding untapped niches...",
      "Filtering for faceless potential...",
      "Identifying growth patterns..."
    ];
    let textIndex = 0;
    const textInterval = setInterval(() => {
      loadingText.textContent = loadingTexts[textIndex % loadingTexts.length];
      textIndex++;
    }, 1200);

    let progress = 0;
    const progressInterval = setInterval(() => {
      progress += 2;
      loadingProgress.style.width = `${progress}%`;
      if (progress >= 100) {
        clearInterval(progressInterval);
        clearInterval(textInterval);
        fetchRandomChannels();
      }
    }, 60);
  }

  function fetchRandomChannels() {
    const recentlyShownChannels = localStorage.getItem('recentlyShownChannels') 
      ? JSON.parse(localStorage.getItem('recentlyShownChannels')) 
      : [];
    const excludeParam = recentlyShownChannels.length > 0 
      ? `?exclude=${recentlyShownChannels.join(',')}` 
      : '';

    fetch(`/api/choose-for-me${excludeParam}`)
      .then(response => {
          if (!response.ok) { throw new Error('Network response was not ok: ' + response.statusText); }
          return response.json();
      })
      .then(data => {
        if (data.success && data.channels && data.channels.length > 0) {
          displayRandomChannels(data.channels);
          const newChannelIds = data.channels.map(channel => channel.channelId);
          const updatedHistory = [...newChannelIds, ...recentlyShownChannels].slice(0, 9);
          localStorage.setItem('recentlyShownChannels', JSON.stringify(updatedHistory));
          animationStage.style.display = 'none';
          resultsStage.style.display = 'block';
          diceElements.forEach(dice => { dice.classList.remove('rolling'); });
        } else {
          console.error('V4.3.4: Error fetching random channels or no channels returned', data.message || '');
          if(loadingText) loadingText.textContent = data.message || "No channels found. Please try again.";
           if(randomChannelsContainer) randomChannelsContainer.innerHTML = `<p style="color:orange;">${data.message || "No suitable channels found this time. Try adjusting filters or try again later!"}</p>`;
           if(animationStage) animationStage.style.display = 'none'; 
           if(resultsStage) resultsStage.style.display = 'block'; 
        }
      })
      .catch(error => {
        console.error('V4.3.4 Fetch Error:', error);
        if(loadingText) loadingText.textContent = "Error fetching channels. Please try again.";
        if(randomChannelsContainer) randomChannelsContainer.innerHTML = '<p style="color:red;">Could not fetch channels. Please check your connection and try again.</p>';
        if(animationStage) animationStage.style.display = 'none'; 
        if(resultsStage) resultsStage.style.display = 'block'; 
      });
  }

  function displayRandomChannels(channels) {
    if (!randomChannelsContainer) { console.error("Choose For Me V4.3.4: random-channels-container not found for display!"); return; }
    randomChannelsContainer.innerHTML = ''; 

    function formatDisplayNumber(num) {
      if (num === null || num === undefined) return 'N/A';
      if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
      if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
      return num.toString();
    }

    channels.forEach((channel, index) => {
      const card = document.createElement('div');
      card.className = 'random-channel-card';
      
      let viewToSubRatio = 0;
      const subs = channel.stats && channel.stats[0] ? channel.stats[0].subscriberCount : 0;
      if (subs > 0) {
        viewToSubRatio = channel.avgViewsPerVideo / subs;
      }

      let ratioColor = '#F44336'; // Default Red
      if (viewToSubRatio >= 5) ratioColor = '#4CAF50';
      else if (viewToSubRatio >= 2) ratioColor = '#8BC34A';
      else if (viewToSubRatio >= 1) ratioColor = '#FFC107';
      else if (viewToSubRatio >= 0.5) ratioColor = '#FF9800';

      card.innerHTML = `
        <div class="random-rank">${index + 1}</div>
        <img src="${channel.thumbnail}" alt="${channel.title}" class="random-channel-img">
        <div class="random-channel-info">
          <h3><a href="https://www.youtube.com/channel/${channel.channelId}" target="_blank">${channel.title}</a></h3>
          <div class="random-language">${channel.language || 'en'}</div>
          <div class="random-stats">
            <div class="random-stat">
              <span>Avg Views:</span>
              <strong>${formatDisplayNumber(channel.avgViewsPerVideo)}</strong>
            </div>
            <div class="random-stat">
              <span>Subscribers:</span>
              <strong>${formatDisplayNumber(subs)}</strong>
            </div>
            <div class="random-stat highlight-ratio">
              <span>Views/Sub:</span>
              <strong style="color: ${ratioColor}">${viewToSubRatio.toFixed(1)}</strong>
            </div>
            <div class="random-stat">
              <span>Channel Age:</span>
              <strong>${channel.channelAgeInDays !== undefined ? channel.channelAgeInDays + ' days' : 'N/A'}</strong>
            </div>
          </div>
          <button class="bookmark-btn" title="Save channel" data-id="${channel._id}">
             <i class="far fa-bookmark"></i>
          </button>
        </div>
      `;
      randomChannelsContainer.appendChild(card);
    });
  }
}); 