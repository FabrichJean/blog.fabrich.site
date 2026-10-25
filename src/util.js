const { Marked } = require('marked');
const hljs = require('highlight.js');
const sanitizeHtml = require('sanitize-html');
const { db } = require('./db');

function slugify(str) {
  return String(str)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// Retourne un slug libre dans `table` (suffixe -2, -3… si besoin).
function uniqueSlug(table, base, excludeId = 0) {
  const root = slugify(base) || 'sans-titre';
  const stmt = db.prepare(`SELECT 1 FROM ${table} WHERE slug = ? AND id != ?`);
  let slug = root;
  for (let i = 2; stmt.get(slug, excludeId); i++) slug = `${root}-${i}`;
  return slug;
}

const SANITIZE = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'figure', 'figcaption', 'del', 'sup', 'sub']),
  allowedAttributes: {
    a: ['href', 'title', 'rel'],
    img: ['src', 'alt', 'title', 'loading'],
    code: ['class'],
    span: ['class'],
    th: ['align'],
    td: ['align'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  transformTags: {
    a: (tag, attribs) => ({
      tagName: 'a',
      attribs: { ...attribs, rel: 'noopener' },
    }),
    img: (tag, attribs) => ({
      tagName: 'img',
      attribs: { ...attribs, loading: 'lazy' },
    }),
  },
  allowedClasses: { code: [/^language-[\w-]+$/, 'hljs'], span: [/^hljs-[\w-]+$/] },
};

// Coloration syntaxique côté serveur (aucun script à charger, compatible CSP).
// Langage inconnu ou absent : détection automatique limitée aux langages courants.
const AUTO_LANGS = ['javascript', 'typescript', 'python', 'bash', 'json', 'html', 'xml', 'css', 'sql', 'yaml', 'java', 'kotlin', 'go', 'rust', 'php', 'c', 'cpp', 'diff', 'markdown', 'ini', 'dockerfile'];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const marked = new Marked({
  renderer: {
    code({ text, lang }) {
      const name = String(lang || '').trim().split(/\s+/)[0].toLowerCase();
      let out, cls = '';
      try {
        if (name && hljs.getLanguage(name)) { out = hljs.highlight(text, { language: name, ignoreIllegals: true }).value; cls = ` language-${name.replace(/[^\w-]/g, '')}`; }
        else if (!name) out = hljs.highlightAuto(text, AUTO_LANGS).value;
        else { out = esc(text); cls = ` language-${name.replace(/[^\w-]/g, '')}`; }
      } catch { out = esc(text); }
      return `<pre><code class="hljs${cls}">${out}\n</code></pre>\n`;
    },
  },
});

// Le HTML produit est assaini : le Markdown peut contenir du HTML brut.
function renderMarkdown(md) {
  return sanitizeHtml(marked.parse(String(md || ''), { gfm: true, breaks: false }), SANITIZE);
}

// Texte brut. sanitize-html échappe les entités ; on les décode car les gabarits échappent déjà à l'affichage.
function stripText(html) {
  return sanitizeHtml(String(html ?? ''), { allowedTags: [], allowedAttributes: {}, nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'] })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

function makeExcerpt(html, max = 180) {
  const text = stripText(html);
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

function readingTime(html) {
  const words = stripText(html).split(' ').filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

const fmtDate = (ms) => (ms ? dateFmt.format(new Date(ms)) : '—');
const fmtDateTime = (ms) => (ms ? dateTimeFmt.format(new Date(ms)) : '—');

// Valeur pour <input type="datetime-local"> (heure locale du serveur).
function toInputDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fromInputDate(str) {
  if (!str) return null;
  const t = new Date(str).getTime();
  return Number.isNaN(t) ? null : t;
}

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;

function escapeXml(s) {
  return String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// Limiteur simple en mémoire (par clé), fenêtre glissante.
function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  return {
    hit(key) {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      arr.push(now);
      hits.set(key, arr);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
      return arr.length > max;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

module.exports = {
  slugify, uniqueSlug, renderMarkdown, makeExcerpt, readingTime, stripText,
  fmtDate, fmtDateTime, toInputDate, fromInputDate, isEmail, escapeXml, rateLimiter,
};
