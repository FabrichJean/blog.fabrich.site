const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'blog.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'author' CHECK (role IN ('admin','author','reader')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'fr'
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  excerpt TEXT NOT NULL DEFAULT '',
  body_md TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  cover TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  views INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  lang TEXT NOT NULL DEFAULT 'fr',
  translation_group INTEGER,
  share_token TEXT,
  newsletter_sent_at INTEGER,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  external_url TEXT,
  upvotes INTEGER NOT NULL DEFAULT 0,
  submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notified_at INTEGER
);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  lang TEXT NOT NULL DEFAULT 'fr'
);
CREATE TABLE IF NOT EXISTS post_tags (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_name TEXT NOT NULL,
  author_email TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','spam')),
  ip TEXT,
  created_at INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, status);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'feed' CHECK (kind IN ('feed','community')),
  site_url TEXT NOT NULL DEFAULT '',
  feed_url TEXT UNIQUE,
  lang TEXT NOT NULL DEFAULT 'fr',
  active INTEGER NOT NULL DEFAULT 1,
  last_fetched_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS post_votes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE TABLE IF NOT EXISTS bookmarks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);
CREATE TABLE IF NOT EXISTS reads (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id, day)
);
CREATE INDEX IF NOT EXISTS idx_reads_user ON reads(user_id, read_at DESC);
CREATE TABLE IF NOT EXISTS follows (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('tag','source','author')),
  ref_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, ref_id)
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'fr',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER
);
CREATE TABLE IF NOT EXISTS signup_otps (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'fr',
  next TEXT NOT NULL DEFAULT '',
  salt TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sends INTEGER NOT NULL DEFAULT 1,
  last_sent INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otps_email ON signup_otps(email);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  url TEXT NOT NULL DEFAULT '',
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at, id DESC);
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  lang TEXT NOT NULL DEFAULT 'fr',
  token TEXT NOT NULL UNIQUE,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`);

// Migration d'une base créée avant le multilingue : nouvelles colonnes, et
// suppression du UNIQUE sur le nom des catégories/tags (même nom possible dans deux langues).
if (!db.prepare('PRAGMA table_info(posts)').all().some((c) => c.name === 'lang')) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      ALTER TABLE posts ADD COLUMN lang TEXT NOT NULL DEFAULT 'fr';
      ALTER TABLE posts ADD COLUMN translation_group INTEGER;
      ALTER TABLE posts ADD COLUMN share_token TEXT;
      ALTER TABLE posts ADD COLUMN newsletter_sent_at INTEGER;
      CREATE TABLE categories_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL DEFAULT 'fr');
      INSERT INTO categories_new(id, name, slug, description) SELECT id, name, slug, description FROM categories;
      DROP TABLE categories; ALTER TABLE categories_new RENAME TO categories;
      CREATE TABLE tags_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, lang TEXT NOT NULL DEFAULT 'fr');
      INSERT INTO tags_new(id, name, slug) SELECT id, name, slug FROM tags;
      DROP TABLE tags; ALTER TABLE tags_new RENAME TO tags;
    `);
  })();
  db.pragma('foreign_keys = ON');
}
// Migration vers le fil façon « daily.dev » : sources, votes, favoris, rôle lecteur.
if (!db.prepare('PRAGMA table_info(posts)').all().some((c) => c.name === 'source_id')) {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE posts ADD COLUMN source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL;
      ALTER TABLE posts ADD COLUMN external_url TEXT;
      ALTER TABLE posts ADD COLUMN upvotes INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE posts ADD COLUMN submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
    `);
  })();
}
if (!db.prepare('PRAGMA table_info(comments)').all().some((c) => c.name === 'user_id')) {
  db.exec('ALTER TABLE comments ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
}
// Le CHECK du rôle ne peut pas être modifié : reconstruction de la table users.
if (!/'reader'/.test(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'users'").get().sql)) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        bio TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'author' CHECK (role IN ('admin','author','reader')), created_at INTEGER NOT NULL);
      INSERT INTO users_new SELECT id, username, email, display_name, bio, password_hash, role, created_at FROM users;
      DROP TABLE users; ALTER TABLE users_new RENAME TO users;
    `);
  })();
  db.pragma('foreign_keys = ON');
}
// Notifications : date à laquelle les abonnés d'un article ont été prévenus (les articles existants sont considérés comme déjà notifiés).
if (!db.prepare('PRAGMA table_info(posts)').all().some((c) => c.name === 'notified_at')) {
  db.exec('ALTER TABLE posts ADD COLUMN notified_at INTEGER');
  db.prepare('UPDATE posts SET notified_at = ? WHERE notified_at IS NULL').run(Date.now());
}
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_external ON posts(external_url) WHERE external_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_source ON posts(source_id);
UPDATE posts SET translation_group = id WHERE translation_group IS NULL;
CREATE INDEX IF NOT EXISTS idx_posts_pub ON posts(lang, status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_group ON posts(translation_group);
CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_share ON posts(share_token) WHERE share_token IS NOT NULL;
`);

const DEFAULT_SETTINGS = {
  site_title: 'Mon blog',
  site_description: 'Idées, notes et articles.',
  posts_per_page: '8',
  comments_enabled: '1',
  comments_moderation: '1',
  footer_text: '',
  languages: 'fr',
  default_lang: 'fr',
  newsletter_enabled: '1',
  landing_enabled: '1',
  theme_accent: '#ff4b2b',
  theme_accent_dark: '#ff7a59',
  theme_font: 'sans',
  theme_logo: '',
};
// Textes propres à chaque langue : site_title_en, site_description_en, footer_text_en…
const PER_LANG = ['site_title', 'site_description', 'footer_text'];
const PER_LANG_KEY = new RegExp(`^(${PER_LANG.join('|')})_[a-z]{2}$`);

const putSetting = db.prepare(
  'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

function settings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

function setSetting(key, value) {
  if (!(key in DEFAULT_SETTINGS) && !PER_LANG_KEY.test(key)) return;
  putSetting.run(key, String(value));
}

module.exports = { db, settings, setSetting, DEFAULT_SETTINGS, PER_LANG, DATA_DIR };
