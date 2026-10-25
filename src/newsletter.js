const crypto = require('crypto');
const { db, settings } = require('./db');
const mail = require('./mail');
const { translate } = require('./i18n');
const { prefixFor } = require('./lang');
const { escapeXml, makeExcerpt } = require('./util');

const newToken = () => crypto.randomBytes(24).toString('hex');

// Inscription. Sans SMTP, impossible de confirmer l'adresse : l'inscription est directement active.
// Retourne 'confirm' (e-mail envoyé) ou 'done'. Ne révèle jamais si l'adresse existait déjà.
async function subscribe(email, lang, baseUrl, siteTitle) {
  const existing = db.prepare('SELECT * FROM subscribers WHERE email = ?').get(email);
  if (existing?.confirmed) return mail.enabled() ? 'confirm' : 'done';
  const double = mail.enabled();
  let token = existing?.token;
  if (!existing) {
    token = newToken();
    db.prepare('INSERT INTO subscribers(email, lang, token, confirmed, created_at) VALUES(?,?,?,?,?)')
      .run(email, lang, token, double ? 0 : 1, Date.now());
  } else {
    db.prepare('UPDATE subscribers SET lang = ? WHERE id = ?').run(lang, existing.id);
  }
  if (!double) return 'done';
  const link = `${baseUrl}/newsletter/confirm/${token}`;
  const t = (k, v) => translate(lang, k, v);
  await mail.send({
    to: email,
    subject: t('mail_confirm_subject', { site: siteTitle }),
    text: `${t('mail_confirm_body', { site: siteTitle })}\n\n${link}\n`,
  });
  return 'confirm';
}

function confirmedCount(lang) {
  return db.prepare('SELECT COUNT(*) AS n FROM subscribers WHERE confirmed = 1 AND lang = ?').get(lang).n;
}

// Envoi d'un article aux abonnés confirmés de sa langue, un par un (en arrière-plan).
async function sendPost(post, baseUrl) {
  const s = settings();
  const subs = db.prepare('SELECT * FROM subscribers WHERE confirmed = 1 AND lang = ?').all(post.lang);
  const siteTitle = s[`site_title_${post.lang}`] || s.site_title;
  const url = `${baseUrl}${prefixFor(s, post.lang)}/post/${post.slug}`;
  const excerpt = post.excerpt || makeExcerpt(post.body_html, 280);
  let sent = 0; let failed = 0;
  for (const sub of subs) {
    const t = (k, v) => translate(sub.lang, k, v);
    const unsub = `${baseUrl}/newsletter/unsubscribe/${sub.token}`;
    try {
      await mail.send({
        to: sub.email,
        subject: t('mail_post_subject', { title: post.title }),
        text: `${post.title}\n\n${excerpt}\n\n${t('mail_post_read')}: ${url}\n\n${t('mail_unsub')}: ${unsub}\n`,
        html: `<h2>${escapeXml(post.title)}</h2><p>${escapeXml(excerpt)}</p><p><a href="${escapeXml(url)}">${t('mail_post_read')}</a></p>
<p style="color:#888;font-size:12px"><a href="${escapeXml(unsub)}">${t('mail_unsub')}</a> — ${escapeXml(siteTitle)}</p>`,
        headers: { 'List-Unsubscribe': `<${unsub}>` },
      });
      sent++;
    } catch (err) {
      failed++;
      console.error('Newsletter : échec pour un abonné —', err.message);
    }
  }
  console.log(`Newsletter « ${post.title} » : ${sent} envoyé(s), ${failed} échec(s).`);
  return { sent, failed };
}

module.exports = { subscribe, confirmedCount, sendPost };
