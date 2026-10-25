const crypto = require('crypto');
const { db } = require('./db');
const mail = require('./mail');
const { translate } = require('./i18n');

const TTL = 10 * 60 * 1000;      // validité du code
const MAX_ATTEMPTS = 5;          // essais avant invalidation
const MAX_SENDS = 5;             // envois par demande d'inscription
const COOLDOWN = 60 * 1000;      // délai entre deux envois
const PENDING_TTL = 60 * 60 * 1000;

const hash = (salt, code) => crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Sans SMTP, le code ne peut pas être envoyé. En développement il s'affiche dans la console du serveur ;
// en production l'inscription est refusée plutôt que d'ouvrir des comptes sans vérifier l'adresse.
const canDeliver = () => mail.otpReady() || process.env.NODE_ENV !== 'production';

async function deliver({ email, lang, code, siteTitle, name }) {
  const t = (k, v) => translate(lang, k, v);
  if (mail.templateEnabled()) {
    // Variables du modèle emaildo : {{prenom}}, {{code_otp}}, {{entreprise}}.
    await mail.sendTemplate({
      to: email, templateId: process.env.EMAILDO_OTP_TEMPLATE_ID,
      variables: { prenom: name, code_otp: code, entreprise: siteTitle },
    });
    return;
  }
  if (!mail.enabled()) {
    console.log(`[OTP dev] code pour ${email} : ${code}  (valable 10 min — configurez EMAILDO_* ou SMTP_URL pour l'envoi réel)`);
    return;
  }
  await mail.send({
    to: email,
    subject: t('otp_subject', { code, site: siteTitle }),
    text: `${t('otp_mail_intro', { site: siteTitle })}\n\n    ${code}\n\n${t('otp_mail_outro', { min: 10 })}\n`,
  });
}

// Crée (ou remplace) la demande d'inscription en attente d'une adresse et envoie le code. Retourne le jeton de suivi.
async function start({ email, displayName, passwordHash, lang, next, siteTitle }) {
  const now = Date.now();
  db.prepare('DELETE FROM signup_otps WHERE created_at < ?').run(now - PENDING_TTL);
  db.prepare('DELETE FROM signup_otps WHERE email = ?').run(email);
  const token = crypto.randomBytes(24).toString('hex');
  const salt = crypto.randomBytes(8).toString('hex');
  const code = newCode();
  db.prepare(`INSERT INTO signup_otps(token,email,display_name,password_hash,lang,next,salt,code_hash,expires,last_sent,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(token, email, displayName, passwordHash, lang, next, salt, hash(salt, code), now + TTL, now, now);
  try { await deliver({ email, lang, code, siteTitle, name: displayName }); } catch (err) {
    db.prepare('DELETE FROM signup_otps WHERE token = ?').run(token);
    throw err;
  }
  return token;
}

const find = (token) => (typeof token === 'string' && /^[a-f0-9]{48}$/.test(token)
  ? db.prepare('SELECT * FROM signup_otps WHERE token = ? AND created_at > ?').get(token, Date.now() - PENDING_TTL) : null);

// Renvoie un nouveau code. Résultat : 'ok' | 'wait' (délai) | 'max' (trop d'envois) | 'missing'.
async function resend(token, siteTitle) {
  const row = find(token);
  if (!row) return { status: 'missing' };
  const now = Date.now();
  if (row.sends >= MAX_SENDS) return { status: 'max' };
  if (now - row.last_sent < COOLDOWN) return { status: 'wait', seconds: Math.ceil((COOLDOWN - (now - row.last_sent)) / 1000) };
  const code = newCode(); const salt = crypto.randomBytes(8).toString('hex');
  db.prepare('UPDATE signup_otps SET salt=?, code_hash=?, expires=?, attempts=0, sends=sends+1, last_sent=? WHERE token=?')
    .run(salt, hash(salt, code), now + TTL, now, token);
  await deliver({ email: row.email, lang: row.lang, code, siteTitle, name: row.display_name });
  return { status: 'ok' };
}

// Contrôle le code. Résultat : { status: 'ok', row } | 'wrong' (avec essais restants) | 'expired' | 'locked' | 'missing'.
function check(token, input) {
  const row = find(token);
  if (!row) return { status: 'missing' };
  if (row.attempts >= MAX_ATTEMPTS) return { status: 'locked' };
  if (Date.now() > row.expires) return { status: 'expired' };
  const code = String(input || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code) || !safeEqual(hash(row.salt, code), row.code_hash)) {
    db.prepare('UPDATE signup_otps SET attempts = attempts + 1 WHERE token = ?').run(token);
    return { status: row.attempts + 1 >= MAX_ATTEMPTS ? 'locked' : 'wrong', left: MAX_ATTEMPTS - row.attempts - 1 };
  }
  return { status: 'ok', row };
}

const remove = (token) => db.prepare('DELETE FROM signup_otps WHERE token = ?').run(token);

module.exports = { start, find, resend, check, remove, canDeliver, MAX_ATTEMPTS, COOLDOWN };
