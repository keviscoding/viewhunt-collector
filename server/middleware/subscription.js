const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Middleware to check if user has active subscription
const requireSubscription = async (req, res, next) => {
    try {
        const user = req.user;
        
        // Admin always has access
        if (user.email === process.env.ADMIN_EMAIL) {
            return next();
        }
        
        // Check if user has subscription data
        if (!user.subscription || !user.subscription.stripeSubscriptionId) {
            return res.status(403).json({ 
                error: 'Active subscription required',
                redirect: '/pricing'
            });
        }
        
        // Verify subscription with Stripe
        try {
            const subscription = await stripe.subscriptions.retrieve(user.subscription.stripeSubscriptionId);
            
            // Check if subscription is active
            if (subscription.status !== 'active') {
                return res.status(403).json({ 
                    error: 'Active subscription required',
                    redirect: '/pricing'
                });
            }
            
            // Add subscription info to request
            req.subscription = subscription;
            next();
            
        } catch (stripeError) {
            console.error('Stripe subscription check failed:', stripeError);
            return res.status(403).json({ 
                error: 'Subscription verification failed',
                redirect: '/pricing'
            });
        }
        
    } catch (error) {
        console.error('Subscription middleware error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

module.exports = { requireSubscription };