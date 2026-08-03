/**
 * ViewHunt client telemetry — UTM/click-id capture, PostHog, Meta Pixel, Google Ads.
 * Load on every public page: <script src="/js/viewhunt-telemetry.js" defer></script>
 */
(function() {
    'use strict';

    var LS_FIRST = 'vh_attr_first';
    var LS_LAST = 'vh_attr_last';
    var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    var ready = false;
    var config = null;
    var queue = [];

    function readCookie(name) {
        try {
            var m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
            return m ? decodeURIComponent(m[1]) : null;
        } catch (e) { return null; }
    }

    function writeCookie(name, value, days) {
        try {
            var maxAge = (days || 90) * 24 * 60 * 60;
            document.cookie = name + '=' + encodeURIComponent(value) +
                '; path=/; max-age=' + maxAge + '; SameSite=Lax';
        } catch (e) {}
    }

    function getParams() {
        try { return new URLSearchParams(window.location.search); } catch (e) { return new URLSearchParams(); }
    }

    function captureFromUrl() {
        var params = getParams();
        var attr = {};
        var has = false;
        UTM_KEYS.forEach(function(k) {
            var v = params.get(k);
            if (v) { attr[k] = v; has = true; }
        });
        var gclid = params.get('gclid');
        if (gclid) { attr.gclid = gclid; has = true; }
        var fbclid = params.get('fbclid');
        if (fbclid) {
            attr.fbclid = fbclid;
            has = true;
            // Meta _fbc format: fb.1.{timestamp}.{fbclid}
            if (!readCookie('_fbc')) {
                writeCookie('_fbc', 'fb.1.' + Date.now() + '.' + fbclid, 90);
            }
        }
        var fbp = readCookie('_fbp');
        if (fbp) attr.fbp = fbp;
        var fbc = readCookie('_fbc');
        if (fbc) attr.fbc = fbc;

        if (has || attr.fbp || attr.fbc) {
            attr.landing_page = window.location.pathname + window.location.search;
            attr.referrer = document.referrer || '';
            attr.capturedAt = new Date().toISOString();
            try {
                if (!localStorage.getItem(LS_FIRST)) {
                    localStorage.setItem(LS_FIRST, JSON.stringify(attr));
                }
                localStorage.setItem(LS_LAST, JSON.stringify(attr));
            } catch (e) {}
        } else {
            // Refresh fbp/fbc on last touch even without new UTMs
            try {
                var last = JSON.parse(localStorage.getItem(LS_LAST) || '{}');
                if (fbp) last.fbp = fbp;
                if (fbc) last.fbc = fbc;
                if (fbp || fbc) localStorage.setItem(LS_LAST, JSON.stringify(last));
            } catch (e) {}
        }
    }

    function getAttribution() {
        var out = {};
        try {
            var first = JSON.parse(localStorage.getItem(LS_FIRST) || '{}');
            var last = JSON.parse(localStorage.getItem(LS_LAST) || '{}');
            UTM_KEYS.concat(['gclid', 'fbclid', 'fbp', 'fbc', 'landing_page', 'referrer']).forEach(function(k) {
                if (last[k]) out[k] = last[k];
                else if (first[k]) out[k] = first[k];
            });
            out.firstTouch = first;
            out.lastTouch = last;
        } catch (e) {}
        var fbp = readCookie('_fbp');
        var fbc = readCookie('_fbc');
        if (fbp) out.fbp = fbp;
        if (fbc) out.fbc = fbc;
        return out;
    }

    function loadScript(src, id) {
        return new Promise(function(resolve) {
            if (id && document.getElementById(id)) { resolve(); return; }
            var s = document.createElement('script');
            if (id) s.id = id;
            s.async = true;
            s.src = src;
            s.onload = function() { resolve(); };
            s.onerror = function() { resolve(); };
            document.head.appendChild(s);
        });
    }

    function initMeta(pixelId) {
        if (!pixelId || window.fbq) return;
        !function(f, b, e, v, n, t, s) {
            if (f.fbq) return;
            n = f.fbq = function() {
                n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
            };
            if (!f._fbq) f._fbq = n;
            n.push = n; n.loaded = !0; n.version = '2.0';
            n.queue = [];
            t = b.createElement(e); t.async = !0;
            t.src = v;
            s = b.getElementsByTagName(e)[0];
            s.parentNode.insertBefore(t, s);
        }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
        window.fbq('init', pixelId);
        window.fbq('track', 'PageView');
    }

    function initGoogle(adsId) {
        if (!adsId) return Promise.resolve();
        window.dataLayer = window.dataLayer || [];
        window.gtag = window.gtag || function() { window.dataLayer.push(arguments); };
        window.gtag('js', new Date());
        window.gtag('config', adsId);
        return loadScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(adsId), 'vh-gtag');
    }

    function initPostHog(key, host) {
        if (!key || window.posthog) return Promise.resolve();
        return new Promise(function(resolve) {
            !function(t, e) {
                var o, n, p, r;
                e.__SV || (window.posthog = e, e._i = [], e.init = function(i, s, a) {
                    function g(t, e) {
                        var o = e.split('.');
                        2 == o.length && (t = t[o[0]], e = o[1]);
                        t[e] = function() {
                            t.push([e].concat(Array.prototype.slice.call(arguments, 0)));
                        };
                    }
                    (p = t.createElement('script')).type = 'text/javascript';
                    p.crossOrigin = 'anonymous';
                    p.async = !0;
                    p.src = s.api_host.replace('.i.posthog.com', '-assets.i.posthog.com') + '/static/array.js';
                    r = t.getElementsByTagName('script')[0];
                    r.parentNode.insertBefore(p, r);
                    var u = e;
                    void 0 !== a ? u = e[a] = [] : a = 'posthog';
                    u.people = u.people || [];
                    u.toString = function(t) {
                        var e = 'posthog';
                        return 'posthog' !== a && (e += '.' + a), t || (e += ' (stub)'), e;
                    };
                    u.people.toString = function() { return u.toString(1) + '.people (stub)'; };
                    o = 'init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug'.split(' ');
                    for (n = 0; n < o.length; n++) g(u, o[n]);
                    e._i.push([i, s, a]);
                }, e.__SV = 1);
            }(document, window.posthog || []);
            window.posthog.init(key, {
                api_host: host || 'https://us.i.posthog.com',
                person_profiles: 'identified_only',
                capture_pageview: true,
                persistence: 'localStorage+cookie'
            });
            // Give stub a tick then resolve
            setTimeout(resolve, 50);
        });
    }

    function flushQueue() {
        while (queue.length) {
            var item = queue.shift();
            try { item(); } catch (e) {}
        }
    }

    function track(event, props) {
        var run = function() {
            var attr = getAttribution();
            var payload = Object.assign({}, props || {});
            UTM_KEYS.concat(['gclid', 'fbclid']).forEach(function(k) {
                if (attr[k] && payload[k] == null) payload[k] = attr[k];
            });
            if (window.posthog && typeof window.posthog.capture === 'function') {
                window.posthog.capture(event, payload);
            }
            // Meta browser events for key conversions (dedupe via eventID)
            if (window.fbq) {
                if (event === 'signup_completed') {
                    window.fbq('track', 'CompleteRegistration', {}, { eventID: payload.event_id });
                } else if (event === 'trial_started') {
                    window.fbq('track', 'StartTrial', {
                        value: 0,
                        currency: 'USD',
                        predicted_ltv: 0
                    }, { eventID: payload.event_id });
                } else if (event === 'subscription_activated') {
                    window.fbq('track', 'Purchase', {
                        value: payload.value || 0,
                        currency: (payload.currency || 'USD').toUpperCase()
                    }, { eventID: payload.event_id });
                } else if (event === 'checkout_started') {
                    window.fbq('track', 'InitiateCheckout', {
                        content_name: payload.plan || 'plan'
                    }, { eventID: payload.event_id });
                }
            }
            // Google Ads conversions
            if (window.gtag && config) {
                if (event === 'trial_started' && config.googleAdsId && config.googleAdsLabelTrial) {
                    window.gtag('event', 'conversion', {
                        send_to: config.googleAdsId + '/' + config.googleAdsLabelTrial,
                        event_callback: function() {}
                    });
                } else if (event === 'subscription_activated' && config.googleAdsId && config.googleAdsLabelPaid) {
                    window.gtag('event', 'conversion', {
                        send_to: config.googleAdsId + '/' + config.googleAdsLabelPaid,
                        value: payload.value || 0,
                        currency: (payload.currency || 'USD').toUpperCase(),
                        event_callback: function() {}
                    });
                }
            }
        };
        if (!ready) { queue.push(run); return; }
        run();
    }

    function identify(userId, traits) {
        var run = function() {
            if (window.posthog && userId && typeof window.posthog.identify === 'function') {
                window.posthog.identify(String(userId), traits || {});
            }
        };
        if (!ready) { queue.push(run); return; }
        run();
    }

    function beaconServer(event, properties) {
        try {
            var token = localStorage.getItem('viewhunt_token') || localStorage.getItem('token');
            var headers = { 'Content-Type': 'application/json' };
            if (token) headers.Authorization = 'Bearer ' + token;
            var distinctId = null;
            try {
                if (window.posthog && typeof window.posthog.get_distinct_id === 'function') {
                    distinctId = window.posthog.get_distinct_id();
                }
            } catch (e) {}
            fetch('/api/telemetry/event', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    event: event,
                    properties: properties || {},
                    attribution: attributionForApi(),
                    distinctId: distinctId
                }),
                keepalive: true
            }).catch(function() {});
        } catch (e) {}
    }

    async function syncAttributionToServer(token) {
        var attr = getAttribution();
        var body = {
            utm_source: attr.utm_source,
            utm_medium: attr.utm_medium,
            utm_campaign: attr.utm_campaign,
            utm_content: attr.utm_content,
            utm_term: attr.utm_term,
            gclid: attr.gclid,
            fbclid: attr.fbclid,
            fbp: attr.fbp,
            fbc: attr.fbc,
            landing_page: attr.landing_page,
            referrer: attr.referrer
        };
        var has = Object.keys(body).some(function(k) { return !!body[k]; });
        if (!has) return;
        try {
            var headers = { 'Content-Type': 'application/json' };
            if (token) headers.Authorization = 'Bearer ' + token;
            await fetch('/api/telemetry/attribution', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body)
            });
        } catch (e) {}
    }

    function attributionForApi() {
        var a = getAttribution();
        return {
            utm_source: a.utm_source,
            utm_medium: a.utm_medium,
            utm_campaign: a.utm_campaign,
            utm_content: a.utm_content,
            utm_term: a.utm_term,
            gclid: a.gclid,
            fbclid: a.fbclid,
            fbp: a.fbp,
            fbc: a.fbc,
            landing_page: a.landing_page,
            referrer: a.referrer
        };
    }

    function fireSuccessFromQuery() {
        try {
            var params = getParams();
            var success = params.get('success');
            if (!success) return;
            if (success === 'trial_started') {
                track('trial_started', { source: 'redirect' });
            } else if (success === 'subscription_activated') {
                track('subscription_activated', { source: 'redirect' });
            }
        } catch (e) {}
    }

    async function boot() {
        captureFromUrl();
        try {
            var res = await fetch('/api/telemetry/config');
            config = res.ok ? await res.json() : {};
        } catch (e) {
            config = {};
        }

        var jobs = [];
        if (config.posthogKey) {
            jobs.push(initPostHog(config.posthogKey, config.posthogHost));
        }
        if (config.metaPixelId) {
            initMeta(config.metaPixelId);
        }
        if (config.googleAdsId) {
            jobs.push(initGoogle(config.googleAdsId));
        }
        await Promise.all(jobs);

        ready = true;
        flushQueue();

        // Page-level auto events (client + server beacon for admin funnel)
        var path = window.location.pathname || '/';
        if (path === '/' || path === '/index.html') {
            track('landing_viewed', { path: path });
            beaconServer('landing_viewed', { path: path });
        }
        if (path.indexOf('/studio/ranking') === 0) {
            track('ranking_opened', { path: path });
            beaconServer('ranking_opened', { path: path });
        }
        fireSuccessFromQuery();

        // If already logged in, identify + sync attribution
        try {
            var token = localStorage.getItem('viewhunt_token') || localStorage.getItem('token');
            if (token) {
                syncAttributionToServer(token);
                fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } })
                    .then(function(r) { return r.ok ? r.json() : null; })
                    .then(function(me) {
                        if (me && me.id) identify(me.id, { email: me.email });
                    })
                    .catch(function() {});
            }
        } catch (e) {}
    }

    window.ViewHuntTelemetry = {
        track: track,
        identify: identify,
        getAttribution: getAttribution,
        attributionForApi: attributionForApi,
        syncAttributionToServer: syncAttributionToServer,
        captureFromUrl: captureFromUrl,
        beaconServer: beaconServer
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
