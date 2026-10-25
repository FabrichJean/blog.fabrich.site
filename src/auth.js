const crypto = require('crypto');
const { db } = require('./db');

const COOKIE = 'sid';
const TTL = 1000 * 60 * 60 * 24 * 14; // 14 jours
const isProd = process.env.NODE_ENV === 'production';

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const findSession = db.prepare(`
  SELECT s.id AS sid, s.csrf, u.id, u.username, u.email, u.display_name, u.role
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.id = ? AND s.expires > ?`);

function loadSession(req, res, next) {
  req.user = null;
  req.csrf = null;
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  if (sid) {
    const row = findSession.get(sid, Date.now());
    if (row) {
      req.sid = row.sid;
      req.csrf = row.csrf;
      req.user = { id: row.id, username: row.username, email: row.email, display_name: row.display_name, role: row.role };
    }
  }
  res.locals.user = req.user;
  res.locals.csrf = req.csrf;
  next();
}

function setCookie(res, value, maxAgeMs) {
  const parts = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (isProd) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function login(res, userId) {
  const sid = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(id, user_id, csrf, expires) VALUES(?,?,?,?)')
    .run(sid, userId, crypto.randomBytes(24).toString('hex'), Date.now() + TTL);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  setCookie(res, sid, TTL);
}

function logout(req, res) {
  if (req.sid) { db.prepare('DELETE FROM sessions WHERE id = ?').run(req.sid); require('./notify').closeSession(req.sid); }
  setCookie(res, '', 0);
}

// Zone d'administration : réservée à l'équipe (les comptes lecteurs n'y ont pas accès).
function requireAuth(req, res, next) {
  if (req.user && req.user.role !== 'reader') return next();
  if (req.user) return res.redirect('/');
  res.redirect('/admin/login?next=' + encodeURIComponent(req.originalUrl));
}

function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  res.status(403).render('admin/error', { title: 'Accès refusé', message: 'Cette section est réservée aux administrateurs.' });
}

function verifyCsrf(req, res, next) {
  const token = req.body?._csrf || req.get('x-csrf-token');
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(String(req.csrf || ''));
  if (a.length && a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(403).render('admin/error', { title: 'Requête invalide', message: 'Jeton de sécurité invalide ou expiré. Rechargez la page et réessayez.' });
}

module.exports = { loadSession, login, logout, requireAuth, requireAdmin, verifyCsrf };
