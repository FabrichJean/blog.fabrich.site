require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const { settings } = require('./src/db');
const { loadSession } = require('./src/auth');
const util = require('./src/util');
const { applyLang, langMiddleware } = require('./src/lang');
const { themeCss } = require('./src/theme');
const { icon, flag } = require('./src/icons');
const notify = require('./src/notify');
const adminRouter = require('./src/routes/admin');
const publicRouter = require('./src/routes/public');

// Régénère le HTML des articles dont le code n'est pas encore coloré (idempotent).
(function rehighlight() {
  const { db } = require('./src/db');
  const rows = db.prepare("SELECT id, body_md FROM posts WHERE body_md LIKE '%```%' AND body_html LIKE '%<pre>%' AND body_html NOT LIKE '%hljs%'").all();
  const upd = db.prepare('UPDATE posts SET body_html = ? WHERE id = ?');
  db.transaction(() => { for (const r of rows) upd.run(util.renderMarkdown(r.body_md), r.id); })();
  if (rows.length) console.log(`Coloration du code appliquée à ${rows.length} article(s).`);
})();

const app = express();
// Version des assets statiques (date de modification du CSS) pour contourner les caches.
app.locals.assetV = require('fs').statSync(path.join(__dirname, 'public/css/style.css')).mtimeMs.toString(36);
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);
app.disable('x-powered-by');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: isProd ? [] : null,
    },
  },
  strictTransportSecurity: isProd,
}));

app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: isProd ? '7d' : 0 }));
app.use('/uploads', express.static(adminRouter.UPLOAD_DIR, {
  maxAge: isProd ? '30d' : 0,
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

app.use(loadSession);
app.use((req, res, next) => {
  res.locals.siteAll = settings();
  Object.assign(res.locals, {
    fmtDateTime: util.fmtDateTime, readingTime: util.readingTime,
    noindex: false, description: null, ogImage: null, ogType: 'website', canonical: null, flash: null,
  });
  Object.assign(res.locals, {
    icon, flag, path: req.path, currentUrl: req.originalUrl.slice(0, 300),
    // Couleur d'avatar stable (8 teintes) d'après le nom, sans style en ligne (CSP).
    avatarClass: (name) => 'c' + ([...String(name)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 8),
    hostOf: (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } },
  });
  // Cloche de notifications (site et administration).
  res.locals.notifCount = req.user ? notify.unreadCount(req.user.id) : 0;
  res.locals.notifRecent = req.user && !req.path.startsWith('/events') ? notify.recent(req.user.id, 8) : [];
  res.locals.notifText = (row) => notify.textOf(row, res.locals.lang);
  applyLang(res, res.locals.siteAll.default_lang);
  next();
});

app.get('/theme.css', (req, res) => {
  res.type('text/css').set('Cache-Control', isProd ? 'public, max-age=3600' : 'no-cache').send(themeCss(res.locals.siteAll));
});

app.use('/admin', adminRouter);
// Préfixe de langue (/en/…) puis site public.
app.use(langMiddleware);
app.use('/', publicRouter);

app.use((req, res) => {
  res.status(404).render('404', { title: res.locals.t('not_found'), sidebar: require('./src/posts').sidebar(res.locals.lang), baseUrl: '', noindex: true });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (String(err.code).startsWith('LIMIT_') && req.originalUrl.startsWith('/admin/backup/import-files')) {
    const msg = err.code === 'LIMIT_FILE_COUNT' ? 'Trop de fichiers (100 maximum par lot).' : 'Un fichier dépasse 1 Mo : rien n\'a été importé.';
    return res.redirect('/admin/backup?ok=' + encodeURIComponent('Import impossible : ' + msg));
  }
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Fichier trop volumineux (5 Mo max).' });
  console.error(err);
  res.status(500);
  if (req.originalUrl.startsWith('/admin')) return res.render('admin/error', { title: 'Erreur', message: 'Une erreur est survenue.' });
  res.type('text').send('Erreur interne du serveur.');
});

app.listen(PORT, () => {
  console.log(`Blog en ligne sur http://localhost:${PORT}  (admin : /admin)`);
  require('./src/feeds').startScheduler();
  notify.start();
});
