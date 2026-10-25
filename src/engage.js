const { db } = require('./db');

const today = () => new Date().toISOString().slice(0, 10);

// Bascule un vote ou un favori ; renvoie l'état et le compteur à jour.
function toggleVote(userId, postId) {
  return db.transaction(() => {
    const had = db.prepare('DELETE FROM post_votes WHERE user_id = ? AND post_id = ?').run(userId, postId).changes > 0;
    if (!had) db.prepare('INSERT INTO post_votes(user_id, post_id, created_at) VALUES(?,?,?)').run(userId, postId, Date.now());
    db.prepare('UPDATE posts SET upvotes = upvotes + ? WHERE id = ?').run(had ? -1 : 1, postId);
    return { active: !had, count: db.prepare('SELECT upvotes FROM posts WHERE id = ?').get(postId).upvotes };
  })();
}

function toggleBookmark(userId, postId) {
  const had = db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND post_id = ?').run(userId, postId).changes > 0;
  if (!had) db.prepare('INSERT INTO bookmarks(user_id, post_id, created_at) VALUES(?,?,?)').run(userId, postId, Date.now());
  return { active: !had };
}

const FOLLOW_TABLES = { tag: 'tags', source: 'sources', author: 'users' };

function toggleFollow(userId, kind, refId) {
  const table = FOLLOW_TABLES[kind];
  if (!table || !db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(refId)) return null;
  const had = db.prepare('DELETE FROM follows WHERE user_id = ? AND kind = ? AND ref_id = ?').run(userId, kind, refId).changes > 0;
  if (!had) db.prepare('INSERT INTO follows(user_id, kind, ref_id, created_at) VALUES(?,?,?,?)').run(userId, kind, refId, Date.now());
  return { active: !had };
}

const isFollowing = (userId, kind, refId) =>
  Boolean(userId && db.prepare('SELECT 1 FROM follows WHERE user_id = ? AND kind = ? AND ref_id = ?').get(userId, kind, refId));

function recordRead(userId, postId) {
  db.prepare('INSERT OR IGNORE INTO reads(user_id, post_id, day, read_at) VALUES(?,?,?,?)').run(userId, postId, today(), Date.now());
  db.prepare('UPDATE reads SET read_at = ? WHERE user_id = ? AND post_id = ? AND day = ?').run(Date.now(), userId, postId, today());
}

const dayMs = 86400000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// Série de lecture : jours consécutifs avec au moins une lecture (hier compte encore si aujourd'hui est vide).
function streak(userId) {
  const days = db.prepare('SELECT DISTINCT day FROM reads WHERE user_id = ? ORDER BY day DESC').all(userId).map((r) => r.day);
  const set = new Set(days);
  const now = Date.now();
  let cursor = set.has(dayOf(now)) ? now : now - dayMs;
  let current = 0;
  while (set.has(dayOf(cursor))) { current++; cursor -= dayMs; }
  let longest = 0; let run = 0; let prev = null;
  for (const d of [...days].reverse()) {
    run = prev && Date.parse(d) - Date.parse(prev) === dayMs ? run + 1 : 1;
    longest = Math.max(longest, run); prev = d;
  }
  const week = Array.from({ length: 7 }, (_, i) => {
    const ms = now - (6 - i) * dayMs;
    return { day: dayOf(ms), label: new Date(ms).toLocaleDateString('fr-FR', { weekday: 'narrow', timeZone: 'UTC' }), read: set.has(dayOf(ms)) };
  });
  // 5 semaines (35 jours) pour la carte de chaleur du profil.
  const heat = Array.from({ length: 35 }, (_, i) => {
    const d = dayOf(now - (34 - i) * dayMs);
    return { day: d, read: set.has(d), today: i === 34 };
  });
  return { current, longest, total: days.length, week, heat };
}

function stats(userId) {
  const n = (sql) => db.prepare(sql).get(userId).n;
  return {
    votes: n('SELECT COUNT(*) n FROM post_votes WHERE user_id = ?'),
    bookmarks: n('SELECT COUNT(*) n FROM bookmarks WHERE user_id = ?'),
    reads: n('SELECT COUNT(DISTINCT post_id) n FROM reads WHERE user_id = ?'),
  };
}

function followed(userId) {
  return {
    tags: db.prepare("SELECT t.id, t.name, t.slug FROM follows f JOIN tags t ON t.id = f.ref_id WHERE f.user_id = ? AND f.kind = 'tag' ORDER BY t.name").all(userId),
    sources: db.prepare("SELECT s.id, s.name, s.slug FROM follows f JOIN sources s ON s.id = f.ref_id WHERE f.user_id = ? AND f.kind = 'source' ORDER BY s.name").all(userId),
    authors: db.prepare("SELECT u.id, u.display_name AS name, u.username FROM follows f JOIN users u ON u.id = f.ref_id WHERE f.user_id = ? AND f.kind = 'author' ORDER BY u.display_name").all(userId),
  };
}

module.exports = { toggleVote, toggleBookmark, toggleFollow, isFollowing, recordRead, streak, stats, followed };
