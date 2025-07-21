const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { authenticateToken } = require('../middleware/auth');
const router = express.Router();

// Create checkout session for Pro subscription
router.post('/create-checkout-session', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        
        // Get or create Stripe customer
        let customerId = user.subscription?.stripeCustomerId;
        
        if (!customerId) {
            const customer = await stripe.customers.create({
                email: user.email,
                name: user.display_name,
                metadata: {
                    userId: user._id.toString()
                }
            });
            
            customerId = customer.id;
            
            // Save customer ID to user
            await req.db.collection('users').updateOne(
                { _id: user._id },
                { 
                    $set: { 
                        'subscription.stripeCustomerId': customerId 
                    } 
                }
            );
        }
        
        // Create checkout session
        const session = await stripe.checkout.sessions.create({
            customer: customerId,
            payment_method_types: ['card'],
            line_items: [
                {
                    price: process.env.STRIPE_PRICE_PRO,
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            success_url: `${process.env.APP_URL}/subscription-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.APP_URL}/pricing`,
            metadata: {
                userId: user._id.toString(),
                plan: 'pro'
            },
            allow_promotion_codes: true,
            billing_address_collection: "auto"
        });
        
        res.json({ 
            success: true, 
            sessionId: session.id,
            url: session.url 
        });
        
    } catch (error) {
        console.error('Error creating checkout session:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to create checkout session' 
        });
    }
});

// Handle subscription success
router.get('/success', authenticateToken, async (req, res) => {
    try {
        const { session_id } = req.query;
        
        if (!session_id) {
            return res.redirect('/pricing?error=invalid_session');
        }
        
        // Retrieve the session from Stripe
        const session = await stripe.checkout.sessions.retrieve(session_id);
        
        if (session.payment_status === 'paid') {
            // Update user subscription status
            const subscription = await stripe.subscriptions.retrieve(session.subscription);
            
            await req.db.collection('users').updateOne(
                { _id: req.user._id },
                {
                    $set: {
                        'subscription.status': 'active',
                        'subscription.plan': 'pro',
                        'subscription.stripeSubscriptionId': subscription.id,
                        'subscription.startDate': new Date(subscription.current_period_start * 1000),
                        'subscription.endDate': new Date(subscription.current_period_end * 1000)
                    }
                }
            );
            
            res.redirect('/app?success=subscription_activated');
        } else {
            res.redirect('/pricing?error=payment_failed');
        }
        
    } catch (error) {
        console.error('Error handling subscription success:', error);
        res.redirect('/pricing?error=processing_failed');
    }
});

// Stripe webhook handler
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    
    // Handle the event
    switch (event.type) {
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
            const subscription = event.data.object;
            
            // Update user subscription status
            await req.db.collection('users').updateOne(
                { 'subscription.stripeSubscriptionId': subscription.id },
                {
                    $set: {
                        'subscription.status': subscription.status,
                        'subscription.endDate': new Date(subscription.current_period_end * 1000)
                    }
                }
            );
            break;
            
        case 'invoice.payment_failed':
            const invoice = event.data.object;
            
            // Update user subscription status to past_due
            await req.db.collection('users').updateOne(
                { 'subscription.stripeCustomerId': invoice.customer },
                {
                    $set: {
                        'subscription.status': 'past_due'
                    }
                }
            );
            break;
            
        default:
            console.log(`Unhandled event type ${event.type}`);
    }
    
    res.json({ received: true });
});

module.exports = router;