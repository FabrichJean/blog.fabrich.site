const nodemailer = require('nodemailer');

// Configuré par SMTP_URL (ex. smtp://user:pass@smtp.exemple.fr:587) et MAIL_FROM.
let transport = null;
const enabled = () => Boolean(process.env.SMTP_URL);

function send({ to, subject, text, html, headers }) {
  transport ||= nodemailer.createTransport(process.env.SMTP_URL);
  return transport.sendMail({
    from: process.env.MAIL_FROM || 'Blog <no-reply@localhost>',
    to, subject, text, html, headers,
  });
}

module.exports = { enabled, send };
