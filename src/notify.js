const { db, settings } = require('./db');
const { translate } = require('./i18n');
const { prefixFor } = require('./lang');

// Notifications : stockées en base, poussées en direct par SSE aux navigateurs connectés.
// Les connexions vivent en mémoire : un seul processus (pour plusieurs instances, prévoir un bus type Redis).
const conns = new Map(); // userId -> Set<{ res, sid, lang }>
const MAX_CONNS_PER_USER = 6;

const postUrl = (post) => `${prefixFor(settings(), post.lang)}/post/${post.slug}`;
const sourceUrl = (src) => `${prefixFor(settings(), src.lang)}/source/${src.slug}`;

// Texte d'une notification dans la langue demandée (rendu à l'affichage, pas à la création).
function textOf(row, lang) {
  const d = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : row.data;
  return translate(lang, `n_${row.type}`, { n: d.n || 0, ...d });
}

function unreadCount(userId) {
  return db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;
}

function recent(userId, limit = 8, offset = 0) {
  return db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(userId, limit, offset);
}

function sse(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// Crée la notification et la pousse aux onglets ouverts de l'utilisateur.
function add(userId, type, data, url) {
  const now = Date.now();
  const id = db.prepare('INSERT INTO notifications(user_id, type, data, url, created_at) VALUES(?,?,?,?,?)')
    .run(userId, type, JSON.stringify(data), String(url || '').startsWith('/') ? url : '', now).lastInsertRowid;
  const set = conns.get(userId);
  if (set?.size) {
    const row = { id, user_id: userId, type, data, url, created_at: now };
    const count = unreadCount(userId);
    for (const c of set) sse(c.res, 'notification', { id, url, text: textOf(row, c.lang), created_at: now, count });
  }
  return id;
}

const addMany = (userIds, type, data, url) => { for (const u of new Set(userIds)) add(u, type, data, url); };
const adminIds = () => db.prepare("SELECT id FROM users WHERE role = 'admin'").all().map((r) => r.id);

function markRead(userId, id) {
  const r = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL').run(Date.now(), id, userId);
  if (r.changes) syncCount(userId);
  return r.changes > 0;
}

function markAll(userId) {
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(Date.now(), userId);
  syncCount(userId);
}

// Met à jour le compteur des autres onglets.
function syncCount(userId) {
  const set = conns.get(userId);
  if (!set?.size) return;
  const count = unreadCount(userId);
  for (const c of set) sse(c.res, 'count', { count });
}

// ---------- Événements métier ----------

// Nouvel article publié : prévient les abonnés de ses tags et de son auteur (jamais l'auteur lui-même).
function fanoutPost(post) {
  const reasons = new Map();
  const tagRows = db.prepare(`SELECT f.user_id, t.name FROM follows f JOIN post_tags pt ON pt.tag_id = f.ref_id
    JOIN tags t ON t.id = f.ref_id WHERE f.kind = 'tag' AND pt.post_id = ?`).all(post.id);
  for (const r of tagRows) if (!reasons.has(r.user_id)) reasons.set(r.user_id, `#${r.name}`);
  const authorRows = db.prepare("SELECT f.user_id FROM follows f WHERE f.kind = 'author' AND f.ref_id = ?").all(post.author_id);
  for (const r of authorRows) if (!reasons.has(r.user_id)) reasons.set(r.user_id, post.author_name || '');
  reasons.delete(post.author_id);
  for (const [userId, reason] of reasons) add(userId, 'followed_post', { title: post.title, reason }, postUrl(post));
  return reasons.size;
}

// Articles publiés (maintenant ou à l'heure programmée) pas encore notifiés. Appelée après chaque enregistrement et chaque minute.
function checkPublished() {
  const due = db.prepare(`SELECT p.id FROM posts p WHERE p.status = 'published' AND p.external_url IS NULL
    AND p.notified_at IS NULL AND p.published_at <= ?`).all(Date.now());
  let n = 0;
  for (const { id } of due) {
    // Le marquage est atomique : deux passages simultanés ne notifient jamais deux fois.
    if (!db.prepare('UPDATE posts SET notified_at = ? WHERE id = ? AND notified_at IS NULL').run(Date.now(), id).changes) continue;
    const post = db.prepare(`SELECT p.id, p.title, p.slug, p.lang, p.author_id, u.display_name AS author_name
      FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?`).get(id);
    n += fanoutPost(post);
  }
  return n;
}

// Import RSS : une seule notification par source et par passage.
function sourceBatch(source, count) {
  if (!count) return;
  const followers = db.prepare("SELECT user_id FROM follows WHERE kind = 'source' AND ref_id = ?").all(source.id).map((r) => r.user_id);
  addMany(followers, 'source_batch', { source: source.name, n: count }, sourceUrl(source));
}

// Un commentaire visible : prévient les autres participants de la discussion.
function discussion(comment, post) {
  const others = db.prepare(`SELECT DISTINCT user_id FROM comments WHERE post_id = ? AND status = 'approved'
    AND user_id IS NOT NULL AND user_id != ? LIMIT 50`).all(post.id, comment.user_id || 0).map((r) => r.user_id);
  addMany(others, 'discussion', { name: comment.author_name, title: post.title }, `${postUrl(post)}#comments`);
}

function commentApproved(comment, post) {
  if (comment.user_id) add(comment.user_id, 'comment_approved', { title: post.title }, `${postUrl(post)}#comments`);
  discussion(comment, post);
}

const staffComment = (comment, post) => addMany(adminIds(), 'admin_comment', { name: comment.author_name, title: post.title }, '/admin/comments');
const staffSubmission = (name, title) => addMany(adminIds(), 'admin_submission', { name, title }, '/admin/submissions');

function submissionReviewed(sub, post) {
  if (post) add(sub.user_id, 'submission_approved', { title: post.title }, postUrl(post));
  else add(sub.user_id, 'submission_rejected', { title: sub.title || sub.url.replace(/^https?:\/\//, '').slice(0, 60) }, '/notifications');
}

// ---------- Flux temps réel (SSE) ----------
function stream(req, res, lang) {
  const userId = req.user.id;
  const set = conns.get(userId) || new Set();
  conns.set(userId, set);
  if (set.size >= MAX_CONNS_PER_USER) { const old = set.values().next().value; old.res.end(); set.delete(old); }
  const conn = { res, sid: req.sid, lang };
  set.add(conn);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  sse(res, 'count', { count: unreadCount(userId) });
  req.on('close', () => { set.delete(conn); if (!set.size) conns.delete(userId); });
}

// Coupe les flux d'une session fermée (déconnexion) ; le battement de cœur couvre l'expiration.
function closeSession(sid) {
  for (const [userId, set] of conns) {
    for (const c of set) if (c.sid === sid) { c.res.end(); set.delete(c); }
    if (!set.size) conns.delete(userId);
  }
}

function heartbeat() {
  const now = Date.now();
  for (const [userId, set] of conns) {
    for (const c of set) {
      const alive = db.prepare('SELECT 1 FROM sessions WHERE id = ? AND expires > ?').get(c.sid, now);
      if (!alive) { c.res.end(); set.delete(c); } else c.res.write(': ping\n\n');
    }
    if (!set.size) conns.delete(userId);
  }
}

function prune() {
  db.prepare('DELETE FROM notifications WHERE created_at < ?').run(Date.now() - 60 * 24 * 3600 * 1000);
}

function start() {
  setInterval(heartbeat, 25000).unref();
  setInterval(() => { try { checkPublished(); } catch (e) { console.error('Notifications :', e.message); } }, 60000).unref();
  setInterval(prune, 24 * 3600 * 1000).unref();
  try { prune(); checkPublished(); } catch (e) { console.error('Notifications :', e.message); }
}

module.exports = {
  add, textOf, unreadCount, recent, markRead, markAll, checkPublished, fanoutPost, sourceBatch, commentApproved, discussion,
  staffComment, staffSubmission, submissionReviewed, stream, closeSession, start, postUrl,
};
