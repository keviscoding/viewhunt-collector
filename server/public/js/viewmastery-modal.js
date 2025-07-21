console.log("ViewMastery modal script loading");
document.addEventListener("DOMContentLoaded", function() {
  console.log("DOM loaded");
  const viewmasteryHTML = "<section id=\"viewmastery-section\" style=\"display:none; background:linear-gradient(rgba(15, 23, 42, 0.85), rgba(15, 23, 42, 0.95))\"><div class=\"container viewmastery-container\"><div class=\"viewmastery-content\"><h2>View Mastery Private Community</h2><p>Congratulations! ViewHunt Max now grants you access to Kevis\&#39; exclusive View Mastery Private Community.</p><p>Get direct access to winning niches, current strategies, weekly strategy calls, and the complete View Mastery course - everything you need to build your dream Shorts income.</p><div class=\"viewmastery-buttons\"><a href=\"https://whop.com/view-mastery/\" target=\"_blank\" class=\"btn primary\">Continue to Checkout</a></div><a href=\"#pricing\" class=\"viewmastery-back\">← Back to Pricing</a></div></div></section>";
  const footer = document.querySelector("footer");
  if (footer) {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = viewmasteryHTML;
    footer.parentNode.insertBefore(tempDiv.firstChild, footer);
  }
  const maxButton = document.getElementById("maxPlanGetStartedBtn");
  if (maxButton) {
    maxButton.addEventListener("click", function(e) {
      e.preventDefault();
      const pricingSection = document.getElementById("pricing");
      const viewmasterySection = document.getElementById("viewmastery-section");
      if (pricingSection) pricingSection.style.display = "none";
      if (viewmasterySection) {
        viewmasterySection.style.display = "block";
        viewmasterySection.scrollIntoView();
      }
      history.pushState(null, null, "#viewmastery-section");
    });
  }
});
setTimeout(function() {
  const viewmasterySection = document.getElementById("viewmastery-section");
  if (viewmasterySection) {
    const backLinks = viewmasterySection.querySelectorAll("a[href=\"#pricing\"]");
    backLinks.forEach(function(link) {
      link.addEventListener("click", function(e) {
        e.preventDefault();
        const pricingSection = document.getElementById("pricing");
        const viewmasterySection = document.getElementById("viewmastery-section");
        if (pricingSection) pricingSection.style.display = "block";
        if (viewmasterySection) viewmasterySection.style.display = "none";
        history.pushState(null, null, "#pricing");
        document.getElementById("pricing").scrollIntoView();
      });
    });
  }
}, 500);
