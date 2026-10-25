const nodemailer = require('nodemailer');

// SMTP (SMTP_URL, MAIL_FROM) : newsletter et repli pour l'OTP.
let transport = null;
const enabled = () => Boolean(process.env.SMTP_URL);

function send({ to, subject, text, html, headers }) {
  transport ||= nodemailer.createTransport(process.env.SMTP_URL);
  return transport.sendMail({
    from: process.env.MAIL_FROM || 'Blog <no-reply@localhost>',
    to, subject, text, html, headers,
  });
}

// Service d'e-mails à modèles (API emaildo) : on envoie un identifiant de modèle et des variables.
const templateEnabled = () => Boolean(process.env.EMAILDO_API_KEY && process.env.EMAILDO_SERVICE_ID && process.env.EMAILDO_OTP_TEMPLATE_ID);

async function sendTemplate({ to, templateId, variables }) {
  const res = await fetch(process.env.EMAILDO_URL || 'https://emaildo.fabrich.site/api/v1/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.EMAILDO_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ serviceId: process.env.EMAILDO_SERVICE_ID, templateId, recipient: to, variables }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || data.success === false) {
    throw new Error(`emaildo HTTP ${res.status}${data.error ? ' : ' + String(data.error).slice(0, 200) : ''}`);
  }
  return data;
}

// L'OTP peut partir par modèle (emaildo) ou par SMTP.
const otpReady = () => templateEnabled() || enabled();

module.exports = { enabled, send, templateEnabled, sendTemplate, otpReady };
