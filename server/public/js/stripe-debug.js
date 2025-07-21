// Stripe Checkout Diagnostic and Fix
document.addEventListener('DOMContentLoaded', function() {
  console.log('Stripe Diagnostic Script Loaded');
  
  // Check if the Stripe.js library is loaded
  if (typeof Stripe === 'undefined') {
    console.error('Stripe.js library is not loaded!');
    alert('Stripe.js is not loaded. Please check the console for more information.');
    return;
  }
  
  // Check for plan buttons and add direct click handlers
  const planButtons = document.querySelectorAll('[data-plan]');
  console.log(`Found ${planButtons.length} plan buttons on page:`, planButtons);
  
  // Log button details for debugging
  planButtons.forEach(btn => {
    console.log(`Button: Plan=${btn.dataset.plan}, Text="${btn.textContent.trim()}", Class="${btn.className}"`);
  });
  
  // Initialize Stripe with the hardcoded key for testing
  const stripe = Stripe('pk_live_9zgwBZENfXOBCw0JLkYZZ14Y00OWjZLPgX');
  console.log('Stripe initialized with public key');
  
  // Show a notification for feedback
  const notification = document.createElement('div');
  notification.style.position = 'fixed';
  notification.style.top = '20px';
  notification.style.left = '50%';
  notification.style.transform = 'translateX(-50%)';
  notification.style.padding = '10px 20px';
  notification.style.background = 'rgba(59, 130, 246, 0.9)';
  notification.style.color = 'white';
  notification.style.borderRadius = '8px';
  notification.style.zIndex = '9999';
  notification.textContent = 'Stripe diagnostic script is active. Try clicking a plan button.';
  document.body.appendChild(notification);
  
  setTimeout(() => notification.remove(), 5000);
  
  // Add direct click handlers to all plan buttons
  planButtons.forEach(button => {
    // Remove any existing event listeners (in case they're broken)
    const newButton = button.cloneNode(true);
    button.parentNode.replaceChild(newButton, button);
    
    newButton.addEventListener('click', async function(e) {
      e.preventDefault();
      
      // Show clicked status
      console.log('Button clicked!');
      this.style.opacity = '0.7';
      this.textContent = 'Processing...';
      
      // Get plan
      const plan = this.dataset.plan;
      console.log(`Plan selected: ${plan}`);
      
      // Show visual feedback
      const message = document.createElement('div');
      message.style.position = 'fixed';
      message.style.top = '50%';
      message.style.left = '50%';
      message.style.transform = 'translate(-50%, -50%)';
      message.style.padding = '20px';
      message.style.background = 'rgba(30, 41, 59, 0.95)';
      message.style.color = 'white';
      message.style.borderRadius = '8px';
      message.style.boxShadow = '0 10px 25px rgba(0, 0, 0, 0.3)';
      message.style.zIndex = '10000';
      message.innerHTML = `
        <h3 style="margin-bottom:10px;">Processing ${plan.toUpperCase()} Plan</h3>
        <p>Communicating with server...</p>
      `;
      document.body.appendChild(message);
      
      try {
        // Free plan handling
        if (plan === 'free') {
          console.log('Sending free plan activation request');
          fetch('/subscription/create-checkout-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plan })
          })
          .then(response => {
            console.log(`Server response status: ${response.status}`);
            return response.json();
          })
          .then(data => {
            console.log('Response data:', data);
            if (data.success) {
              message.innerHTML = `<h3>Success!</h3><p>Free plan activated. Redirecting...</p>`;
              setTimeout(() => window.location.href = data.redirect || '/app', 1500);
            } else {
              message.innerHTML = `<h3>Error</h3><p>${data.message || 'Something went wrong'}</p>`;
              setTimeout(() => message.remove(), 3000);
              this.textContent = 'Choose Free';
              this.style.opacity = '1';
            }
          })
          .catch(err => {
            console.error('Fetch error:', err);
            message.innerHTML = `<h3>Error</h3><p>${err.message || 'Network error'}</p>`;
            setTimeout(() => message.remove(), 3000);
            this.textContent = 'Choose Free';
            this.style.opacity = '1';
          });
          return;
        }
        
        // Paid plans
        console.log(`Creating checkout session for ${plan} plan`);
        fetch('/subscription/create-checkout-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan })
        })
        .then(response => {
          console.log(`Server response status: ${response.status}`);
          return response.json();
        })
        .then(data => {
          console.log('Response data:', data);
          if (data.success && data.url) {
            message.innerHTML = `<h3>Success!</h3><p>Redirecting to Stripe checkout...</p>`;
            setTimeout(() => window.location.href = data.url, 1000);
          } else {
            throw new Error(data.message || 'Failed to create checkout session');
          }
        })
        .catch(err => {
          console.error('Checkout error:', err);
          message.innerHTML = `<h3>Checkout Error</h3><p>${err.message || 'Something went wrong'}</p><p>Check browser console for details.</p>`;
          setTimeout(() => message.remove(), 5000);
          this.textContent = plan === 'pro' ? 'Get Pro' : 'Get Max';
          this.style.opacity = '1';
        });
      } catch (error) {
        console.error('Error in click handler:', error);
        message.innerHTML = `<h3>Error</h3><p>${error.message || 'Something went wrong'}</p>`;
        setTimeout(() => message.remove(), 3000);
        this.textContent = plan === 'pro' ? 'Get Pro' : 'Get Max';
        this.style.opacity = '1';
      }
    });
  });
}); 