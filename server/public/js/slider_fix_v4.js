// CONSOLIDATED CLIENT-SIDE SLIDER FIX V4.3 (Single Sliders Visual Update)
document.addEventListener("DOMContentLoaded", function() {
  console.log("Consolidated Slider Fix V4.3 Loaded");

  function formatNumber(num) { return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  function formatAgeDisplay(totalDays) {
    if (totalDays === null || totalDays === undefined) return "0 days";
    totalDays = parseInt(totalDays);
    if (isNaN(totalDays) || totalDays < 0) totalDays = 0;
    if (totalDays < 365) {
      return totalDays + (totalDays === 1 ? " day" : " days");
    } else {
      const years = Math.floor(totalDays / 365);
      return years + (years === 1 ? " year" : " years");
    }
  }

  function setupSlider(rangeMinId, rangeMaxId, valueMinId, valueMaxId, hiddenMinId, hiddenMaxId, maxActualVal, scaleType, displayFormatFunc) {
    const rangeMin = document.getElementById(rangeMinId);
    const rangeMax = document.getElementById(rangeMaxId);
    const valueMinDisplay = document.getElementById(valueMinId);
    const valueMaxDisplay = document.getElementById(valueMaxId);
    const hiddenMin = document.getElementById(hiddenMinId);
    const hiddenMax = document.getElementById(hiddenMaxId);

    if (!rangeMin || !rangeMax || !hiddenMin || !hiddenMax) {
      console.error("V4.3: Missing critical elements for dual slider: " + rangeMinId);
      return;
    }
    if (!valueMinDisplay) console.warn("V4.3: Display element " + valueMinId + " not found.");
    if (!valueMaxDisplay) console.warn("V4.3: Display element " + valueMaxId + " not found.");

    const initialMinVal = parseInt(hiddenMin.value) || 0;
    const initialMaxVal = parseInt(hiddenMax.value) ? parseInt(hiddenMax.value) : maxActualVal;

    let valueToSliderPos;
    if (scaleType === "subs" || scaleType === "views") { valueToSliderPos = (val, mv) => val <= 0 ? 0 : Math.round(Math.sqrt(val / mv) * 100); }
    else if (scaleType === "age" || scaleType === "videos") { valueToSliderPos = (val, mv) => val <= 0 ? 0 : Math.round((val / mv) * 100); }
    else { valueToSliderPos = (val, mv) => 0; console.warn("V4.3: Unknown scaleType: " + scaleType); }

    rangeMin.value = Math.max(0, Math.min(100, valueToSliderPos(initialMinVal, maxActualVal)));
    rangeMax.value = Math.max(0, Math.min(100, valueToSliderPos(initialMaxVal, maxActualVal)));
    
    if(valueMinDisplay) valueMinDisplay.textContent = displayFormatFunc(initialMinVal);
    if(valueMaxDisplay) valueMaxDisplay.textContent = displayFormatFunc(initialMaxVal);

    rangeMin.addEventListener("input", function() {
      let currentMin = parseInt(rangeMin.value);
      let currentMax = parseInt(rangeMax.value);
      if (currentMin > currentMax) { rangeMin.value = currentMax; currentMin = currentMax; }
      
      let scaledValue;
      if (scaleType === "subs" || scaleType === "views") { scaledValue = Math.floor(Math.pow(currentMin/100, 2) * maxActualVal); }
      else if (scaleType === "age" || scaleType === "videos") { scaledValue = Math.floor(currentMin/100 * maxActualVal); }
      else { scaledValue = 0; }

      if(valueMinDisplay) valueMinDisplay.textContent = displayFormatFunc(scaledValue);
      hiddenMin.value = scaledValue;
    });

    rangeMax.addEventListener("input", function() {
      let currentMin = parseInt(rangeMin.value);
      let currentMax = parseInt(rangeMax.value);
      if (currentMax < currentMin) { rangeMax.value = currentMin; currentMax = currentMin; }

      let scaledValue;
      if (scaleType === "subs" || scaleType === "views") { scaledValue = Math.floor(Math.pow(currentMax/100, 2) * maxActualVal); }
      else if (scaleType === "age" || scaleType === "videos") { scaledValue = Math.floor(currentMax/100 * maxActualVal); }
      else { scaledValue = 0; }

      if(valueMaxDisplay) valueMaxDisplay.textContent = displayFormatFunc(scaledValue);
      hiddenMax.value = scaledValue;
    });
  }
  
  // --- Setup for Single Sliders ---
  function setupSingleSliderDisplay(sliderId, displaySelector, unit = "") {
    const slider = document.getElementById(sliderId);
    let displayElement;
    // For shortsPercentage, display is next sibling div.slider-bubble
    if (sliderId === "minShortsPercentage" && slider && slider.nextElementSibling && slider.nextElementSibling.classList.contains("slider-bubble")) {
        displayElement = slider.nextElementSibling;
    } 
    // For facelessness, specific class
    else if (displaySelector && document.querySelector(displaySelector)) { 
        displayElement = document.querySelector(displaySelector);
    } else if (slider && slider.parentNode.querySelector(displaySelector)) { // Fallback for relative selector
        displayElement = slider.parentNode.querySelector(displaySelector);
    }

    if (!slider) {
      console.error("V4.3: Single slider input not found: " + sliderId);
      return;
    }
    if (!displayElement) {
      console.warn("V4.3: Display element not found for slider: " + sliderId + " with selector: " + displaySelector);
      // return; // Allow slider to function without display if not found, but log it.
    }

    function updateDisplay() {
      if(displayElement) displayElement.textContent = slider.value + unit;
    }

    slider.addEventListener("input", updateDisplay);
    updateDisplay(); // Initial display update
  }

  // Dual Sliders
  setupSlider("minSubs", "maxSubs", "minSubsValue", "maxSubsValue", "actualMinSubs", "actualMaxSubs", 200000000, "subs", formatNumber);
  setupSlider("minAvgViews", "maxAvgViews", "minAvgViewsValue", "maxAvgViewsValue", "actualMinAvgViews", "actualMaxAvgViews", 200000000, "views", formatNumber);
  setupSlider("minAge", "maxAge", "minAgeValue", "maxAgeValue", "actualMinAge", "actualMaxAge", 7300, "age", formatAgeDisplay);
  setupSlider("minVideos", "maxVideos", "minVideosValue", "maxVideosValue", "actualMinVideos", "actualMaxVideos", 10000, "videos", formatNumber);

  // Single Sliders Visual Update
  setupSingleSliderDisplay("minShortsPercentage", ".slider-bubble", "%"); // Display is next sibling div.slider-bubble
  
  // For Facelessness, the input itself might not have an ID, we use class selector for it
  const facelessSlider = document.querySelector(".faceless-slider[name='minFacelessScore']");
  const facelessDisplay = document.querySelector(".faceless-value");
  if (facelessSlider && facelessDisplay) {
      function updateFacelessDisplay() {
          facelessDisplay.textContent = facelessSlider.value;
      }
      facelessSlider.addEventListener("input", updateFacelessDisplay);
      updateFacelessDisplay(); // Initial display
  } else {
      console.warn("V4.3: Faceless slider or its display not found.");
  }

  // Form Submission Handler (remains the same)
  const appForm = document.querySelector("form[action='/app']");
  if (appForm) {
    appForm.addEventListener("submit", function(event) {
      console.log("V4.3: Form /app submit intercepted. Ensuring hidden fields are set from sliders.");
      [ "minSubs", "maxSubs", "minAvgViews", "maxAvgViews", "minAge", "maxAge", "minVideos", "maxVideos" ].forEach(id => {
        const slider = document.getElementById(id);
        if (slider) { slider.dispatchEvent(new Event("input", { bubbles: true })); }
      });
    });
  }
}); 