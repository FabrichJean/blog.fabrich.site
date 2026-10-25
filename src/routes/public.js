const express = require('express');
const { db } = require('../db');
const posts = require('../posts');
const newsletter = require('../newsletter');
const engage = require('../engage');
const otp = require('../otp');
const feeds = require('../feeds');
const bcrypt = require('bcryptjs');
const { login, logout } = require('../auth');
const { applyLang, prefixFor } = require('../lang');
const { isEmail, escapeXml, makeExcerpt, rateLimiter, slugify } = require('../util');

const router = express.Router();
const commentLimiter = rateLimiter({ max: 5, windowMs: 10 * 60 * 1000 });
const subscribeLimiter = rateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
const signupLimiter = rateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
const loginLimiter = rateLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
const form = express.urlencoded({ extended: false, limit: '20kb' });

// Chemin interne uniquement (évite les redirections ouvertes).
const localPath = (p, fallback = '/') => (typeof p === 'string' && /^\/(?!\/|\\)/.test(p) && p.length < 300 ? p : fallback);
const wantsJson = (req) => req.get('x-requested-with') === 'fetch';

const pageNum = (req) => Math.max(1, parseInt(req.query.page, 10) || 1);
const baseUrl = (req) => (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

router.use((req, res, next) => {
  res.locals.sidebar = posts.sidebar(res.locals.lang);
  res.locals.streakNow = req.user ? engage.streak(req.user.id).current : 0;
  res.locals.baseUrl = baseUrl(req);
  res.locals.canonical = res.locals.baseUrl + res.locals.prefix + req.path;
  next();
});

// Onglets de tri d'une page de liste.
function sortTabs(req, res, basePath, current) {
  const { t, prefix } = res.locals;
  return [
    { key: 'latest', label: t('tab_latest'), icon: 'clock', href: `${prefix}${basePath}` },
    { key: 'popular', label: t('tab_popular'), icon: 'fire', href: `${prefix}${basePath}?sort=popular` },
  ].map((x) => ({ ...x, active: x.key === current }));
}

function listPage(req, res, { filter = {}, heading = null, subtitle = null, title = null, basePath, tabs, sort = 'latest', extra = '', follow = null, interests, hint = null, empty = null }) {
  const perPage = parseInt(res.locals.site.posts_per_page, 10) || 12;
  const result = posts.listPublished({ page: pageNum(req), perPage, lang: res.locals.lang, sort, interests, viewerId: req.user?.id, ...filter });
  res.render('index', {
    title, heading, subtitle, ...result, basePath: res.locals.prefix + basePath, query: '', extra,
    tabs: tabs || null, follow, hint, empty,
  });
}

const followState = (req, kind, id, label) => ({ kind, id, label, following: engage.isFollowing(req.user?.id, kind, id) });

// Page de présentation : visiteurs non connectés arrivant sur l'accueil nu (pas d'onglet, pas de pagination).
router.get('/', (req, res, next) => {
  if (req.user || req.query.tab || req.query.page || res.locals.siteAll.landing_enabled !== '1') return next();
  const { lang } = res.locals;
  const now = Date.now();
  const n = (sql, ...a) => db.prepare(sql).get(...a).n;
  const top = posts.listPublished({ page: 1, perPage: 3, lang, sort: 'popular' }).posts;
  res.locals.hreflang = true;
  res.locals.canonical = res.locals.baseUrl + res.locals.prefix + '/';
  res.render('landing', {
    title: null, query: '', landing: true, top,
    counts: {
      posts: n("SELECT COUNT(*) n FROM posts WHERE status='published' AND published_at <= ? AND lang = ?", now, lang),
      sources: n("SELECT COUNT(*) n FROM sources WHERE active = 1"),
      tags: n('SELECT COUNT(*) n FROM tags WHERE lang = ?', lang),
    },
  });
});

router.get('/', (req, res) => {
  const { t, prefix } = res.locals;
  const loggedIn = Boolean(req.user);
  let tab = ['foryou', 'popular', 'latest'].includes(req.query.tab) ? req.query.tab : (loggedIn ? 'foryou' : 'popular');
  if (tab === 'foryou' && !loggedIn) tab = 'popular';
  const interests = loggedIn ? posts.getInterests(req.user.id) : null;
  const tabs = [
    ...(loggedIn ? [{ key: 'foryou', label: t('tab_foryou'), icon: 'sparkle' }] : []),
    { key: 'popular', label: t('tab_popular'), icon: 'fire' },
    { key: 'latest', label: t('tab_latest'), icon: 'clock' },
  ].map((x) => ({ ...x, href: `${prefix}/?tab=${x.key}`, active: x.key === tab }));
  res.locals.hreflang = true;
  res.locals.activeTab = tab;
  listPage(req, res, {
    basePath: '/', tabs, sort: tab, interests, extra: `tab=${tab}`,
    hint: tab === 'foryou' && !interests.any ? t('foryou_hint') : null,
  });
});

const subSort = (req) => (req.query.sort === 'popular' ? 'popular' : 'latest');

router.get('/category/:slug', (req, res, next) => {
  const { t, lang } = res.locals;
  const cat = db.prepare('SELECT * FROM categories WHERE slug = ? AND lang = ?').get(req.params.slug, lang);
  if (!cat) return next();
  const sort = subSort(req); const base = `/category/${cat.slug}`;
  listPage(req, res, {
    filter: { category: cat.slug }, heading: cat.name, subtitle: cat.description, sort, extra: sort === 'popular' ? 'sort=popular' : '',
    title: t('category_title', { name: cat.name }), basePath: base, tabs: sortTabs(req, res, base, sort),
  });
});

router.get('/tag/:slug', (req, res, next) => {
  const { t, lang } = res.locals;
  const tag = db.prepare('SELECT * FROM tags WHERE slug = ? AND lang = ?').get(req.params.slug, lang);
  if (!tag) return next();
  const sort = subSort(req); const base = `/tag/${tag.slug}`;
  listPage(req, res, {
    filter: { tag: tag.slug }, heading: `#${tag.name}`, title: t('tag_title', { name: tag.name }), basePath: base,
    sort, extra: sort === 'popular' ? 'sort=popular' : '', tabs: sortTabs(req, res, base, sort), follow: followState(req, 'tag', tag.id),
  });
});

router.get('/author/:username', (req, res, next) => {
  const author = db.prepare("SELECT id, display_name, username, bio, role FROM users WHERE username = ? AND role != 'reader'").get(req.params.username);
  if (!author) return next();
  const sort = subSort(req); const base = `/author/${author.username}`;
  listPage(req, res, {
    filter: { author: author.username }, heading: author.display_name, subtitle: author.bio, title: author.display_name, basePath: base,
    sort, extra: sort === 'popular' ? 'sort=popular' : '', tabs: sortTabs(req, res, base, sort), follow: followState(req, 'author', author.id),
  });
});

router.get('/source/:slug', (req, res, next) => {
  const src = db.prepare('SELECT * FROM sources WHERE slug = ?').get(req.params.slug);
  if (!src) return next();
  const sort = subSort(req); const base = `/source/${src.slug}`;
  listPage(req, res, {
    filter: { source: src.slug }, heading: src.name, subtitle: src.site_url ? src.site_url.replace(/^https?:\/\//, '') : '', title: src.name, basePath: base,
    sort, extra: sort === 'popular' ? 'sort=popular' : '', tabs: sortTabs(req, res, base, sort), follow: followState(req, 'source', src.id),
  });
});

router.get('/search', (req, res) => {
  const { t, lang, prefix } = res.locals;
  const q = String(req.query.q || '').trim().slice(0, 100);
  const perPage = parseInt(res.locals.site.posts_per_page, 10) || 12;
  const result = q ? posts.listPublished({ page: pageNum(req), perPage, lang, q, viewerId: req.user?.id }) : { posts: [], total: 0, pages: 1, page: 1 };
  res.render('index', {
    title: q ? `${t('search_title')} : ${q}` : t('search_title'),
    heading: q ? t('results_for', { q }) : t('search_title'),
    subtitle: q ? t('found', { n: result.total }) : t('enter_keyword'),
    ...result, basePath: prefix + '/search', query: q, extra: `q=${encodeURIComponent(q)}`, noindex: true, tabs: null, follow: null, hint: null, empty: null,
  });
});

// Explorer : tous les tags (et leurs abonnements) et toutes les sources.
router.get('/tags', (req, res) => {
  const { lang, t } = res.locals;
  const rows = db.prepare(`SELECT t.id, t.name, t.slug, COUNT(p.id) AS n FROM tags t
    JOIN post_tags pt ON pt.tag_id = t.id JOIN posts p ON p.id = pt.post_id AND p.status = 'published' AND p.published_at <= ?
    WHERE t.lang = ? GROUP BY t.id ORDER BY n DESC, t.name`).all(Date.now(), lang);
  const mine = new Set(req.user ? db.prepare("SELECT ref_id FROM follows WHERE user_id = ? AND kind = 'tag'").all(req.user.id).map((r) => r.ref_id) : []);
  res.render('explore', { title: t('nav_tags'), heading: t('nav_tags'), kind: 'tag', items: rows.map((r) => ({ ...r, href: `${res.locals.prefix}/tag/${r.slug}`, label: `#${r.name}`, following: mine.has(r.id) })) });
});

router.get('/sources', (req, res) => {
  const { t } = res.locals;
  const rows = db.prepare(`SELECT s.id, s.name, s.slug, s.site_url, COUNT(p.id) AS n FROM sources s
    LEFT JOIN posts p ON p.source_id = s.id AND p.status = 'published' WHERE s.active = 1 GROUP BY s.id ORDER BY n DESC, s.name`).all();
  const mine = new Set(req.user ? db.prepare("SELECT ref_id FROM follows WHERE user_id = ? AND kind = 'source'").all(req.user.id).map((r) => r.ref_id) : []);
  res.render('explore', { title: t('nav_sources'), heading: t('nav_sources'), kind: 'source', items: rows.map((r) => ({ ...r, href: `${res.locals.prefix}/source/${r.slug}`, label: r.name, following: mine.has(r.id) })) });
});

function loadComments(postId) {
  return db.prepare("SELECT author_name, body, created_at FROM comments WHERE post_id = ? AND status = 'approved' ORDER BY created_at").all(postId);
}

function renderPost(req, res, post, { form: values = {}, flash = null, preview = false } = {}) {
  const { prev, next } = preview ? {} : posts.neighbours(post);
  const siteAll = res.locals.siteAll;

  // Sélecteur de langue : traduction de l'article si elle existe, sinon accueil de la langue.
  const trans = new Map(posts.translations(post).map((x) => [x.lang, x.slug]));
  res.locals.altLinks = res.locals.langs.map((l) => ({
    lang: l,
    href: l === post.lang ? `${prefixFor(siteAll, l)}/post/${post.slug}`
      : trans.has(l) ? `${prefixFor(siteAll, l)}/post/${trans.get(l)}` : `${prefixFor(siteAll, l)}/`,
    current: l === post.lang,
    translated: l === post.lang || trans.has(l),
  }));
  res.locals.hreflang = !preview;
  posts.attachViewer([post], req.user?.id);
  const external = Boolean(post.external_url);

  res.render('post', {
    title: post.title, post, prev, next,
    related: preview ? [] : posts.related(post),
    comments: preview ? [] : loadComments(post.id),
    form: values, flash, preview, external,
    description: post.excerpt || makeExcerpt(post.body_html),
    ogImage: post.cover ? (post.cover.startsWith('http') ? post.cover : baseUrl(req) + post.cover) : null,
    ogType: 'article',
    // Les fiches d'articles externes (contenu hébergé ailleurs) ne sont pas indexées.
    noindex: preview || external,
    startedAt: Date.now(),
  });
}

router.get('/post/:slug', (req, res, next) => {
  const post = posts.findPublishedBySlug(req.params.slug);
  if (!post) return next();
  // L'article existe dans une autre langue : on redirige vers la bonne URL.
  if (post.lang !== res.locals.lang) {
    return res.redirect(301, `${prefixFor(res.locals.siteAll, post.lang)}/post/${post.slug}`);
  }
  // Ne compte pas les visites de l'équipe ; les lecteurs connectés alimentent leur historique et leur série.
  if (!req.user || req.user.role === 'reader') db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').run(post.id);
  if (req.user) engage.recordRead(req.user.id, post.id);
  const { t } = res.locals;
  const c = req.query.commented;
  renderPost(req, res, post, { flash: c ? { ok: true, msg: t(c === 'pending' ? 'thanks_pending' : 'thanks_published') } : null });
});

router.post('/post/:slug/comment', form, (req, res, next) => {
  const post = posts.findPublishedBySlug(req.params.slug);
  if (!post || post.lang !== res.locals.lang) return next();
  const { t, site, prefix } = res.locals;
  const fail = (key, status = 400) => { res.status(status); renderPost(req, res, post, { form: req.body, flash: { ok: false, msg: t(key) } }); };

  if (site.comments_enabled !== '1') return fail('err_disabled', 403);
  // Pot de miel + délai minimal : un humain met plus de 3 s à écrire.
  if (req.body.website) return res.redirect(`${prefix}/post/${post.slug}`);
  if (Date.now() - (parseInt(req.body.t, 10) || 0) < 3000) return fail('err_fast');

  const name = String(req.user ? req.user.display_name : req.body.name || '').trim().slice(0, 60);
  const email = String(req.user ? req.user.email : req.body.email || '').trim().slice(0, 254);
  const body = String(req.body.body || '').trim().slice(0, 3000);
  if (!name || !body) return fail('err_required');
  if (!isEmail(email)) return fail('err_email');
  if ((body.match(/https?:\/\//g) || []).length > 2) return fail('err_links');
  if (commentLimiter.hit(req.ip)) return fail('err_rate', 429);

  // L'équipe publie directement ; un lecteur n'est dispensé de modération qu'après un premier commentaire validé.
  const trusted = req.user && (req.user.role !== 'reader'
    || db.prepare("SELECT 1 FROM comments WHERE user_id = ? AND status = 'approved'").get(req.user.id));
  const status = site.comments_moderation === '1' && !trusted ? 'pending' : 'approved';
  db.prepare('INSERT INTO comments(post_id, author_name, author_email, body, status, ip, created_at, user_id) VALUES(?,?,?,?,?,?,?,?)')
    .run(post.id, name, email, body, status, req.ip, Date.now(), req.user?.id ?? null);
  res.redirect(`${prefix}/post/${post.slug}?commented=${status}#comments`);
});

// Aperçu privé d'un brouillon (lien secret généré dans l'éditeur).
router.get('/preview/:token', (req, res, next) => {
  if (!/^[a-f0-9]{32,64}$/.test(req.params.token)) return next();
  const post = posts.findByShareToken(req.params.token);
  if (!post) return next();
  applyLang(res, post.lang);
  res.locals.sidebar = posts.sidebar(post.lang);
  res.locals.canonical = null;
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  renderPost(req, res, post, { preview: true });
});

// ---------- Comptes lecteurs ----------
const authPage = (res, view, status, data) => res.status(status).render(view, { query: '', noindex: true, ...data });

function csrfOk(req) {
  const token = String(req.body?._csrf || req.get('x-csrf-token') || '');
  return Boolean(req.csrf) && token.length === req.csrf.length && require('crypto').timingSafeEqual(Buffer.from(token), Buffer.from(req.csrf));
}

// Garde des actions de lecteur : session + jeton CSRF. Répond en JSON pour les appels fetch.
function requireReader(req, res, next) {
  const back = localPath(req.body?.next || req.get('referer')?.replace(/^https?:\/\/[^/]+/, ''), res.locals.prefix + '/');
  if (!req.user) {
    const target = `${res.locals.prefix}/login?next=${encodeURIComponent(back)}`;
    return wantsJson(req) ? res.status(401).json({ login: target }) : res.redirect(target);
  }
  if (!csrfOk(req)) {
    return wantsJson(req) ? res.status(403).json({ error: 'csrf' })
      : message(res, res.locals.lang, 'err_csrf', 403, { title: res.locals.t('err_csrf_title') });
  }
  req.backTo = back;
  next();
}

router.get('/signup', (req, res) => {
  if (req.user) return res.redirect(res.locals.prefix + '/');
  authPage(res, 'signup', 200, { title: res.locals.t('signup'), error: null, v: {}, next: localPath(req.query.next, '') });
});

const OTP_COOKIE = 'su';
const setOtpCookie = (res, value, maxAgeMs) => res.append('Set-Cookie', [`${OTP_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAgeMs / 1000)}`, ...(process.env.NODE_ENV === 'production' ? ['Secure'] : [])].join('; '));
const otpToken = (req) => String(req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${OTP_COOKIE}=`))?.slice(OTP_COOKIE.length + 1);
const maskEmail = (e) => e.replace(/^(.{2}).*(@.*)$/, (m, a, d) => `${a}•••${d}`);
const resendLimiter = rateLimiter({ max: 10, windowMs: 60 * 60 * 1000 });

// Étape 1 : on valide le formulaire et on envoie le code ; le compte n'est PAS encore créé.
router.post('/signup', form, async (req, res) => {
  const { t, prefix, lang, site } = res.locals;
  const v = { display_name: String(req.body.display_name || '').trim().slice(0, 60), email: String(req.body.email || '').trim().toLowerCase() };
  const password = String(req.body.password || '');
  const next = localPath(req.body.next, '');
  const fail = (key, status = 400) => authPage(res, 'signup', status, { title: t('signup'), error: t(key), v, next });
  if (req.body.website) return res.redirect(prefix + '/');
  if (signupLimiter.hit(req.ip)) return fail('nl_toomany', 429);
  if (!v.display_name) return fail('err_required');
  if (!isEmail(v.email)) return fail('err_email');
  if (password.length < 8) return fail('err_password');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(v.email)) return fail('err_taken');
  if (!otp.canDeliver()) return fail('otp_unavailable', 503);
  try {
    const token = await otp.start({ email: v.email, displayName: v.display_name, passwordHash: bcrypt.hashSync(password, 12), lang, next, siteTitle: site.site_title });
    setOtpCookie(res, token, 60 * 60 * 1000);
    res.redirect(`${prefix}/signup/verify`);
  } catch (err) {
    console.error('OTP envoi :', err.message);
    fail('otp_send_failed', 502);
  }
});

function otpPage(req, res, row, { error = null, info = null, status = 200 } = {}) {
  res.status(status).render('verify', {
    title: res.locals.t('otp_title'), query: '', noindex: true, error, info,
    email: maskEmail(row.email), devMode: !require('../mail').otpReady(), ttlMin: 10,
  });
}

// Étape 2 : saisie du code reçu par e-mail.
router.get('/signup/verify', (req, res) => {
  if (req.user) return res.redirect(res.locals.prefix + '/');
  const row = otp.find(otpToken(req));
  if (!row) return res.redirect(`${res.locals.prefix}/signup`);
  otpPage(req, res, row, { info: req.query.sent ? res.locals.t('otp_resent') : null });
});

router.post('/signup/verify', form, (req, res) => {
  const { t, prefix } = res.locals;
  const token = otpToken(req);
  const row = otp.find(token);
  if (!row) return res.redirect(`${prefix}/signup`);
  const r = otp.check(token, req.body.code);
  if (r.status === 'wrong') return otpPage(req, res, row, { status: 400, error: t('otp_wrong', { left: r.left }) });
  if (r.status === 'locked') { otp.remove(token); return authPage(res, 'signup', 429, { title: t('signup'), error: t('otp_locked'), v: { display_name: row.display_name, email: row.email }, next: row.next }); }
  if (r.status === 'expired') return otpPage(req, res, row, { status: 400, error: t('otp_expired') });
  if (r.status !== 'ok') return res.redirect(`${prefix}/signup`);

  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(row.email)) { otp.remove(token); return authPage(res, 'signup', 400, { title: t('signup'), error: t('err_taken'), v: {}, next: '' }); }
  const base = slugify(row.display_name).replace(/-/g, '_') || 'lecteur';
  let username = base;
  for (let i = 2; db.prepare('SELECT 1 FROM users WHERE username = ?').get(username); i++) username = `${base}_${i}`;
  const id = db.prepare('INSERT INTO users(username,email,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)')
    .run(username, row.email, row.display_name, row.password_hash, 'reader', Date.now()).lastInsertRowid;
  otp.remove(token);
  setOtpCookie(res, '', 0);
  login(res, id);
  res.redirect(row.next || `${prefix}/tags`);
});

router.post('/signup/resend', form, async (req, res) => {
  const { t, prefix, site } = res.locals;
  const token = otpToken(req);
  const row = otp.find(token);
  if (!row) return res.redirect(`${prefix}/signup`);
  if (resendLimiter.hit(req.ip)) return otpPage(req, res, row, { status: 429, error: t('nl_toomany') });
  try {
    const r = await otp.resend(token, site.site_title);
    if (r.status === 'ok') return res.redirect(`${prefix}/signup/verify?sent=1`);
    if (r.status === 'wait') return otpPage(req, res, row, { status: 429, error: t('otp_wait', { s: r.seconds }) });
    if (r.status === 'max') return otpPage(req, res, row, { status: 429, error: t('otp_max') });
    res.redirect(`${prefix}/signup`);
  } catch (err) {
    console.error('OTP renvoi :', err.message);
    otpPage(req, res, row, { status: 502, error: t('otp_send_failed') });
  }
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(res.locals.prefix + '/');
  authPage(res, 'login', 200, { title: res.locals.t('login'), error: null, next: localPath(req.query.next, '') });
});

router.post('/login', form, (req, res) => {
  const { t, prefix } = res.locals;
  const next = localPath(req.body.next, '');
  const fail = (key, status = 401) => authPage(res, 'login', status, { title: t('login'), error: t(key), next });
  if (loginLimiter.hit(req.ip)) return fail('nl_toomany', 429);
  const id = String(req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ? OR lower(username) = ?').get(id, id);
  const hash = user?.password_hash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali';
  if (!(bcrypt.compareSync(String(req.body.password || ''), hash) && user)) return fail('err_login');
  loginLimiter.reset(req.ip);
  login(res, user.id);
  res.redirect(next || prefix + '/');
});

router.post('/logout', form, (req, res) => {
  if (req.user && csrfOk(req)) logout(req, res);
  res.redirect(res.locals.prefix + '/');
});

// ---------- Interactions : votes, favoris, abonnements ----------
function toggleRoute(action, fn) {
  router.post(`/post/:id/${action}`, form, requireReader, (req, res) => {
    const post = db.prepare("SELECT id FROM posts WHERE id = ? AND status = 'published'").get(Number(req.params.id));
    if (!post) return wantsJson(req) ? res.status(404).json({ error: 'not_found' }) : res.redirect(req.backTo);
    const state = fn(req.user.id, post.id);
    if (wantsJson(req)) return res.json(state);
    res.redirect(req.backTo);
  });
}
toggleRoute('upvote', engage.toggleVote);
toggleRoute('bookmark', engage.toggleBookmark);

router.post('/follow', form, requireReader, (req, res) => {
  const state = engage.toggleFollow(req.user.id, String(req.body.kind), Number(req.body.id));
  if (wantsJson(req)) return state ? res.json(state) : res.status(404).json({ error: 'not_found' });
  res.redirect(req.backTo);
});

function libraryPage(view, opts) {
  router.get(`/${view}`, (req, res) => {
    const { t, prefix } = res.locals;
    if (!req.user) return res.redirect(`${prefix}/login?next=${encodeURIComponent(prefix + '/' + view)}`);
    const perPage = parseInt(res.locals.site.posts_per_page, 10) || 12;
    const result = posts.listPublished({ page: pageNum(req), perPage, viewerId: req.user.id, [opts.filter]: req.user.id });
    res.render('index', {
      title: t(opts.title), heading: t(opts.title), subtitle: null, ...result, basePath: `${prefix}/${view}`, query: '', extra: '',
      noindex: true, tabs: null, follow: null, hint: null, empty: t(opts.empty),
    });
  });
}
libraryPage('bookmarks', { filter: 'bookmarkedBy', title: 'nav_bookmarks', empty: 'empty_bookmarks' });
libraryPage('history', { filter: 'readBy', title: 'nav_history', empty: 'empty_history' });

router.get('/me', (req, res) => {
  const { t, prefix } = res.locals;
  if (!req.user) return res.redirect(`${prefix}/login?next=${encodeURIComponent(prefix + '/me')}`);
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.render('me', {
    title: t('nav_profile'), noindex: true, query: '', me, error: null, flash: req.query.saved ? { ok: true, msg: t('saved') } : null,
    streak: engage.streak(me.id), stats: engage.stats(me.id), followed: engage.followed(me.id),
  });
});

router.post('/me', form, requireReader, (req, res) => {
  const { t, prefix } = res.locals;
  const me = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const display_name = String(req.body.display_name || '').trim().slice(0, 60);
  const bio = String(req.body.bio || '').trim().slice(0, 300);
  const fail = (key) => res.status(400).render('me', {
    title: t('nav_profile'), noindex: true, query: '', me: { ...me, display_name, bio }, error: t(key), flash: null,
    streak: engage.streak(me.id), stats: engage.stats(me.id), followed: engage.followed(me.id),
  });
  if (!display_name) return fail('err_required');
  let hash = me.password_hash;
  if (req.body.new_password) {
    if (!bcrypt.compareSync(String(req.body.current_password || ''), me.password_hash)) return fail('err_login');
    if (req.body.new_password.length < 8) return fail('err_password');
    hash = bcrypt.hashSync(req.body.new_password, 12);
  }
  db.prepare('UPDATE users SET display_name = ?, bio = ?, password_hash = ? WHERE id = ?').run(display_name, bio, hash, me.id);
  if (hash !== me.password_hash) db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(me.id, req.sid);
  res.redirect(`${prefix}/me?saved=1`);
});

// Suppression du compte (réservée aux lecteurs : les comptes d'équipe se gèrent dans l'administration).
router.post('/me/delete', form, requireReader, (req, res) => {
  if (req.user.role !== 'reader') return res.redirect(req.backTo);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id); // supprime aussi sessions, votes, favoris, historique
  require('../auth').logout(req, res);
  res.redirect(res.locals.prefix + '/');
});

// ---------- Proposer un lien ----------
const submitLimiter = rateLimiter({ max: 10, windowMs: 24 * 60 * 60 * 1000 });

router.get('/submit', (req, res) => {
  const { prefix, t } = res.locals;
  if (!req.user) return res.redirect(`${prefix}/login?next=${encodeURIComponent(prefix + '/submit')}`);
  res.render('submit', { title: t('submit_title'), noindex: true, query: '', error: null, v: { lang: res.locals.lang } });
});

router.post('/submit', form, requireReader, (req, res) => {
  const { t, prefix, langs } = res.locals;
  const v = {
    url: String(req.body.url || '').trim(), title: String(req.body.title || '').trim().slice(0, 200),
    description: String(req.body.description || '').trim().slice(0, 300), tags: String(req.body.tags || '').trim().slice(0, 120),
    lang: langs.includes(req.body.lang) ? req.body.lang : res.locals.lang,
  };
  const fail = (key) => res.status(400).render('submit', { title: t('submit_title'), noindex: true, query: '', error: t(key), v });
  const url = feeds.httpUrl(v.url);
  if (!url) return fail('err_url');
  if (db.prepare('SELECT 1 FROM posts WHERE external_url = ?').get(url) || db.prepare("SELECT 1 FROM submissions WHERE url = ? AND status = 'pending'").get(url)) return fail('err_dup');
  if (db.prepare("SELECT COUNT(*) n FROM submissions WHERE user_id = ? AND status = 'pending'").get(req.user.id).n >= 5) return fail('err_pending_max');
  if (submitLimiter.hit(String(req.user.id))) return fail('nl_toomany');
  db.prepare('INSERT INTO submissions(user_id, url, title, description, tags, lang, created_at) VALUES(?,?,?,?,?,?,?)')
    .run(req.user.id, url, v.title, v.description, v.tags, v.lang, Date.now());
  message(res, res.locals.lang, 'submit_thanks', 200, { title: t('submit_title') });
});

// ---------- Newsletter ----------
function message(res, lang, key, status = 200, extra = {}) {
  applyLang(res, lang);
  res.status(status).render('message', { title: res.locals.t('nl_title'), text: res.locals.t(key), noindex: true, query: '', ...extra });
}

router.post('/newsletter/subscribe', form, async (req, res) => {
  const { lang, site } = res.locals;
  if (site.newsletter_enabled !== '1') return res.status(404).end();
  if (req.body.website) return message(res, lang, 'nl_done'); // pot de miel
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!isEmail(email)) return message(res, lang, 'nl_invalid', 400);
  if (subscribeLimiter.hit(req.ip)) return message(res, lang, 'nl_toomany', 429);
  try {
    const result = await newsletter.subscribe(email, lang, res.locals.baseUrl, site.site_title);
    message(res, lang, result === 'confirm' ? 'nl_checkemail' : 'nl_done');
  } catch (err) {
    console.error('Newsletter subscribe :', err.message);
    message(res, lang, 'nl_toomany', 502);
  }
});

router.get('/newsletter/confirm/:token', (req, res) => {
  const sub = db.prepare('SELECT * FROM subscribers WHERE token = ?').get(req.params.token);
  if (!sub) return message(res, res.locals.lang, 'nl_bad_link', 404);
  db.prepare('UPDATE subscribers SET confirmed = 1 WHERE id = ?').run(sub.id);
  message(res, sub.lang, 'nl_confirmed');
});

// GET demande confirmation (les clients mail préchargent les liens) ; POST désinscrit.
router.get('/newsletter/unsubscribe/:token', (req, res) => {
  const sub = db.prepare('SELECT * FROM subscribers WHERE token = ?').get(req.params.token);
  if (!sub) return message(res, res.locals.lang, 'nl_bad_link', 404);
  message(res, sub.lang, 'nl_unsub_text', 200, { unsubscribe: { token: sub.token } });
});

router.post('/newsletter/unsubscribe/:token', form, (req, res) => {
  const sub = db.prepare('SELECT * FROM subscribers WHERE token = ?').get(req.params.token);
  if (!sub) return message(res, res.locals.lang, 'nl_bad_link', 404);
  db.prepare('DELETE FROM subscribers WHERE id = ?').run(sub.id);
  message(res, sub.lang, 'nl_unsub_done');
});

// ---------- Flux et référencement ----------
router.get('/rss.xml', (req, res) => {
  const { site, lang, prefix, baseUrl: base } = res.locals;
  const { posts: items } = posts.listPublished({ page: 1, perPage: 20, lang });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
<title>${escapeXml(site.site_title)}</title>
<link>${base}${prefix}/</link>
<description>${escapeXml(site.site_description)}</description>
<language>${lang}</language>
<atom:link href="${base}${prefix}/rss.xml" rel="self" type="application/rss+xml"/>
${items.map((p) => `<item>
<title>${escapeXml(p.title)}</title>
<link>${base}${prefix}/post/${p.slug}</link>
<guid isPermaLink="true">${base}${prefix}/post/${p.slug}</guid>
<pubDate>${new Date(p.published_at).toUTCString()}</pubDate>
<description>${escapeXml(p.excerpt || makeExcerpt(p.body_html))}</description>
<content:encoded><![CDATA[${p.body_html.replace(/]]>/g, ']]]]><![CDATA[>')}]]></content:encoded>
</item>`).join('\n')}
</channel>
</rss>`;
  res.type('application/rss+xml').send(xml);
});

router.get('/sitemap.xml', (req, res) => {
  const { baseUrl: base, siteAll, langs } = res.locals;
  const now = Date.now();
  const pre = (l) => prefixFor(siteAll, l);
  const urls = langs.map((l) => ({ loc: `${base}${pre(l)}/` }));
  for (const p of db.prepare("SELECT slug, lang, updated_at FROM posts WHERE status='published' AND external_url IS NULL AND published_at <= ?").all(now)) {
    urls.push({ loc: `${base}${pre(p.lang)}/post/${p.slug}`, lastmod: new Date(p.updated_at).toISOString() });
  }
  for (const l of langs) {
    const side = posts.sidebar(l);
    for (const c of side.categories) urls.push({ loc: `${base}${pre(l)}/category/${c.slug}` });
    for (const t of side.tags) urls.push({ loc: `${base}${pre(l)}/tag/${t.slug}` });
  }
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${escapeXml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')}
</urlset>`);
});

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nDisallow: /admin\nDisallow: /preview/\nDisallow: /search\nSitemap: ${res.locals.baseUrl}/sitemap.xml\n`);
});

module.exports = router;
