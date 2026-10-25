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
const adminRouter = require('./src/routes/admin');
const publicRouter = require('./src/routes/public');

const app = express();
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
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Fichier trop volumineux (5 Mo max).' });
  console.error(err);
  res.status(500);
  if (req.originalUrl.startsWith('/admin')) return res.render('admin/error', { title: 'Erreur', message: 'Une erreur est survenue.' });
  res.type('text').send('Erreur interne du serveur.');
});

app.listen(PORT, () => {
  console.log(`Blog en ligne sur http://localhost:${PORT}  (admin : /admin)`);
  require('./src/feeds').startScheduler();
});
