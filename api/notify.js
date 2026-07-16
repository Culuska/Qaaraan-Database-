// Vercel serverless function backing POST /api/notify.
//
// Sends a best-effort admin notification email via Resend
// (https://resend.com). The frontend calls this for account lockouts,
// password reset requests, and backups the admin explicitly chooses to
// email. Requires a RESEND_API_KEY environment variable in Vercel; if it
// isn't set, this responds 200 with {skipped:true} rather than erroring,
// so the app keeps working without email configured (matching how the
// rest of the app treats notifications as best-effort/in-app by default).
//
// Uses Resend's onboarding@resend.dev sender, which only delivers to the
// Resend account's own verified email address — fine here since the
// admin's inbox IS that account. Verify a custom domain in Resend and
// change `from` below if sending to other recipients is ever needed.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(200).json({ skipped: true, reason: 'RESEND_API_KEY not configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const { to, subject, html, attachment } = body || {};
  if (!to || !subject) {
    res.status(400).json({ error: 'Expected { to, subject, html?, attachment? }' });
    return;
  }

  const payload = {
    from: 'Qaaraan <onboarding@resend.dev>',
    to: [to],
    subject,
    html: html || subject,
  };
  if (attachment && attachment.filename && attachment.contentBase64) {
    payload.attachments = [{ filename: attachment.filename, content: attachment.contentBase64 }];
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      res.status(r.status).json(data);
      return;
    }
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to send email' });
  }
}
