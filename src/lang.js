const { settings, PER_LANG } = require('./db');
const { LANGS, LOCALES, translate, dateFormatter } = require('./i18n');
const util = require('./util');

// Langues activées (la langue par défaut est toujours incluse et placée en premier).
function enabledLangs(s) {
  const def = LANGS[s.default_lang] ? s.default_lang : 'fr';
  const list = String(s.languages || '').split(',').map((x) => x.trim()).filter((x) => LANGS[x] && x !== def);
  return [def, ...new Set(list)];
}

const prefixFor = (s, lang) => (lang === s.default_lang ? '' : `/${lang}`);

// Prépare res.locals pour rendre une page dans la langue `lang`.
function applyLang(res, lang) {
  const all = res.locals.siteAll || settings();
  const langs = enabledLangs(all);
  if (!langs.includes(lang)) lang = langs[0];
  const site = { ...all };
  if (lang !== all.default_lang) for (const k of PER_LANG) site[k] = all[`${k}_${lang}`] || all[k];

  Object.assign(res.locals, {
    site, lang, langs, prefix: prefixFor(all, lang),
    t: (key, vars) => translate(lang, key, vars),
    fmtDate: (ms) => (ms ? dateFormatter(lang).format(new Date(ms)) : '—'),
    langNames: LANGS,
    today: new Intl.DateTimeFormat(LOCALES[lang] || lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date()),
    // Sélecteur de langue : par défaut la page d'accueil de chaque langue. Les pages d'article le remplacent.
    altLinks: langs.map((l) => ({ lang: l, href: `${prefixFor(all, l)}/`, current: l === lang })),
    hreflang: false,
  });
}

// Réécrit /en/… → /… et fixe la langue ; sans préfixe connu, langue par défaut.
function langMiddleware(req, res, next) {
  const all = res.locals.siteAll;
  const m = req.url.match(/^\/([a-z]{2})(?=\/|\?|$)/);
  const langs = enabledLangs(all);
  if (m && langs.includes(m[1]) && m[1] !== all.default_lang) {
    req.url = req.url.slice(3) || '/';
    if (!req.url.startsWith('/')) req.url = '/' + req.url;
    applyLang(res, m[1]);
  } else {
    applyLang(res, all.default_lang);
  }
  res.locals.path = req.path; // chemin sans préfixe de langue (navigation active)
  next();
}

module.exports = { applyLang, langMiddleware, enabledLangs, prefixFor };
