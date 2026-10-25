const { XMLParser } = require('fast-xml-parser');
const { db } = require('./db');
const { safeFetch, isPrivateIp } = require('./safe-fetch');
const net = require('net');
const { stripText, uniqueSlug, slugify } = require('./util');
const posts = require('./posts');
const notify = require('./notify');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', parseTagValue: false, trimValues: true });
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const text = (v) => (v && typeof v === 'object' ? String(v['#text'] ?? '') : String(v ?? ''));

// URL http(s) publique : les adresses internes (localhost, IP privées, .local/.internal) sont refusées.
const httpUrl = (u) => {
  try {
    const x = new URL(String(u).trim());
    if (!['http:', 'https:'].includes(x.protocol) || x.toString().length > 1000 || x.username || x.password) return null;
    const host = x.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || /\.(local|localhost|internal|lan)$/.test(host) || (net.isIP(host) && isPrivateIp(host))) return null;
    return x.toString();
  } catch { return null; }
};
// Les images externes ne sont acceptées qu'en HTTPS (pas de contenu mixte).
const httpsUrl = (u) => { const x = httpUrl(u); return x && x.startsWith('https://') && x.length <= 500 ? x : null; };

function firstImage(...htmls) {
  for (const h of htmls) {
    const m = /<img[^>]+src=["']([^"']+)["']/i.exec(String(h || ''));
    if (m && httpsUrl(m[1])) return httpsUrl(m[1]);
  }
  return null;
}

// Normalise un flux RSS 2.0 ou Atom en { title, siteUrl, items[] }.
function parseFeed(xml) {
  const doc = parser.parse(xml);
  if (doc.rss?.channel) {
    const ch = doc.rss.channel;
    return {
      title: stripText(text(ch.title)).slice(0, 80), siteUrl: httpUrl(text(ch.link)) || '',
      items: arr(ch.item).map((it) => {
        const html = text(it['content:encoded']) || text(it.description);
        const media = [...arr(it['media:thumbnail']), ...arr(it['media:content'])].map((m) => m?.['@_url']).find(httpsUrl);
        const enc = arr(it.enclosure).find((e) => String(e?.['@_type'] || '').startsWith('image/'))?.['@_url'];
        return {
          title: text(it.title), link: httpUrl(text(it.link) || text(it.guid)), date: text(it.pubDate) || text(it['dc:date']),
          summary: text(it.description) || html, cover: httpsUrl(media) || httpsUrl(enc) || firstImage(html),
          tags: arr(it.category).map(text),
        };
      }),
    };
  }
  if (doc.feed) {
    const f = doc.feed;
    const alt = (links) => arr(links).find((l) => !l['@_rel'] || l['@_rel'] === 'alternate')?.['@_href'];
    return {
      title: stripText(text(f.title)).slice(0, 80), siteUrl: httpUrl(alt(f.link)) || '',
      items: arr(f.entry).map((e) => {
        const html = text(e.content) || text(e.summary);
        const media = [...arr(e['media:thumbnail']), ...arr(e['media:content'])].map((m) => m?.['@_url']).find(httpsUrl);
        return {
          title: text(e.title), link: httpUrl(alt(e.link)), date: text(e.published) || text(e.updated),
          summary: text(e.summary) || html, cover: httpsUrl(media) || firstImage(html),
          tags: arr(e.category).map((c) => c?.['@_term'] || text(c)),
        };
      }),
    };
  }
  throw new Error('Format de flux non reconnu (RSS ou Atom attendu)');
}

const firstAdminId = () => db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get()?.id;

// Insère un article externe (flux ou soumission validée). Retourne l'id, ou null si l'URL existe déjà.
function insertExternal({ title, url, excerpt, cover, publishedAt, sourceId, lang, tags, submittedBy = null }) {
  if (db.prepare('SELECT 1 FROM posts WHERE external_url = ?').get(url)) return null;
  const now = Date.now();
  const authorId = firstAdminId();
  const id = db.prepare(`INSERT INTO posts(title,slug,excerpt,body_md,body_html,cover,status,author_id,created_at,updated_at,published_at,lang,source_id,external_url,submitted_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    title, uniqueSlug('posts', title), excerpt, '', '', cover, 'published', authorId, now, now, Math.min(publishedAt || now, now), lang, sourceId, url, submittedBy,
  ).lastInsertRowid;
  db.prepare('UPDATE posts SET translation_group = id WHERE id = ?').run(id);
  if (tags?.length) posts.setTags(id, tags.join(','), lang);
  return id;
}

async function importSource(source, limit = 30) {
  try {
    const res = await safeFetch(source.feed_url, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' });
    const feed = parseFeed(res.body);
    let added = 0;
    db.transaction(() => {
      for (const it of feed.items.slice(0, limit)) {
        const title = stripText(it.title).slice(0, 200);
        if (!title || !it.link) continue;
        const date = Date.parse(it.date);
        const tags = [...new Set(it.tags.map((t) => stripText(t).slice(0, 30)).filter((t) => slugify(t)))].slice(0, 5);
        const id = insertExternal({
          title, url: it.link, excerpt: stripText(it.summary).slice(0, 300), cover: it.cover,
          publishedAt: Number.isNaN(date) ? Date.now() : date, sourceId: source.id, lang: source.lang, tags,
        });
        if (id) added++;
      }
    })();
    db.prepare('UPDATE sources SET last_fetched_at = ?, last_error = NULL WHERE id = ?').run(Date.now(), source.id);
    notify.sourceBatch(source, added);
    return { added };
  } catch (err) {
    db.prepare('UPDATE sources SET last_fetched_at = ?, last_error = ? WHERE id = ?').run(Date.now(), String(err.message).slice(0, 200), source.id);
    return { error: err.message };
  }
}

async function refreshAll() {
  for (const s of db.prepare("SELECT * FROM sources WHERE kind = 'feed' AND active = 1").all()) {
    const r = await importSource(s);
    console.log(`Flux « ${s.name} » : ${r.error ? 'erreur — ' + r.error : r.added + ' nouveau(x)'}`);
  }
}

// Titre, description et image d'une page (balises Open Graph), pour pré-remplir un lien soumis.
async function pageMeta(url) {
  try {
    const res = await safeFetch(url, { accept: 'text/html', maxBytes: 1024 * 1024 });
    const meta = (name) => {
      const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i');
      const tag = re.exec(res.body)?.[0];
      return tag ? /content=["']([^"']*)["']/i.exec(tag)?.[1] : null;
    };
    const title = meta('og:title') || /<title[^>]*>([^<]*)<\/title>/i.exec(res.body)?.[1];
    return {
      title: stripText(title || '').slice(0, 200), description: stripText(meta('og:description') || meta('description') || '').slice(0, 300),
      image: httpsUrl(meta('og:image')),
    };
  } catch { return {}; }
}

function startScheduler() {
  const mins = Number(process.env.FEED_REFRESH_MINUTES ?? 60);
  if (!(mins > 0)) return;
  setTimeout(() => refreshAll().catch(console.error), 15000).unref();
  setInterval(() => refreshAll().catch(console.error), mins * 60 * 1000).unref();
}

module.exports = { parseFeed, importSource, refreshAll, insertExternal, pageMeta, startScheduler, httpUrl };
