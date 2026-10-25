const { db, settings } = require('./db');
const { LANGS } = require('./i18n');
const { enabledLangs } = require('./lang');
const posts = require('./posts');
const feeds = require('./feeds');
const { slugify, uniqueSlug, renderMarkdown } = require('./util');

const MAX_FILES = 100;
const MAX_LINKS = 30;
const EXT = /\.(md|markdown|txt)$/i;

const clean = (v) => String(v ?? '').trim().replace(/^["']|["']$/g, '').trim();
const toList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => clean(x).replace(/,/g, ' ')).filter(Boolean);

// En-tête YAML minimal (clé: valeur, [a, b], ou liste « - a »). Sans en-tête, tout le fichier est le corps.
function parseFrontMatter(raw) {
  const text = String(raw).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {}; let key = null;
  for (const line of m[1].split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key) { meta[key] = [].concat(meta[key] || [], clean(item[1])); continue; }
    const kv = /^([A-Za-zÀ-ÿ_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    key = kv[1].toLowerCase();
    const val = kv[2].trim();
    meta[key] = val === '' ? '' : /^\[.*\]$/.test(val) ? val.slice(1, -1).split(',').map(clean).filter(Boolean) : clean(val);
  }
  return { meta, body: text.slice(m[0].length) };
}

const pick = (meta, ...keys) => { for (const k of keys) if (meta[k] !== undefined && meta[k] !== '') return meta[k]; return undefined; };
const prettify = (name) => name.replace(EXT, '').replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function statusOf(meta, fallback) {
  const s = String(pick(meta, 'status', 'statut') ?? '').toLowerCase();
  if (['published', 'publie', 'publié'].includes(s)) return 'published';
  if (['draft', 'brouillon'].includes(s)) return 'draft';
  if (String(meta.draft).toLowerCase() === 'true') return 'draft';
  if (String(meta.draft).toLowerCase() === 'false') return 'published';
  const pub = String(meta.published ?? '').toLowerCase();
  if (pub === 'true') return 'published';
  if (pub === 'false') return 'draft';
  return fallback;
}

function findOrCreateCategory(name, lang) {
  const row = db.prepare('SELECT id FROM categories WHERE lower(name) = lower(?) AND lang = ?').get(name, lang);
  if (row) return row.id;
  return db.prepare('INSERT INTO categories(name, slug, description, lang) VALUES(?,?,?,?)').run(name.slice(0, 50), uniqueSlug('categories', name), '', lang).lastInsertRowid;
}

// Importe un fichier Markdown. Retourne une ligne de rapport (jamais d'exception : un fichier en erreur n'arrête pas le lot).
function importFile(file, opts, userId) {
  const row = { name: file.originalname, status: 'error', title: '', message: '', warnings: [], postId: null };
  try {
    if (!EXT.test(file.originalname)) { row.message = /\.json$/i.test(file.originalname) ? 'Fichier JSON : utilisez « Importer un export » ci-dessus.' : 'Format non pris en charge (.md, .markdown ou .txt).'; return row; }
    const raw = file.buffer.toString('utf8');
    if (raw.includes('\u0000')) { row.message = 'Fichier binaire.'; return row; }
    const { meta, body: rawBody } = parseFrontMatter(raw);
    let body = rawBody.replace(/^\s+/, '');
    let title = String(pick(meta, 'title', 'titre') ?? '').trim();
    if (!title) {
      const h1 = /^#\s+(.+?)\s*#*\s*(?:\n|$)/.exec(body);
      if (h1) { title = h1[1].trim(); body = body.slice(h1[0].length).replace(/^\s+/, ''); } else title = prettify(file.originalname);
    }
    title = title.slice(0, 200); row.title = title;
    if (!body.trim()) { row.message = 'Corps vide.'; return row; }

    const lang = LANGS[pick(meta, 'lang', 'language', 'langue')] ? pick(meta, 'lang', 'language', 'langue') : opts.lang;
    if (!enabledLangs(settings()).includes(lang)) row.warnings.push(`langue « ${lang} » non activée dans les réglages : l'article ne sera visible qu'une fois activée`);
    const slug = slugify(String(pick(meta, 'slug') ?? '') || title).slice(0, 80);
    row.slug = slug;
    if (!slug) { row.message = 'Adresse (slug) impossible à déduire.'; return row; }
    if (db.prepare('SELECT 1 FROM posts WHERE slug = ?').get(slug)) { row.status = 'skipped'; row.message = 'Un article avec cette adresse existe déjà.'; return row; }

    const status = statusOf(meta, opts.status);
    const dateRaw = pick(meta, 'date', 'published_at', 'publishedat', 'publie_le') ?? (/^(?!true$|false$)/i.test(String(meta.published ?? 'x')) ? meta.published : undefined);
    let publishedAt = null;
    if (dateRaw) { const t = Date.parse(dateRaw); if (Number.isNaN(t)) row.warnings.push(`date « ${dateRaw} » ignorée`); else publishedAt = t; }
    const now = Date.now();
    if (status === 'published' && !publishedAt) publishedAt = now;
    if (status === 'draft' && publishedAt && publishedAt <= now) publishedAt = null;

    let categoryId = null;
    const catName = pick(meta, 'category', 'categorie', 'catégorie');
    if (catName) categoryId = findOrCreateCategory(String(catName), lang);
    else if (opts.categoryId) {
      const def = db.prepare('SELECT id, lang FROM categories WHERE id = ?').get(opts.categoryId);
      if (def && def.lang === lang) categoryId = def.id; else if (def) row.warnings.push('catégorie par défaut ignorée (autre langue)');
    }

    const tags = [...new Set([...toList(pick(meta, 'tags', 'tag', 'etiquettes', 'étiquettes')), ...opts.tags])].slice(0, 15);
    const coverRaw = clean(pick(meta, 'cover', 'image') ?? '');
    const cover = /^https:\/\/\S{1,480}$/.test(coverRaw) ? coverRaw : null;
    if (coverRaw && !cover) row.warnings.push('image de couverture ignorée (URL https attendue)');

    const run = db.transaction(() => {
      const id = db.prepare(`INSERT INTO posts(title,slug,excerpt,body_md,body_html,cover,status,category_id,author_id,created_at,updated_at,published_at,lang,notified_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(title, slug, String(pick(meta, 'excerpt', 'description', 'extrait', 'summary') ?? '').slice(0, 400), body,
        renderMarkdown(body), cover, status, categoryId, userId, now, now, publishedAt, lang, now).lastInsertRowid; // notified_at : import silencieux, pas de notification
      db.prepare('UPDATE posts SET translation_group = id WHERE id = ?').run(id);
      posts.setTags(id, tags.join(','), lang);
      return id;
    });
    row.postId = run();
    row.status = 'created';
    row.message = status === 'published' ? (publishedAt > now ? 'Programmé.' : 'Publié.') : 'Brouillon.';
    row.translationOf = String(pick(meta, 'translation_of', 'translation', 'traduction_de') ?? '').trim();
    row.lang = lang;
  } catch (err) {
    console.error('Import en masse :', err);
    row.status = 'error'; row.message = 'Erreur inattendue sur ce fichier.';
  }
  return row;
}

// Relie les traductions déclarées (translation_of: slug) une fois tous les fichiers du lot importés.
function linkTranslations(rows) {
  for (const r of rows) {
    if (r.status !== 'created' || !r.translationOf) continue;
    const target = db.prepare('SELECT id, lang, translation_group FROM posts WHERE slug = ?').get(slugify(r.translationOf));
    if (!target) { r.warnings.push(`traduction non liée : « ${r.translationOf} » introuvable`); continue; }
    if (target.lang === r.lang) { r.warnings.push('traduction non liée : même langue que l\'article cible'); continue; }
    if (db.prepare('SELECT 1 FROM posts WHERE translation_group = ? AND lang = ?').get(target.translation_group, r.lang)) { r.warnings.push('traduction non liée : cette langue existe déjà dans le groupe'); continue; }
    db.prepare('UPDATE posts SET translation_group = ? WHERE id = ?').run(target.translation_group, r.postId);
    r.message += ' Liée comme traduction.';
  }
}

function importFiles(files, opts, userId) {
  const rows = files.slice(0, MAX_FILES).map((f) => importFile(f, opts, userId));
  linkTranslations(rows);
  const counts = { created: 0, skipped: 0, error: 0 };
  for (const r of rows) counts[r.status]++;
  return { rows, counts, truncated: files.length > MAX_FILES };
}

// Liste de liens (un par ligne) : chaque page devient un article externe de la source « Communauté ».
async function importLinks(text, opts, sourceId) {
  const lines = [...new Set(String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
  const rows = lines.slice(0, MAX_LINKS).map((line) => ({ name: line.slice(0, 100), status: 'error', title: '', message: '', warnings: [], url: feeds.httpUrl(line) }));
  const todo = [];
  for (const r of rows) {
    if (!r.url) r.message = 'Adresse invalide ou interne (http ou https public attendu).';
    else if (db.prepare('SELECT 1 FROM posts WHERE external_url = ?').get(r.url)) { r.status = 'skipped'; r.message = 'Ce lien existe déjà.'; } else todo.push(r);
  }
  // 5 pages récupérées en parallèle au plus.
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(5, todo.length) }, async () => {
    while (i < todo.length) {
      const r = todo[i++];
      const meta = await feeds.pageMeta(r.url);
      if (!meta.title) r.warnings.push('titre non récupéré : adresse utilisée comme titre');
      const title = (meta.title || r.url.replace(/^https?:\/\/(www\.)?/, '')).slice(0, 200);
      try {
        const id = feeds.insertExternal({ title, url: r.url, excerpt: meta.description || '', cover: meta.image || null, publishedAt: Date.now(), sourceId, lang: opts.lang, tags: opts.tags });
        r.title = title;
        if (id) { r.status = 'created'; r.postId = id; r.message = 'Ajouté.'; } else { r.status = 'skipped'; r.message = 'Ce lien existe déjà.'; }
      } catch (err) { console.error('Import de liens :', err); r.message = 'Erreur inattendue.'; }
    }
  }));
  const counts = { created: 0, skipped: 0, error: 0 };
  for (const r of rows) counts[r.status]++;
  return { rows, counts, truncated: lines.length > MAX_LINKS };
}

module.exports = { parseFrontMatter, importFiles, importLinks, toList, MAX_FILES, MAX_LINKS };
