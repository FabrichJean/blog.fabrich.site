// Données de démonstration : node scripts/seed-demo.js  (ou npm run demo)
// Crée un admin (demo@example.com / demodemo), un lecteur, des catégories, tags, articles, sources et commentaires.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { db, setSetting } = require('../src/db');
const { renderMarkdown, uniqueSlug } = require('../src/util');
const posts = require('../src/posts');

if (db.prepare('SELECT COUNT(*) n FROM users').get().n) {
  console.error('La base contient déjà des comptes : seed annulé (utilisez une base vide, ex. DATA_DIR=./data-demo).');
  process.exit(1);
}
const UP = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
fs.mkdirSync(UP, { recursive: true });

// Couvertures SVG générées (palette du thème).
const PALETTES = [['#ff4b2b', '#16140f'], ['#c6f432', '#16140f'], ['#9ad1ff', '#16140f'], ['#c9b6ff', '#16140f'], ['#ffd66b', '#16140f'], ['#7fe0b0', '#16140f']];
function cover(i, label) {
  const [bg, fg] = PALETTES[i % PALETTES.length];
  const shapes = [
    `<circle cx="640" cy="120" r="230" fill="${fg}" opacity=".12"/><circle cx="640" cy="120" r="140" fill="${fg}" opacity=".12"/>`,
    `<g stroke="${fg}" stroke-width="3" opacity=".18">${Array.from({ length: 14 }, (_, k) => `<path d="M${-100 + k * 80} 500 L${300 + k * 80} -20"/>`).join('')}</g>`,
    `<g fill="${fg}" opacity=".16">${Array.from({ length: 40 }, (_, k) => `<circle cx="${40 + (k % 10) * 80}" cy="${40 + Math.floor(k / 10) * 80}" r="9"/>`).join('')}</g>`,
  ][i % 3];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 520"><rect width="800" height="520" fill="${bg}"/>${shapes}<text x="400" y="330" text-anchor="middle" font-family="Georgia,serif" font-style="italic" font-weight="700" font-size="200" fill="${fg}">${label}</text></svg>`;
  const file = `demo-${i}.svg`;
  fs.writeFileSync(path.join(UP, file), svg);
  return `/uploads/${file}`;
}

const now = Date.now(); const H = 3600e3;
const uid = (u, e, n, role, pw) => db.prepare('INSERT INTO users(username,email,display_name,bio,password_hash,role,created_at) VALUES(?,?,?,?,?,?,?)')
  .run(u, e, n, role === 'reader' ? '' : 'Écrit sur le logiciel, la fiabilité et les outils qui durent.', bcrypt.hashSync(pw, 10), role, now).lastInsertRowid;
const admin = uid('demo', 'demo@example.com', 'Camille Laurent', 'admin', 'demodemo');
const reader = uid('lecteur', 'lecteur@example.com', 'Alex Martin', 'reader', 'demodemo');
setSetting('site_title', 'La Gazette'); setSetting('site_description', 'Le quotidien des développeurs : lectures choisies, débats et bonnes pratiques.');

const cat = (n) => db.prepare('INSERT INTO categories(name, slug, description, lang) VALUES(?,?,?,?)').run(n, uniqueSlug('categories', n), '', 'fr').lastInsertRowid;
const [cEng, cOps, cCarr] = [cat('Ingénierie'), cat('Infra & Ops'), cat('Carrière')];

const md = (t) => t.trim();
const ARTICLES = [
  ['Pourquoi nous avons quitté les microservices (et ce que nous avons gardé)', cEng, 'architecture, monolithe, équipe', 3, `Après dix-huit mois de **services minuscules**, notre temps de déploiement avait triplé et personne ne comprenait plus le graphe d'appels.\n\n## Ce qui n'a pas marché\n\nChaque équipe possédait trois services, mais aucun produit. Le coût de coordination dépassait le gain d'autonomie.\n\n> Une frontière de service est une promesse de stabilité. Ne la faites pas avant de savoir ce qui est stable.\n\n## Ce que nous avons gardé\n\n- Des modules isolés dans un seul dépôt\n- Un bus d'événements interne\n- Les deux services qui avaient une vraie charge distincte\n\n\`\`\`js\nexport function charge(order) {\n  return ledger.append({ type: 'charge', amount: order.total });\n}\n\`\`\`\n\nLe résultat : déploiements en 6 minutes, une astreinte lisible.`],
  ['SQLite en production : ce que personne ne vous dit', cEng, 'sqlite, base-de-donnees, performance', 8, `SQLite n'est pas un jouet. Avec le mode **WAL**, une seule machine encaisse des milliers d'écritures par seconde.\n\n## Réglages utiles\n\n- \`journal_mode = WAL\`\n- \`synchronous = NORMAL\`\n- \`busy_timeout\` généreux\n\nLa vraie limite est ailleurs : la réplication. Litestream règle la moitié du problème.`],
  ['Écrire des post-mortems que les gens lisent vraiment', cOps, 'incident, culture, ops', 14, `Un bon post-mortem tient sur une page et répond à trois questions : que s'est-il passé, pourquoi nous ne l'avons pas vu venir, qu'allons-nous changer.\n\n## Le piège du coupable\n\nDès qu'un nom apparaît, les gens se protègent et l'information disparaît.`],
  ['Le guide du premier poste de staff engineer', cCarr, 'carriere, management, staff', 26, `Le passage de senior à staff est surtout un changement de **levier** : vous ne livrez plus du code, vous rendez les autres plus efficaces.\n\n## Trois habitudes\n\n1. Écrire plus que coder\n2. Choisir peu de combats\n3. Documenter les décisions`],
  ['Rust pour les équipes web : trois mois après', cEng, 'rust, web, retour-experience', 40, `Nous avons réécrit un service de génération de PDF en Rust. Moins de mémoire, plus de latence prévisible, une courbe d'apprentissage réelle.\n\n\`\`\`rust\nfn main() { println!("Hello"); }\n\`\`\``],
  ['Observabilité sans budget illimité', cOps, 'observabilite, ops, logs', 55, `Les logs structurés + quelques métriques bien choisies couvrent 90 % des besoins. Le reste est du confort coûteux.`],
  ['Pourquoi vos revues de code sont lentes', cEng, 'code-review, equipe, productivite', 80, `La latence d'une revue vient de la **file d'attente**, pas du relecteur. Réduisez la taille des changements et la durée de la file chute.`],
  ['Accessibilité : les 10 corrections qui comptent', cEng, 'accessibilite, web, css', 110, `Contrastes, focus visible, libellés de formulaires, ordre logique : on traite 80 % des problèmes sans refonte.`],
];
const insert = db.prepare(`INSERT INTO posts(title,slug,excerpt,body_md,body_html,cover,status,category_id,author_id,created_at,updated_at,published_at,lang,views,upvotes)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const ids = [];
ARTICLES.forEach(([title, c, tags, hAgo, body], i) => {
  const t = now - hAgo * H;
  const id = insert.run(title, uniqueSlug('posts', title), '', md(body), renderMarkdown(body), i % 4 === 3 ? null : cover(i, title.slice(0, 1)), 'published', c, admin, t, t, t, 'fr', 40 + i * 37, 12 - i).lastInsertRowid;
  db.prepare('UPDATE posts SET translation_group = id WHERE id = ?').run(id);
  posts.setTags(id, tags, 'fr'); ids.push(id);
});
db.prepare("UPDATE posts SET excerpt = 'Dix-huit mois de services minuscules, un déploiement trois fois plus lent : retour d''expérience sur ce qu''on garde et ce qu''on jette.' WHERE id = ?").run(ids[0]);

// Sources externes
const src = (n, url) => db.prepare("INSERT INTO sources(name, slug, kind, site_url, feed_url, lang, last_fetched_at, created_at) VALUES(?,?,'feed',?,?,'fr',?,?)").run(n, uniqueSlug('sources', n), url, url + '/feed', now, now).lastInsertRowid;
const [s1, s2] = [src('Le Journal du Hacker', 'https://www.journalduhacker.net'), src('Dev.to FR', 'https://dev.to')];
const ext = db.prepare(`INSERT INTO posts(title,slug,excerpt,body_md,body_html,cover,status,author_id,created_at,updated_at,published_at,lang,source_id,external_url,upvotes,views)
  VALUES(?,?,?,?,?,?,'published',?,?,?,?,'fr',?,?,?,?)`);
[
  ['Les 8 erreurs courantes avec les index PostgreSQL', 'Un index mal choisi coûte plus qu\'il ne rapporte. Voici comment les repérer avec EXPLAIN.', s1, 'https://example.com/postgres-index', 'postgres, sql, performance', 2, 21],
  ['Un tour de TypeScript 6 : ce qui change vraiment', 'Les nouveautés qui comptent au quotidien, sans le bruit marketing.', s2, 'https://example.com/typescript-6', 'typescript, javascript', 5, 34],
  ['Git est un graphe : arrêtez de mémoriser des commandes', 'Comprendre le modèle plutôt que les recettes.', s1, 'https://example.com/git-graph', 'git, outils', 9, 17],
  ['CSS moderne : container queries en pratique', 'Des composants vraiment indépendants de leur contexte.', s2, 'https://example.com/container-queries', 'css, web', 18, 12],
].forEach(([title, ex, s, url, tags, hAgo, up], i) => {
  const t = now - hAgo * H;
  const id = ext.run(title, uniqueSlug('posts', title), ex, '', '', i === 1 ? cover(i + 2, 'TS') : null, admin, t, t, t, s, url, up, 80 + up * 6).lastInsertRowid;
  db.prepare('UPDATE posts SET translation_group = id WHERE id = ?').run(id);
  posts.setTags(id, tags, 'fr');
});

const com = db.prepare("INSERT INTO comments(post_id, author_name, author_email, body, status, created_at, user_id) VALUES(?,?,?,?,?,?,?)");
com.run(ids[0], 'Alex Martin', 'lecteur@example.com', 'Très juste sur le coût de coordination. Nous avons vécu la même chose en 2023.', 'approved', now - 2 * H, reader);
com.run(ids[0], 'Sam', 'sam@example.com', 'Et pour la montée en charge, vous avez gardé quels services séparés ?', 'approved', now - 1 * H, null);
db.prepare('INSERT OR IGNORE INTO post_votes(user_id, post_id, created_at) VALUES(?,?,?)').run(reader, ids[1], now);
for (let d = 0; d < 9; d++) if (d !== 4) db.prepare('INSERT OR IGNORE INTO reads(user_id, post_id, day, read_at) VALUES(?,?,?,?)').run(reader, ids[d % ids.length], new Date(now - d * 86400000).toISOString().slice(0, 10), now - d * 86400000);
console.log('Démo prête.\n  Admin   : demo@example.com / demodemo\n  Lecteur : lecteur@example.com / demodemo');
