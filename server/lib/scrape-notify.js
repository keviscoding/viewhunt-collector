/**
 * Scrape-complete admin email via Resend (same key as DO: RESEND_API_KEY).
 * Works on DigitalOcean and inside Fly scraper machines.
 */
async function sendScrapeCompleteEmail(summary) {
    summary = summary || {};
    var apiKey = (process.env.RESEND_API_KEY || '').trim();
    if (!apiKey) {
        console.warn('RESEND_API_KEY not set — skipping scrape-complete email');
        return { sent: false, reason: 'no_key' };
    }

    var to = (process.env.SCRAPE_NOTIFY_EMAIL || process.env.ADMIN_EMAIL || 'nwalikelv@gmail.com')
        .trim()
        .toLowerCase();
    var from = process.env.RESEND_FROM_EMAIL || 'ViewHunt <noreply@viewhunt.app>';
    var keywords = summary.keywords || [];
    var kwPreview = keywords.slice(0, 20).join(', ') + (keywords.length > 20 ? '…' : '');

    var subject = 'ViewHunt scrape complete — ' +
        (summary.channelsUpserted || 0) + ' channels added';

    var html =
        '<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:2rem;background:#0e0e12;color:#e8e8ed;border-radius:12px;">' +
        '<h2 style="margin:0 0 0.5rem;color:#7c6aef;">ViewHunt Niche Scraper</h2>' +
        '<p style="margin:0 0 1.25rem;color:#8b8b9e;">Today\'s scrape finished successfully.</p>' +
        '<div style="background:#18181f;border:1px solid #2a2a36;border-radius:10px;padding:1.25rem;margin-bottom:1.25rem;">' +
        '<p style="margin:0 0 0.5rem;"><strong>Run ID:</strong> ' + escapeHtml(String(summary.runId || '—')) + '</p>' +
        '<p style="margin:0 0 0.5rem;"><strong>Keywords (' + keywords.length + '):</strong> ' + escapeHtml(kwPreview || '—') + '</p>' +
        '<p style="margin:0 0 0.5rem;"><strong>Scraped unique:</strong> ' + Number(summary.channelsFound || 0) + '</p>' +
        '<p style="margin:0 0 0.5rem;"><strong>Qualified / upserted:</strong> ' + Number(summary.channelsQualified || 0) + ' / ' + Number(summary.channelsUpserted || 0) + '</p>' +
        '<p style="margin:0;"><strong>Enhanced (recent avg):</strong> ' + Number(summary.channelsEnhanced || 0) + '</p>' +
        '</div>' +
        '<p style="margin:0 0 1rem;font-size:0.9rem;color:#8b8b9e;">Open Admin Panel → Niche Scraper to review channels, or browse Niches with your usual filters.</p>' +
        '<a href="https://viewhunt.app/app/" style="display:inline-block;background:#7c6aef;color:#fff;text-decoration:none;padding:0.75rem 1.25rem;border-radius:8px;font-weight:600;">Open ViewHunt</a>' +
        '</div>';

    var text =
        'ViewHunt niche scrape complete.\n' +
        'Run: ' + (summary.runId || '') + '\n' +
        'Keywords (' + keywords.length + '): ' + (kwPreview || '') + '\n' +
        'Found: ' + (summary.channelsFound || 0) + '\n' +
        'Upserted: ' + (summary.channelsUpserted || 0) + '\n' +
        'Enhanced: ' + (summary.channelsEnhanced || 0) + '\n';

    try {
        var res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: from,
                to: [to],
                subject: subject,
                html: html,
                text: text
            })
        });
        var body = await res.json().catch(function() { return {}; });
        if (!res.ok) {
            console.error('Scrape email failed:', res.status, JSON.stringify(body).slice(0, 300));
            return { sent: false, reason: 'api_error', status: res.status, body: body };
        }
        console.log('📧 Scrape-complete email sent to', to, body.id || '');
        return { sent: true, id: body.id || null, to: to };
    } catch (err) {
        console.error('Scrape email error:', err.message);
        return { sent: false, reason: err.message };
    }
}

function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

module.exports = { sendScrapeCompleteEmail };
