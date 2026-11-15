'use strict';
// Transactional e-mail over HTTPS (free Render services block SMTP ports 25/465/587, so SMTP cannot be used).
//   Brevo  (free: 300 mails/day, sender verified by e-mail, no own domain needed): BREVO_API_KEY + MAIL_FROM
//   Resend (needs your own verified domain to mail anyone):                         RESEND_API_KEY + RESEND_FROM
// MAIL_FROM may be "Vidora AI <you@gmail.com>" or just "you@gmail.com".

function parseFrom(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^<>\s]+@[^<>\s]+)>\s*$/);
  if (m) return { name: m[1].trim() || 'Vidora AI', email: m[2] };
  return { name: 'Vidora AI', email: s };
}

function provider() {
  if (process.env.BREVO_API_KEY && process.env.MAIL_FROM) return 'brevo';
  if (process.env.RESEND_API_KEY && process.env.RESEND_FROM) return 'resend';
  return null;
}
const isConfigured = () => provider() !== null;

async function sendMail({ to, subject, html, text }) {
  const which = provider();
  if (!which) throw new Error('E-mail is not configured (set BREVO_API_KEY + MAIL_FROM).');
  let response;
  if (which === 'brevo') {
    const from = parseFrom(process.env.MAIL_FROM);
    response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: from, to: [{ email: to }], subject, htmlContent: html, textContent: text }), signal: AbortSignal.timeout(15000)
    });
  } else {
    response = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.RESEND_FROM, to: [to], subject, html, text }), signal: AbortSignal.timeout(15000)
    });
  }
  if (!response.ok) {
    const body = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`${which} rejected the e-mail (${response.status}) ${body}`.trim());
  }
  return { provider: which };
}

module.exports = { provider, isConfigured, sendMail, parseFrom };
