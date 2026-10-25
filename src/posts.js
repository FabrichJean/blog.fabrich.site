const { db } = require('./db');
const { slugify, uniqueSlug } = require('./util');

const BASE_SELECT = `
  SELECT p.*, c.name AS category_name, c.slug AS category_slug,
         u.display_name AS author_name, u.username AS author_username,
         s.name AS source_name, s.slug AS source_slug,
         su.display_name AS submitter_name,
         (SELECT COUNT(*) FROM comments m WHERE m.post_id = p.id AND m.status = 'approved') AS comment_count`;
const BASE_FROM = `
  FROM posts p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN sources s ON s.id = p.source_id
  LEFT JOIN users su ON su.id = p.submitted_by
  JOIN users u ON u.id = p.author_id`;
const BASE = BASE_SELECT + BASE_FROM;

const inList = (ids) => ids.map(() => '?').join(',');

function attachTags(posts) {
  if (!posts.length) return posts;
  const ids = posts.map((p) => p.id);
  const rows = db.prepare(
    `SELECT pt.post_id, t.id, t.name, t.slug FROM post_tags pt JOIN tags t ON t.id = pt.tag_id
     WHERE pt.post_id IN (${inList(ids)}) ORDER BY t.name`
  ).all(...ids);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.post_id)) map.set(r.post_id, []);
    map.get(r.post_id).push({ id: r.id, name: r.name, slug: r.slug });
  }
  for (const p of posts) p.tags = map.get(p.id) || [];
  return posts;
}

// Marque les articles déjà votés / mis en favori par le lecteur connecté.
function attachViewer(posts, userId) {
  for (const p of posts) { p.upvoted = false; p.bookmarked = false; }
  if (!userId || !posts.length) return posts;
  const ids = posts.map((p) => p.id);
  const q = (table) => new Set(db.prepare(`SELECT post_id FROM ${table} WHERE user_id = ? AND post_id IN (${inList(ids)})`).all(userId, ...ids).map((r) => r.post_id));
  const votes = q('post_votes'); const marks = q('bookmarks');
  for (const p of posts) { p.upvoted = votes.has(p.id); p.bookmarked = marks.has(p.id); }
  return posts;
}

// Centres d'intérêt d'un lecteur : abonnements explicites + tags des articles votés / mis en favori.
function getInterests(userId) {
  const set = (kind) => new Set(db.prepare('SELECT ref_id FROM follows WHERE user_id = ? AND kind = ?').all(userId, kind).map((r) => r.ref_id));
  const implicit = new Map();
  for (const r of db.prepare(
    `SELECT pt.tag_id, COUNT(*) n FROM post_tags pt
     WHERE pt.post_id IN (SELECT post_id FROM post_votes WHERE user_id = ? UNION SELECT post_id FROM bookmarks WHERE user_id = ?)
     GROUP BY pt.tag_id`).all(userId, userId)) implicit.set(r.tag_id, r.n);
  const read = new Set(db.prepare('SELECT DISTINCT post_id FROM reads WHERE user_id = ?').all(userId).map((r) => r.post_id));
  const interests = { tags: set('tag'), sources: set('source'), authors: set('author'), implicit, read };
  interests.any = interests.tags.size + interests.sources.size + interests.authors.size + implicit.size > 0;
  return interests;
}

const DAY = 86400000;
// Score « tendance » : engagement divisé par l'âge. « Pour vous » ajoute l'affinité avec les intérêts du lecteur.
function scorePost(p, now, interests) {
  const age = Math.max(0, (now - p.published_at) / DAY);
  const engagement = p.upvotes * 3 + p.comment_count * 2 + Math.log1p(p.views) + 1;
  if (!interests) return engagement / (age + 2) ** 1.2;
  let affinity = 0;
  for (const t of p.tags) {
    if (interests.tags.has(t.id)) affinity += 3;
    affinity += Math.min(interests.implicit.get(t.id) || 0, 3) * 0.5;
  }
  if (p.source_id && interests.sources.has(p.source_id)) affinity += 4;
  if (interests.authors.has(p.author_id)) affinity += 3;
  const score = (affinity * 2 + engagement) / (age + 2) ** 1.1;
  return interests.read.has(p.id) ? score * 0.2 : score;
}

const RANK_POOL = 500;

// Liste paginée des articles publiés (internes et externes).
// Options : lang, category, tag, author, source, q, sort ('latest' | 'popular' | 'foryou'), interests, viewerId, bookmarkedBy, readBy.
function listPublished({ page = 1, perPage = 8, lang, category, tag, author, source, q, sort = 'latest', interests, viewerId, bookmarkedBy, readBy } = {}) {
  const where = ["p.status = 'published'", 'p.published_at <= ?'];
  const whereArgs = [Date.now()];
  const joins = []; const joinArgs = [];
  let order = 'p.published_at DESC';
  if (lang) { where.push('p.lang = ?'); whereArgs.push(lang); }
  if (category) { where.push('c.slug = ?'); whereArgs.push(category); }
  if (author) { where.push('u.username = ?'); whereArgs.push(author); }
  if (source) { where.push('s.slug = ?'); whereArgs.push(source); }
  if (tag) { joins.push('JOIN post_tags ft ON ft.post_id = p.id JOIN tags t2 ON t2.id = ft.tag_id AND t2.slug = ?'); joinArgs.push(tag); }
  if (bookmarkedBy) { joins.push('JOIN bookmarks bm ON bm.post_id = p.id AND bm.user_id = ?'); joinArgs.push(bookmarkedBy); order = 'bm.created_at DESC'; }
  if (readBy) {
    joins.push('JOIN (SELECT post_id, MAX(read_at) AS read_at FROM reads WHERE user_id = ? GROUP BY post_id) rd ON rd.post_id = p.id');
    joinArgs.push(readBy); order = 'rd.read_at DESC';
  }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    where.push("(p.title LIKE ? ESCAPE '\\' OR p.body_md LIKE ? ESCAPE '\\' OR p.excerpt LIKE ? ESCAPE '\\')");
    whereArgs.push(like, like, like);
  }
  const from = `${BASE_FROM} ${joins.join(' ')} WHERE ${where.join(' AND ')}`;
  const args = [...joinArgs, ...whereArgs];
  const total = db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...args).n;
  const pages = Math.max(1, Math.ceil(total / perPage));
  page = Math.min(Math.max(1, page), pages);
  const select = BASE_SELECT + from;

  let rows;
  if (sort === 'latest') {
    rows = attachTags(db.prepare(`${select} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, perPage, (page - 1) * perPage));
  } else {
    // Classement calculé en mémoire sur les articles les plus récents.
    const pool = attachTags(db.prepare(`${select} ORDER BY p.published_at DESC LIMIT ${RANK_POOL}`).all(...args));
    const now = Date.now();
    const use = sort === 'foryou' ? interests : null;
    for (const p of pool) p.score = scorePost(p, now, use);
    pool.sort((a, b) => b.score - a.score);
    rows = pool.slice((page - 1) * perPage, page * perPage);
  }
  return { posts: attachViewer(rows, viewerId), total, pages, page };
}

function findPublishedBySlug(slug) {
  const post = db.prepare(`${BASE} WHERE p.slug = ? AND p.status = 'published' AND p.published_at <= ?`).get(slug, Date.now());
  return post ? attachTags([post])[0] : null;
}

function findByShareToken(token) {
  const post = db.prepare(`${BASE} WHERE p.share_token = ?`).get(token);
  return post ? attachTags([post])[0] : null;
}

// Traductions publiées d'un article (même groupe, autre langue).
function translations(post) {
  return db.prepare(
    `SELECT lang, slug FROM posts WHERE translation_group = ? AND id != ? AND status = 'published' AND published_at <= ?`
  ).all(post.translation_group, post.id, Date.now());
}

function findById(id) {
  const post = db.prepare(`${BASE} WHERE p.id = ?`).get(id);
  return post ? attachTags([post])[0] : null;
}

function related(post, limit = 3) {
  return attachTags(db.prepare(
    `${BASE} WHERE p.id != ? AND p.lang = ? AND p.status = 'published' AND p.published_at <= ?
       AND (p.category_id = ? OR p.id IN (SELECT post_id FROM post_tags WHERE tag_id IN (SELECT tag_id FROM post_tags WHERE post_id = ?)))
     ORDER BY p.published_at DESC LIMIT ?`
  ).all(post.id, post.lang, Date.now(), post.category_id, post.id, limit));
}

function neighbours(post) {
  const now = Date.now();
  const prev = db.prepare("SELECT title, slug FROM posts WHERE lang = ? AND status='published' AND published_at < ? AND published_at <= ? ORDER BY published_at DESC LIMIT 1").get(post.lang, post.published_at, now);
  const next = db.prepare("SELECT title, slug FROM posts WHERE lang = ? AND status='published' AND published_at > ? AND published_at <= ? ORDER BY published_at ASC LIMIT 1").get(post.lang, post.published_at, now);
  return { prev, next };
}

function sidebar(lang) {
  const now = Date.now();
  const categories = db.prepare(
    `SELECT c.name, c.slug, COUNT(p.id) AS n FROM categories c
     JOIN posts p ON p.category_id = c.id AND p.status = 'published' AND p.published_at <= ?
     WHERE c.lang = ? GROUP BY c.id ORDER BY c.name`
  ).all(now, lang);
  const tags = db.prepare(
    `SELECT t.name, t.slug, COUNT(p.id) AS n FROM tags t
     JOIN post_tags pt ON pt.tag_id = t.id
     JOIN posts p ON p.id = pt.post_id AND p.status = 'published' AND p.published_at <= ?
     WHERE t.lang = ? GROUP BY t.id ORDER BY n DESC, t.name LIMIT 30`
  ).all(now, lang);
  const popular = db.prepare(
    "SELECT title, slug FROM posts WHERE lang = ? AND status='published' AND published_at <= ? ORDER BY views DESC, published_at DESC LIMIT 5"
  ).all(lang, now);
  return { categories, tags, popular };
}

// Remplace les tags d'un article à partir d'une chaîne "a, b, c".
function setTags(postId, input, lang) {
  const names = [...new Set(String(input || '').split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean))].slice(0, 15);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM post_tags WHERE post_id = ?').run(postId);
    for (const name of names) {
      if (!slugify(name)) continue;
      let tag = db.prepare('SELECT id FROM tags WHERE lang = ? AND lower(name) = lower(?)').get(lang, name);
      if (!tag) tag = { id: db.prepare('INSERT INTO tags(name, slug, lang) VALUES(?,?,?)').run(name.slice(0, 40), uniqueSlug('tags', name), lang).lastInsertRowid };
      db.prepare('INSERT OR IGNORE INTO post_tags(post_id, tag_id) VALUES(?,?)').run(postId, tag.id);
    }
    db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM post_tags)').run();
  });
  tx();
}

module.exports = { getInterests, attachViewer, scorePost, listPublished, findPublishedBySlug, findByShareToken, translations, findById, related, neighbours, sidebar, setTags, attachTags, BASE, uniqueSlug };
