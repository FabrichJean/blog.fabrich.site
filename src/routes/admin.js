const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { db, setSetting, DEFAULT_SETTINGS, PER_LANG } = require('../db');
const { login, logout, requireAuth, requireAdmin, verifyCsrf } = require('../auth');
const posts = require('../posts');
const newsletter = require('../newsletter');
const mail = require('../mail');
const feeds = require('../feeds');
const notify = require('../notify');
const bulk = require('../bulk');
const { safeFetch } = require('../safe-fetch');
const { LANGS } = require('../i18n');
const { FONT_LABELS, HEX } = require('../theme');
const {
  uniqueSlug, slugify, renderMarkdown, fromInputDate, toInputDate, isEmail, rateLimiter,
} = require('../util');

const router = express.Router();
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'uploads'));
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
const MAX_IMAGE = 5 * 1024 * 1024;
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + EXT[file.mimetype]),
  }),
  limits: { fileSize: MAX_IMAGE, files: 1 },
  fileFilter: (req, file, cb) => cb(null, Boolean(EXT[file.mimetype])),
});
// Vérifie le contenu réel (octets magiques) : le type MIME envoyé par le navigateur ne suffit pas.
function isImageBuffer(b) {
  if (!b || b.length < 12) return false;
  const hex = b.subarray(0, 4).toString('hex');
  return hex.startsWith('ffd8ff') || hex === '89504e47' || b.subarray(0, 4).toString('latin1') === 'GIF8'
    || (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP');
}
function isImageFile(file) {
  try {
    const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(12);
    fs.readSync(fd, b, 0, 12, 0); fs.closeSync(fd);
    return isImageBuffer(b);
  } catch { return false; }
}
// Import en masse : jusqu'à 100 fichiers texte de 1 Mo.
const bulkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: bulk.MAX_FILES } });
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

const loginLimiter = rateLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
const form = express.urlencoded({ extended: false, limit: '2mb' });
const json = express.json({ limit: '2mb' });

const baseUrl = (req) => (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const defaultLang = (res) => res.locals.siteAll.default_lang;

router.use((req, res, next) => {
  res.locals.noindex = true;
  res.locals.flash = req.query.ok ? { ok: true, msg: String(req.query.ok).slice(0, 200) } : null;
  next();
});

const flashRedirect = (res, url, msg) => res.redirect(`${url}${url.includes('?') ? '&' : '?'}ok=${encodeURIComponent(msg)}`);

const removeUpload = (url) => {
  if (!url || !url.startsWith('/uploads/')) return;
  fs.rm(path.join(UPLOAD_DIR, path.basename(url)), { force: true }, () => {});
};

// ---------- Installation (premier compte) ----------
const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

router.get('/setup', (req, res) => {
  if (userCount()) return res.redirect('/admin/login');
  res.render('admin/setup', { title: 'Installation', error: null, v: {} });
});

router.post('/setup', form, (req, res) => {
  if (userCount()) return res.redirect('/admin/login');
  const v = {
    username: slugify(req.body.username || '').replace(/-/g, '_'),
    display_name: String(req.body.display_name || '').trim().slice(0, 60),
    email: String(req.body.email || '').trim().toLowerCase(),
    site_title: String(req.body.site_title || '').trim().slice(0, 80),
  };
  const password = String(req.body.password || '');
  const err = !v.username || !v.display_name ? 'Identifiant et nom affiché requis.'
    : !isEmail(v.email) ? 'E-mail invalide.'
    : password.length < 8 ? 'Mot de passe : 8 caractères minimum.' : null;
  if (err) return res.status(400).render('admin/setup', { title: 'Installation', error: err, v });

  const lang = defaultLang(res);
  const tx = db.transaction(() => {
    const userId = db.prepare('INSERT INTO users(username,email,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)')
      .run(v.username, v.email, v.display_name, bcrypt.hashSync(password, 12), 'admin', Date.now()).lastInsertRowid;
    if (v.site_title) setSetting('site_title', v.site_title);
    const catId = db.prepare('INSERT INTO categories(name, slug, description, lang) VALUES(?,?,?,?)').run('Général', 'general', 'Articles divers', lang).lastInsertRowid;
    const md = `# Bienvenue\n\nVotre blog est prêt. Rendez-vous dans l'[administration](/admin) pour écrire votre premier article.\n\n- Écrivez en **Markdown**\n- Classez par catégories et tags\n- Modérez les commentaires\n\n\`\`\`js\nconsole.log("Hello, blog !");\n\`\`\`\n`;
    const now = Date.now();
    const postId = db.prepare(`INSERT INTO posts(title,slug,excerpt,body_md,body_html,status,category_id,author_id,created_at,updated_at,published_at,lang)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('Bienvenue sur votre blog', 'bienvenue', 'Premier article de démonstration.', md, renderMarkdown(md), 'published', catId, userId, now, now, now, lang).lastInsertRowid;
    db.prepare('UPDATE posts SET translation_group = id WHERE id = ?').run(postId);
    posts.setTags(postId, 'bienvenue', lang);
    return userId;
  });
  login(res, tx());
  res.redirect('/admin');
});

// ---------- Connexion ----------
router.get('/login', (req, res) => {
  if (!userCount()) return res.redirect('/admin/setup');
  if (req.user) return res.redirect('/admin');
  res.render('admin/login', { title: 'Connexion', error: null, next: req.query.next || '' });
});

router.post('/login', form, (req, res) => {
  const next = String(req.body.next || '');
  const safeNext = /^\/admin(\/|$|\?)/.test(next) ? next : '/admin';
  const key = req.ip;
  if (loginLimiter.hit(key)) {
    return res.status(429).render('admin/login', { title: 'Connexion', error: 'Trop de tentatives. Réessayez dans 15 minutes.', next });
  }
  const id = String(req.body.username || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE lower(username) = ? OR lower(email) = ?').get(id, id);
  // bcrypt est exécuté même si l'utilisateur n'existe pas, pour ne pas révéler son existence par le temps de réponse.
  const hash = user?.password_hash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali';
  const ok = bcrypt.compareSync(String(req.body.password || ''), hash) && user;
  if (!ok) return res.status(401).render('admin/login', { title: 'Connexion', error: 'Identifiants incorrects.', next });
  loginLimiter.reset(key);
  login(res, user.id);
  res.redirect(safeNext);
});

router.post('/logout', requireAuth, form, verifyCsrf, (req, res) => {
  logout(req, res);
  res.redirect('/');
});

// Tout ce qui suit nécessite une session.
router.use(requireAuth);
router.use((req, res, next) => {
  res.locals.path = req.path;
  if (req.user.role === 'admin') {
    res.locals.counts = {
      comments: db.prepare("SELECT COUNT(*) n FROM comments WHERE status = 'pending'").get().n,
      submissions: db.prepare("SELECT COUNT(*) n FROM submissions WHERE status = 'pending'").get().n,
    };
  }
  next();
});

// ---------- Tableau de bord ----------
router.get('/', (req, res) => {
  const mine = req.user.role === 'admin' ? '' : 'WHERE author_id = ' + Number(req.user.id);
  const stats = {
    published: db.prepare(`SELECT COUNT(*) n FROM posts ${mine ? mine + ' AND' : 'WHERE'} status='published'`).get().n,
    drafts: db.prepare(`SELECT COUNT(*) n FROM posts ${mine ? mine + ' AND' : 'WHERE'} status='draft'`).get().n,
    views: db.prepare(`SELECT COALESCE(SUM(views),0) n FROM posts ${mine}`).get().n,
    pending: db.prepare("SELECT COUNT(*) n FROM comments WHERE status='pending'").get().n,
    comments: db.prepare("SELECT COUNT(*) n FROM comments WHERE status='approved'").get().n,
    subscribers: db.prepare('SELECT COUNT(*) n FROM subscribers WHERE confirmed = 1').get().n,
    readers: db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'reader'").get().n,
    sources: db.prepare('SELECT COUNT(*) n FROM sources WHERE active = 1').get().n,
    submissions: db.prepare("SELECT COUNT(*) n FROM submissions WHERE status = 'pending'").get().n,
  };
  const recent = posts.attachTags(db.prepare(`${posts.BASE} ${mine ? mine.replace('author_id', 'p.author_id') : ''} ORDER BY p.updated_at DESC LIMIT 6`).all());
  const top = db.prepare(`SELECT id, title, views FROM posts ${mine} ORDER BY views DESC LIMIT 5`).all();
  res.render('admin/dashboard', { title: 'Tableau de bord', stats, recent, top });
});

// ---------- Articles ----------
router.get('/posts', (req, res) => {
  const status = ['draft', 'published'].includes(req.query.status) ? req.query.status : '';
  const lang = LANGS[req.query.lang] ? req.query.lang : '';
  const q = String(req.query.q || '').trim();
  const where = []; const args = [];
  if (req.user.role !== 'admin') { where.push('p.author_id = ?'); args.push(req.user.id); }
  if (status) { where.push('p.status = ?'); args.push(status); }
  if (lang) { where.push('p.lang = ?'); args.push(lang); }
  if (q) { where.push('p.title LIKE ?'); args.push(`%${q}%`); }
  const rows = db.prepare(`${posts.BASE} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.updated_at DESC LIMIT 200`).all(...args);
  res.render('admin/posts', { title: 'Articles', rows, status, lang, q, now: Date.now() });
});

function postFormData(req, res, post) {
  const shareUrl = post?.share_token ? `${baseUrl(req)}/preview/${post.share_token}` : null;
  return {
    categories: db.prepare('SELECT id, name, lang FROM categories ORDER BY lang, name').all(),
    otherPosts: db.prepare('SELECT id, title, lang FROM posts WHERE id != ? ORDER BY updated_at DESC LIMIT 300').all(post?.id || 0),
    tagsValue: post?.tags ? post.tags.map((t) => t.name).join(', ') : '',
    publishedAtValue: toInputDate(post?.published_at),
    shareUrl,
    mailReady: mail.enabled(),
    subscribersForLang: post ? newsletter.confirmedCount(post.lang) : 0,
    translationOf: '',
  };
}

router.get('/posts/new', (req, res) => {
  const post = { status: 'draft', title: '', body_md: '', excerpt: '', lang: defaultLang(res) };
  const data = postFormData(req, res);
  // Raccourci « Créer la traduction » : langue choisie et lien vers l'article source.
  const source = req.query.translate ? posts.findById(req.query.translate) : null;
  if (source) {
    data.translationOf = String(source.id);
    post.lang = res.locals.langs.find((l) => l !== source.lang) || post.lang;
    if (LANGS[req.query.lang] && req.query.lang !== source.lang) post.lang = req.query.lang;
  }
  res.render('admin/post-form', { title: 'Nouvel article', post, error: null, ...data });
});

function canEdit(req, post) {
  return post && (req.user.role === 'admin' || post.author_id === req.user.id);
}

router.get('/posts/:id/edit', (req, res, next) => {
  const post = posts.findById(req.params.id);
  if (!canEdit(req, post)) return next();
  const data = postFormData(req, res, post);
  const siblings = db.prepare('SELECT id, lang, title FROM posts WHERE translation_group = ? AND id != ?').all(post.translation_group, post.id);
  data.translationOf = siblings.length ? String(siblings[0].id) : '';
  res.render('admin/post-form', { title: 'Modifier : ' + post.title, post, siblings, error: null, ...data });
});

function savePost(req, res) {
  const id = req.params.id ? Number(req.params.id) : null;
  const existing = id ? posts.findById(id) : null;
  if (id && !canEdit(req, existing)) return res.status(404).render('admin/error', { title: 'Introuvable', message: 'Article introuvable.' });

  const b = req.body;
  const title = String(b.title || '').trim().slice(0, 200);
  const bodyMd = String(b.body_md || '');
  const status = b.status === 'published' ? 'published' : 'draft';
  const lang = res.locals.langs.includes(b.lang) ? b.lang : (existing?.lang || defaultLang(res));
  const draft = {
    ...(existing || {}), title, body_md: bodyMd, excerpt: String(b.excerpt || '').slice(0, 400), status, lang,
    category_id: Number(b.category_id) || null,
  };
  const rerender = (error) => {
    if (req.file) fs.rm(req.file.path, { force: true }, () => {});
    res.status(400).render('admin/post-form', {
      title: id ? 'Modifier' : 'Nouvel article', post: { ...draft, tags: [] }, siblings: [], error,
      ...postFormData(req, res, existing), tagsValue: b.tags || '', publishedAtValue: b.published_at || '', translationOf: b.translation_of || '',
    });
  };
  if (!title) return rerender('Le titre est obligatoire.');
  if (req.file && !isImageFile(req.file.path)) return rerender('L\'image de couverture n\'est pas un fichier image valide.');

  const category = draft.category_id ? db.prepare('SELECT id, lang FROM categories WHERE id = ?').get(draft.category_id) : null;
  if (category && category.lang !== lang) return rerender('La catégorie choisie n\'est pas dans la langue de l\'article.');

  // Groupe de traduction : celui de l'article lié, sinon l'article est seul dans son groupe.
  let group = null;
  const target = b.translation_of ? posts.findById(b.translation_of) : null;
  if (target) {
    if (target.lang === lang) return rerender('Une traduction doit être dans une autre langue que l\'article lié.');
    const clash = db.prepare('SELECT 1 FROM posts WHERE translation_group = ? AND lang = ? AND id != ?').get(target.translation_group, lang, id || 0);
    if (clash) return rerender('Ce groupe contient déjà un article dans cette langue.');
    group = target.translation_group;
  }

  const slug = uniqueSlug('posts', String(b.slug || '').trim() || title, id || 0);
  const now = Date.now();
  let publishedAt = existing?.published_at || null;
  if (status === 'published') publishedAt = fromInputDate(b.published_at) || publishedAt || now;
  else publishedAt = fromInputDate(b.published_at) || publishedAt;

  let cover = existing?.cover || null;
  if (req.file) { removeUpload(cover); cover = '/uploads/' + req.file.filename; }
  else if (b.remove_cover) { removeUpload(cover); cover = null; }

  const categoryId = category?.id || null;
  const html = renderMarkdown(bodyMd);
  let postId = id;
  if (id) {
    db.prepare(`UPDATE posts SET title=?, slug=?, excerpt=?, body_md=?, body_html=?, cover=?, status=?, category_id=?, updated_at=?, published_at=?, lang=? WHERE id=?`)
      .run(title, slug, draft.excerpt.trim(), bodyMd, html, cover, status, categoryId, now, publishedAt, lang, id);
  } else {
    postId = db.prepare(`INSERT INTO posts(title,slug,excerpt,body_md,body_html,cover,status,category_id,author_id,created_at,updated_at,published_at,lang)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(title, slug, draft.excerpt.trim(), bodyMd, html, cover, status, categoryId, req.user.id, now, now, publishedAt, lang).lastInsertRowid;
  }
  db.prepare('UPDATE posts SET translation_group = ? WHERE id = ?').run(group || postId, postId);
  posts.setTags(postId, b.tags, lang);
  notify.checkPublished();
  flashRedirect(res, `/admin/posts/${postId}/edit`, status === 'published' ? 'Article enregistré et publié.' : 'Brouillon enregistré.');
}

router.post('/posts/new', upload.single('cover'), verifyCsrf, savePost);
router.post('/posts/:id/edit', upload.single('cover'), verifyCsrf, savePost);

router.post('/posts/:id/delete', form, verifyCsrf, (req, res, next) => {
  const post = posts.findById(req.params.id);
  if (!canEdit(req, post)) return next();
  removeUpload(post.cover);
  db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
  db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM post_tags)').run();
  flashRedirect(res, '/admin/posts', 'Article supprimé.');
});

// Lien de partage privé : donne accès en lecture à un brouillon, révocable.
router.post('/posts/:id/share', form, verifyCsrf, (req, res, next) => {
  const post = posts.findById(req.params.id);
  if (!canEdit(req, post)) return next();
  const token = req.body.action === 'revoke' ? null : crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE posts SET share_token = ? WHERE id = ?').run(token, post.id);
  flashRedirect(res, `/admin/posts/${post.id}/edit`, token ? 'Lien de partage créé.' : 'Lien de partage révoqué.');
});

// Envoi de l'article aux abonnés confirmés de sa langue (en arrière-plan).
router.post('/posts/:id/newsletter', requireAdmin, form, verifyCsrf, (req, res, next) => {
  const post = posts.findById(req.params.id);
  if (!post) return next();
  const back = `/admin/posts/${post.id}/edit`;
  if (!mail.enabled()) return flashRedirect(res, back, 'SMTP non configuré (variable SMTP_URL).');
  if (post.status !== 'published' || post.published_at > Date.now()) return flashRedirect(res, back, 'Publiez l\'article avant de l\'envoyer.');
  const n = newsletter.confirmedCount(post.lang);
  if (!n) return flashRedirect(res, back, 'Aucun abonné confirmé pour cette langue.');
  db.prepare('UPDATE posts SET newsletter_sent_at = ? WHERE id = ?').run(Date.now(), post.id);
  newsletter.sendPost(post, baseUrl(req)).catch((err) => console.error('Newsletter :', err));
  flashRedirect(res, back, `Envoi en cours à ${n} abonné${n > 1 ? 's' : ''}.`);
});

// Aperçu Markdown (même rendu que le site) et upload d'images pour l'éditeur.
router.post('/preview', json, verifyCsrf, (req, res) => {
  res.json({ html: renderMarkdown(req.body?.md) });
});

router.post('/upload', upload.single('image'), verifyCsrf, (req, res) => {
  if (req.file && !isImageFile(req.file.path)) { fs.rm(req.file.path, { force: true }, () => {}); req.file = null; }
  if (!req.file) return res.status(400).json({ error: 'Image invalide (JPEG, PNG, GIF ou WebP, 5 Mo max).' });
  res.json({ url: '/uploads/' + req.file.filename });
});

// ---------- Catégories (admin) ----------
router.get('/categories', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT c.*, (SELECT COUNT(*) FROM posts p WHERE p.category_id = c.id) AS n FROM categories c ORDER BY lang, name').all();
  res.render('admin/categories', { title: 'Catégories', rows });
});

router.post('/categories', requireAdmin, form, verifyCsrf, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 50);
  const description = String(req.body.description || '').trim().slice(0, 200);
  const id = Number(req.body.id) || 0;
  const existing = id ? db.prepare('SELECT lang FROM categories WHERE id = ?').get(id) : null;
  const lang = existing?.lang || (res.locals.langs.includes(req.body.lang) ? req.body.lang : defaultLang(res));
  if (!name) return flashRedirect(res, '/admin/categories', 'Nom obligatoire.');
  const dup = db.prepare('SELECT 1 FROM categories WHERE lower(name) = lower(?) AND lang = ? AND id != ?').get(name, lang, id);
  if (dup) return flashRedirect(res, '/admin/categories', 'Cette catégorie existe déjà dans cette langue.');
  if (id) db.prepare('UPDATE categories SET name=?, slug=?, description=? WHERE id=?').run(name, uniqueSlug('categories', name, id), description, id);
  else db.prepare('INSERT INTO categories(name, slug, description, lang) VALUES(?,?,?,?)').run(name, uniqueSlug('categories', name), description, lang);
  flashRedirect(res, '/admin/categories', 'Catégorie enregistrée.');
});

router.post('/categories/:id/delete', requireAdmin, form, verifyCsrf, (req, res) => {
  db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  flashRedirect(res, '/admin/categories', 'Catégorie supprimée (ses articles ne sont plus classés).');
});

// ---------- Commentaires (admin) ----------
router.get('/comments', requireAdmin, (req, res) => {
  const status = ['pending', 'approved', 'spam'].includes(req.query.status) ? req.query.status : 'pending';
  const rows = db.prepare(`SELECT m.*, p.title AS post_title, p.slug AS post_slug, p.lang AS post_lang FROM comments m JOIN posts p ON p.id = m.post_id
    WHERE m.status = ? ORDER BY m.created_at DESC LIMIT 200`).all(status);
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM comments GROUP BY status').all().map((r) => [r.status, r.n]));
  res.render('admin/comments', { title: 'Commentaires', rows, status, counts });
});

router.post('/comments/:id', requireAdmin, form, verifyCsrf, (req, res) => {
  const action = req.body.action;
  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);
  if (action === 'delete') db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
  else if (['approved', 'pending', 'spam'].includes(action)) {
    db.prepare('UPDATE comments SET status = ? WHERE id = ?').run(action, req.params.id);
    // Première approbation : prévient l'auteur et les autres participants de la discussion.
    if (action === 'approved' && comment && comment.status !== 'approved') {
      const post = db.prepare('SELECT id, title, slug, lang FROM posts WHERE id = ?').get(comment.post_id);
      if (post) notify.commentApproved(comment, post);
    }
  }
  flashRedirect(res, '/admin/comments?status=' + (['pending', 'approved', 'spam'].includes(req.body.back) ? req.body.back : 'pending'), 'Commentaire mis à jour.');
});

// ---------- Newsletter (admin) ----------
router.get('/newsletter', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM subscribers ORDER BY created_at DESC LIMIT 500').all();
  const total = db.prepare('SELECT COUNT(*) n FROM subscribers').get().n;
  const confirmed = db.prepare('SELECT COUNT(*) n FROM subscribers WHERE confirmed = 1').get().n;
  res.render('admin/newsletter', { title: 'Newsletter', rows, total, confirmed, mailReady: mail.enabled() });
});

router.get('/newsletter/export.csv', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT email, lang, confirmed, created_at FROM subscribers ORDER BY created_at').all();
  const csv = ['email,langue,confirme,inscrit_le',
    ...rows.map((r) => `${r.email},${r.lang},${r.confirmed ? 'oui' : 'non'},${new Date(r.created_at).toISOString()}`)].join('\n');
  res.set('Content-Disposition', 'attachment; filename="abonnes.csv"').type('text/csv').send(csv + '\n');
});

router.post('/newsletter/:id/delete', requireAdmin, form, verifyCsrf, (req, res) => {
  db.prepare('DELETE FROM subscribers WHERE id = ?').run(req.params.id);
  flashRedirect(res, '/admin/newsletter', 'Abonné supprimé.');
});

// ---------- Sauvegarde : export / import ----------
function backupPage(res, extra = {}) {
  res.render('admin/backup', {
    title: 'Export / import', report: null,
    categories: db.prepare('SELECT id, name, lang FROM categories ORDER BY lang, name').all(),
    maxFiles: bulk.MAX_FILES, maxLinks: bulk.MAX_LINKS, ...extra,
  });
}

router.get('/backup', requireAdmin, (req, res) => {
  backupPage(res);
});

router.get('/backup/export', requireAdmin, (req, res) => {
  const withImages = req.query.images === '1';
  const categories = db.prepare('SELECT name, slug, description, lang FROM categories ORDER BY id').all();
  const catSlug = new Map(db.prepare('SELECT id, slug FROM categories').all().map((c) => [c.id, c.slug]));
  const userName = new Map(db.prepare('SELECT id, username FROM users').all().map((u) => [u.id, u.username]));
  const out = db.prepare('SELECT * FROM posts ORDER BY id').all().map((p) => {
    const item = {
      title: p.title, slug: p.slug, excerpt: p.excerpt, body_md: p.body_md, status: p.status, lang: p.lang,
      translation_group: p.translation_group, category_slug: catSlug.get(p.category_id) || null,
      author_username: userName.get(p.author_id), views: p.views,
      created_at: p.created_at, updated_at: p.updated_at, published_at: p.published_at,
      cover: p.cover,
      tags: db.prepare('SELECT t.name FROM post_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.post_id = ? ORDER BY t.name').all(p.id).map((t) => t.name),
      comments: db.prepare('SELECT author_name, author_email, body, status, created_at FROM comments WHERE post_id = ? ORDER BY id').all(p.id),
    };
    if (withImages && p.cover?.startsWith('/uploads/')) {
      try {
        const file = path.join(UPLOAD_DIR, path.basename(p.cover));
        const ext = path.extname(file).toLowerCase();
        const type = Object.keys(EXT).find((k) => EXT[k] === ext);
        if (type) item.cover_data = { type, base64: fs.readFileSync(file).toString('base64') };
      } catch { /* image manquante : l'article est exporté sans */ }
    }
    return item;
  });
  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Content-Disposition', `attachment; filename="blog-export-${stamp}.json"`).type('application/json')
    .send(JSON.stringify({ app: 'blog-fabrich', version: 1, exported_at: new Date().toISOString(), categories, posts: out }));
});

const str = (v, max) => String(v ?? '').slice(0, max);
const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.trunc(Number(v)) : null);

router.post('/backup/import', requireAdmin, memUpload.single('file'), verifyCsrf, (req, res) => {
  const fail = (msg) => flashRedirect(res, '/admin/backup', msg);
  if (!req.file) return fail('Aucun fichier reçu.');
  let data;
  try { data = JSON.parse(req.file.buffer.toString('utf8')); } catch { return fail('Fichier JSON invalide.'); }
  if (data?.app !== 'blog-fabrich' || data.version !== 1 || !Array.isArray(data.posts) || !Array.isArray(data.categories)) {
    return fail('Ce fichier n\'est pas un export de ce blog.');
  }
  const def = defaultLang(res);
  const langOf = (l) => (LANGS[l] ? l : def);
  const users = new Map(db.prepare('SELECT username, id FROM users').all().map((u) => [u.username, u.id]));
  const counts = { posts: 0, skipped: 0, categories: 0, comments: 0 };
  const written = []; // images écrites, à supprimer si la transaction échoue

  const tx = db.transaction(() => {
    const catId = new Map();
    for (const c of data.categories) {
      const slug = slugify(str(c.slug, 80)); const name = str(c.name, 50).trim();
      if (!slug || !name) continue;
      let row = db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug);
      if (!row) {
        row = { id: db.prepare('INSERT INTO categories(name, slug, description, lang) VALUES(?,?,?,?)').run(name, slug, str(c.description, 200), langOf(c.lang)).lastInsertRowid };
        counts.categories++;
      }
      catId.set(slug, row.id);
    }
    const groups = new Map(); // ancien groupe de traduction → nouvel id
    for (const p of data.posts) {
      const slug = slugify(str(p.slug, 80)); const title = str(p.title, 200).trim();
      if (!slug || !title) continue;
      if (db.prepare('SELECT 1 FROM posts WHERE slug = ?').get(slug)) { counts.skipped++; continue; }
      const lang = langOf(p.lang);
      const md = str(p.body_md, 2_000_000);
      const now = Date.now();

      let cover = null;
      if (p.cover_data && EXT[p.cover_data.type] && typeof p.cover_data.base64 === 'string') {
        const buf = Buffer.from(p.cover_data.base64, 'base64');
        if (buf.length <= MAX_IMAGE && isImageBuffer(buf)) {
          const name = crypto.randomBytes(12).toString('hex') + EXT[p.cover_data.type];
          fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
          written.push(name);
          cover = '/uploads/' + name;
        }
      } else if (/^\/uploads\/[a-f0-9]{24}\.(jpg|png|gif|webp)$/.test(p.cover || '') && fs.existsSync(path.join(UPLOAD_DIR, path.basename(p.cover)))) {
        cover = p.cover;
      }

      const id = db.prepare(`INSERT INTO posts(title,slug,excerpt,body_md,body_html,cover,status,category_id,author_id,views,created_at,updated_at,published_at,lang,notified_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        title, slug, str(p.excerpt, 400), md, renderMarkdown(md), cover, p.status === 'published' ? 'published' : 'draft',
        catId.get(slugify(str(p.category_slug, 80))) || null, users.get(p.author_username) || req.user.id,
        Math.max(0, int(p.views) || 0), int(p.created_at) || now, int(p.updated_at) || now, int(p.published_at), lang, now, // notified_at : import silencieux
      ).lastInsertRowid;
      const g = int(p.translation_group);
      const clash = g !== null && groups.has(g) && db.prepare('SELECT 1 FROM posts WHERE translation_group = ? AND lang = ?').get(groups.get(g), lang);
      if (g !== null && !groups.has(g)) groups.set(g, id);
      db.prepare('UPDATE posts SET translation_group = ? WHERE id = ?').run(g !== null && groups.has(g) && !clash ? groups.get(g) : id, id);
      posts.setTags(id, Array.isArray(p.tags) ? p.tags.map((t) => str(t, 40).replace(/,/g, ' ')).join(',') : '', lang);

      for (const c of Array.isArray(p.comments) ? p.comments : []) {
        const name = str(c.author_name, 60).trim(); const body = str(c.body, 3000).trim();
        if (!name || !body) continue;
        db.prepare('INSERT INTO comments(post_id, author_name, author_email, body, status, ip, created_at) VALUES(?,?,?,?,?,?,?)')
          .run(id, name, str(c.author_email, 254), body, ['pending', 'approved', 'spam'].includes(c.status) ? c.status : 'pending', null, int(c.created_at) || now);
        counts.comments++;
      }
      counts.posts++;
    }
  });

  try { tx(); } catch (err) {
    for (const f of written) fs.rm(path.join(UPLOAD_DIR, f), { force: true }, () => {});
    console.error('Import :', err);
    return fail('Import annulé : le fichier contient des données invalides.');
  }
  flashRedirect(res, '/admin/backup', `Import terminé : ${counts.posts} article(s), ${counts.categories} catégorie(s), ${counts.comments} commentaire(s) ; ${counts.skipped} ignoré(s) car déjà présent(s).`);
});

// ---------- Sources RSS (admin) ----------
router.get('/sources', requireAdmin, (req, res) => {
  const rows = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM posts p WHERE p.source_id = s.id) AS n,
    (SELECT COUNT(*) FROM follows f WHERE f.kind = 'source' AND f.ref_id = s.id) AS followers FROM sources s ORDER BY s.kind, s.name`).all();
  res.render('admin/sources', { title: 'Sources', rows, error: null, v: {}, refreshMinutes: Number(process.env.FEED_REFRESH_MINUTES ?? 60) });
});

router.post('/sources', requireAdmin, form, verifyCsrf, async (req, res) => {
  const v = { feed_url: String(req.body.feed_url || '').trim(), name: String(req.body.name || '').trim().slice(0, 80), lang: res.locals.langs.includes(req.body.lang) ? req.body.lang : defaultLang(res) };
  const rows = () => db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM posts p WHERE p.source_id = s.id) AS n, 0 AS followers FROM sources s ORDER BY s.kind, s.name`).all();
  const fail = (error) => res.status(400).render('admin/sources', { title: 'Sources', rows: rows(), error, v, refreshMinutes: Number(process.env.FEED_REFRESH_MINUTES ?? 60) });
  const url = feeds.httpUrl(v.feed_url);
  if (!url) return fail('Adresse de flux invalide (http ou https).');
  if (db.prepare('SELECT 1 FROM sources WHERE feed_url = ?').get(url)) return fail('Ce flux est déjà ajouté.');
  let feed;
  try { feed = feeds.parseFeed((await safeFetch(url, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' })).body); }
  catch (err) { return fail(`Flux illisible : ${err.message}`); }
  const name = v.name || feed.title || new URL(url).hostname;
  const id = db.prepare('INSERT INTO sources(name, slug, kind, site_url, feed_url, lang, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(name, uniqueSlug('sources', name), 'feed', feed.siteUrl, url, v.lang, Date.now()).lastInsertRowid;
  const result = await feeds.importSource(db.prepare('SELECT * FROM sources WHERE id = ?').get(id));
  flashRedirect(res, '/admin/sources', result.error ? `Source ajoutée, import en erreur : ${result.error}` : `Source ajoutée : ${result.added} article(s) importé(s).`);
});

router.post('/sources/:id/refresh', requireAdmin, form, verifyCsrf, async (req, res) => {
  const src = db.prepare("SELECT * FROM sources WHERE id = ? AND kind = 'feed'").get(req.params.id);
  if (!src) return res.redirect('/admin/sources');
  const r = await feeds.importSource(src);
  flashRedirect(res, '/admin/sources', r.error ? `Erreur : ${r.error}` : `${r.added} nouvel(s) article(s).`);
});

router.post('/sources/:id/toggle', requireAdmin, form, verifyCsrf, (req, res) => {
  db.prepare('UPDATE sources SET active = 1 - active WHERE id = ?').run(req.params.id);
  flashRedirect(res, '/admin/sources', 'Source mise à jour.');
});

router.post('/sources/:id/delete', requireAdmin, form, verifyCsrf, (req, res) => {
  const id = Number(req.params.id);
  if (req.body.delete_posts) {
    db.prepare('DELETE FROM posts WHERE source_id = ?').run(id);
    db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM post_tags)').run();
  }
  db.prepare("DELETE FROM follows WHERE kind = 'source' AND ref_id = ?").run(id);
  db.prepare('DELETE FROM sources WHERE id = ?').run(id);
  flashRedirect(res, '/admin/sources', 'Source supprimée.');
});

// ---------- Liens proposés par les lecteurs (admin) ----------
function communitySource(lang) {
  let src = db.prepare("SELECT * FROM sources WHERE kind = 'community'").get();
  if (!src) {
    const id = db.prepare("INSERT INTO sources(name, slug, kind, lang, created_at) VALUES('Communauté', ?, 'community', ?, ?)")
      .run(uniqueSlug('sources', 'communaute'), lang, Date.now()).lastInsertRowid;
    src = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  }
  return src;
}

router.get('/submissions', requireAdmin, (req, res) => {
  const base = 'SELECT s.*, u.display_name AS user_name, u.email AS user_email FROM submissions s JOIN users u ON u.id = s.user_id';
  res.render('admin/submissions', {
    title: 'Liens proposés',
    pending: db.prepare(`${base} WHERE s.status = 'pending' ORDER BY s.created_at`).all(),
    done: db.prepare(`${base} WHERE s.status != 'pending' ORDER BY s.reviewed_at DESC LIMIT 20`).all(),
  });
});

router.post('/submissions/:id/approve', requireAdmin, form, verifyCsrf, async (req, res) => {
  const sub = db.prepare("SELECT * FROM submissions WHERE id = ? AND status = 'pending'").get(req.params.id);
  if (!sub) return res.redirect('/admin/submissions');
  const meta = await feeds.pageMeta(sub.url);
  const title = String(req.body.title || sub.title || meta.title || '').trim().slice(0, 200) || new URL(sub.url).hostname;
  const tags = sub.tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 5);
  const postId = feeds.insertExternal({
    title, url: sub.url, excerpt: (sub.description || meta.description || '').slice(0, 300), cover: meta.image || null,
    publishedAt: Date.now(), sourceId: communitySource(defaultLang(res)).id, lang: sub.lang, tags, submittedBy: sub.user_id,
  });
  if (!postId) {
    db.prepare("UPDATE submissions SET status = 'rejected', reviewed_at = ? WHERE id = ?").run(Date.now(), sub.id);
    return flashRedirect(res, '/admin/submissions', 'Ce lien existait déjà : proposition refusée.');
  }
  db.prepare("UPDATE submissions SET status = 'approved', post_id = ?, reviewed_at = ? WHERE id = ?").run(postId, Date.now(), sub.id);
  notify.submissionReviewed(sub, db.prepare('SELECT title, slug, lang FROM posts WHERE id = ?').get(postId));
  flashRedirect(res, '/admin/submissions', 'Lien publié.');
});

router.post('/submissions/:id/reject', requireAdmin, form, verifyCsrf, (req, res) => {
  const sub = db.prepare("SELECT * FROM submissions WHERE id = ? AND status = 'pending'").get(req.params.id);
  db.prepare("UPDATE submissions SET status = 'rejected', reviewed_at = ? WHERE id = ? AND status = 'pending'").run(Date.now(), req.params.id);
  if (sub) notify.submissionReviewed(sub, null);
  flashRedirect(res, '/admin/submissions', 'Proposition refusée.');
});

// Import en masse : plusieurs fichiers Markdown d'un coup (en-tête facultatif), rapport fichier par fichier.
const bulkOpts = (req, res) => ({
  status: req.body.status === 'published' ? 'published' : 'draft',
  lang: res.locals.langs.includes(req.body.lang) ? req.body.lang : defaultLang(res),
  categoryId: Number(req.body.category_id) || null,
  tags: bulk.toList(req.body.tags),
});

router.post('/backup/import-files', requireAdmin, bulkUpload.array('files', bulk.MAX_FILES), verifyCsrf, (req, res) => {
  if (!req.files?.length) return flashRedirect(res, '/admin/backup', 'Aucun fichier reçu.');
  const report = { kind: 'files', ...bulk.importFiles(req.files, bulkOpts(req, res), req.user.id) };
  if (report.counts.created) notify.checkPublished();
  backupPage(res, { report });
});

router.post('/backup/import-links', requireAdmin, form, verifyCsrf, async (req, res) => {
  if (!String(req.body.urls || '').trim()) return flashRedirect(res, '/admin/backup', 'Aucun lien reçu.');
  const opts = bulkOpts(req, res);
  const report = { kind: 'links', ...(await bulk.importLinks(req.body.urls, opts, communitySource(opts.lang).id)) };
  backupPage(res, { report });
});

// ---------- Utilisateurs (admin) ----------
const userRows = (readers = false) => db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM posts p WHERE p.author_id = u.id) AS n,
  (SELECT COUNT(*) FROM post_votes x WHERE x.user_id = u.id) AS votes FROM users u WHERE u.role ${readers ? "=" : "!="} 'reader' ORDER BY created_at DESC LIMIT 300`).all();

router.get('/users', requireAdmin, (req, res) => {
  const readers = req.query.role === 'reader';
  res.render('admin/users', { title: 'Utilisateurs', rows: userRows(readers), readers, error: null, v: {} });
});

router.post('/users', requireAdmin, form, verifyCsrf, (req, res) => {
  const v = {
    username: slugify(req.body.username || '').replace(/-/g, '_'),
    display_name: String(req.body.display_name || '').trim().slice(0, 60),
    email: String(req.body.email || '').trim().toLowerCase(),
    role: req.body.role === 'admin' ? 'admin' : 'author',
  };
  const password = String(req.body.password || '');
  const err = !v.username || !v.display_name ? 'Identifiant et nom requis.'
    : !isEmail(v.email) ? 'E-mail invalide.'
    : password.length < 8 ? 'Mot de passe : 8 caractères minimum.'
    : db.prepare('SELECT 1 FROM users WHERE username = ? OR email = ?').get(v.username, v.email) ? 'Identifiant ou e-mail déjà utilisé.' : null;
  if (err) return res.status(400).render('admin/users', { title: 'Utilisateurs', rows: userRows(), readers: false, error: err, v });
  db.prepare('INSERT INTO users(username,email,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)')
    .run(v.username, v.email, v.display_name, bcrypt.hashSync(password, 12), v.role, Date.now());
  flashRedirect(res, '/admin/users', 'Utilisateur créé.');
});

router.post('/users/:id/delete', requireAdmin, form, verifyCsrf, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return flashRedirect(res, '/admin/users', 'Vous ne pouvez pas supprimer votre propre compte.');
  const target = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
  if (!target) return res.redirect('/admin/users');
  // Les articles importés (sources RSS, liens proposés) sont rattachés à l'administrateur qui supprime ce compte.
  db.prepare('UPDATE posts SET author_id = ? WHERE author_id = ? AND source_id IS NOT NULL').run(req.user.id, id);
  // Supprimer un auteur supprime ses articles : on retire d'abord leurs images.
  for (const p of db.prepare('SELECT cover FROM posts WHERE author_id = ?').all(id)) removeUpload(p.cover);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  flashRedirect(res, '/admin/users', 'Utilisateur et ses articles supprimés.');
});

// ---------- Profil ----------
router.get('/profile', (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.render('admin/profile', { title: 'Mon profil', me, error: null });
});

router.post('/profile', form, verifyCsrf, (req, res) => {
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const display_name = String(req.body.display_name || '').trim().slice(0, 60);
  const email = String(req.body.email || '').trim().toLowerCase();
  const bio = String(req.body.bio || '').trim().slice(0, 300);
  const fail = (error) => res.status(400).render('admin/profile', { title: 'Mon profil', me: { ...me, display_name, email, bio }, error });
  if (!display_name) return fail('Nom affiché requis.');
  if (!isEmail(email)) return fail('E-mail invalide.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, me.id)) return fail('E-mail déjà utilisé.');
  let hash = me.password_hash;
  if (req.body.new_password) {
    if (!bcrypt.compareSync(String(req.body.current_password || ''), me.password_hash)) return fail('Mot de passe actuel incorrect.');
    if (req.body.new_password.length < 8) return fail('Nouveau mot de passe : 8 caractères minimum.');
    hash = bcrypt.hashSync(req.body.new_password, 12);
  }
  db.prepare('UPDATE users SET display_name=?, email=?, bio=?, password_hash=? WHERE id=?').run(display_name, email, bio, hash, me.id);
  if (hash !== me.password_hash) db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(me.id, req.sid);
  flashRedirect(res, '/admin/profile', 'Profil mis à jour.');
});

// ---------- Réglages (admin) ----------
router.get('/settings', requireAdmin, (req, res) => {
  res.render('admin/settings', { title: 'Réglages', allLangs: LANGS, fonts: FONT_LABELS });
});

router.post('/settings', requireAdmin, upload.single('logo'), verifyCsrf, (req, res) => {
  const b = req.body;
  const all = res.locals.siteAll;

  const def = LANGS[b.default_lang] ? b.default_lang : all.default_lang;
  const extra = Object.keys(LANGS).filter((l) => l !== def && [].concat(b.languages || []).includes(l));
  setSetting('default_lang', def);
  setSetting('languages', [def, ...extra].join(','));

  // Textes : langue par défaut → clés de base ; autres langues → clés suffixées.
  for (const l of Object.keys(LANGS)) {
    for (const k of PER_LANG) {
      const val = String(b[`${k}__${l}`] ?? '').trim().slice(0, k === 'site_title' ? 80 : 200);
      if (l === def) setSetting(k, k === 'site_title' ? val || DEFAULT_SETTINGS.site_title : val);
      else setSetting(`${k}_${l}`, val);
    }
  }
  setSetting('posts_per_page', Math.min(50, Math.max(1, parseInt(b.posts_per_page, 10) || 8)));
  setSetting('comments_enabled', b.comments_enabled ? '1' : '0');
  setSetting('comments_moderation', b.comments_moderation ? '1' : '0');
  setSetting('newsletter_enabled', b.newsletter_enabled ? '1' : '0');
  setSetting('landing_enabled', b.landing_enabled ? '1' : '0');

  // Thème : valeurs validées (couleur hex, police de la liste).
  if (HEX.test(b.theme_accent || '')) setSetting('theme_accent', b.theme_accent.toLowerCase());
  if (HEX.test(b.theme_accent_dark || '')) setSetting('theme_accent_dark', b.theme_accent_dark.toLowerCase());
  if (FONT_LABELS[b.theme_font]) setSetting('theme_font', b.theme_font);
  if (req.file && !isImageFile(req.file.path)) { fs.rm(req.file.path, { force: true }, () => {}); req.file = null; }
  if (req.file) { removeUpload(all.theme_logo); setSetting('theme_logo', '/uploads/' + req.file.filename); }
  else if (b.remove_logo) { removeUpload(all.theme_logo); setSetting('theme_logo', ''); }
  if (b.reset_theme) {
    setSetting('theme_accent', DEFAULT_SETTINGS.theme_accent);
    setSetting('theme_accent_dark', DEFAULT_SETTINGS.theme_accent_dark);
    setSetting('theme_font', DEFAULT_SETTINGS.theme_font);
  }
  flashRedirect(res, '/admin/settings', 'Réglages enregistrés.');
});

router.use((req, res) => {
  res.status(404).render('admin/error', { title: 'Introuvable', message: 'Page introuvable.' });
});

module.exports = router;
module.exports.UPLOAD_DIR = UPLOAD_DIR;
