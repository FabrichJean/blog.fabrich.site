# Plateforme de blog

Un fil d'articles façon [daily.dev](https://daily.dev), habillé en **gazette éditoriale** : papier et encre (clair/sombre), titres en serif expressif (Fraunces), grille « une + cartes », couvertures génératives, onglets **Pour vous / Populaires / Récents**, votes, favoris, historique et séries de lecture, abonnements aux tags et sources, agrégation de flux RSS et liens proposés par les lecteurs.

Blog complet en Node.js : Express, SQLite (fichier unique), EJS, Markdown. Aucun service externe.

## Démarrage

```bash
npm install
cp .env.example .env     # facultatif
npm start                # http://localhost:3000
```

À la première visite, `/admin` redirige vers **/admin/setup** pour créer le compte administrateur.
Le port se règle dans `.env` (`PORT`) ou en ligne : `PORT=3457 npm start`.

## Fonctionnalités

**Site public** : accueil paginé, article (temps de lecture, vues, articles voisins et liés), catégories, tags, pages auteur, recherche, commentaires, flux RSS (`/rss.xml`), `sitemap.xml`, `robots.txt`, balises SEO / Open Graph, thème clair/sombre automatique, responsive.

**Administration** (`/admin`) :
- Tableau de bord (stats, derniers articles, plus lus)
- Articles : éditeur Markdown (barre d'outils, raccourcis Ctrl/Cmd+B/I/K, aperçu fidèle, upload d'images), brouillon / publié / **programmé** (date future), catégorie, tags, extrait, slug, image de couverture
- Catégories, modération des commentaires (approuver / spam / supprimer), utilisateurs, réglages du site, profil et mot de passe
- Rôles : **admin** (tout) et **auteur** (ses propres articles uniquement)

**Sécurité** : mots de passe bcrypt, sessions en base (cookie HttpOnly + SameSite), jeton CSRF sur toutes les actions admin, limitation des tentatives de connexion, HTML Markdown assaini (sanitize-html), CSP et en-têtes via helmet, uploads limités aux images (5 Mo, noms aléatoires), commentaires échappés avec pot de miel, délai minimal et limitation par IP.

## Notifications en temps réel

Une cloche (site et administration) affiche le nombre de notifications non lues ; une pastille apparaît en direct dans tous les onglets ouverts, sans recharger la page (Server-Sent Events sur `/events`, aucune dépendance en plus). Liste déroulante, page `/notifications`, « tout marquer comme lu », compteur dans le titre de l'onglet, textes dans la langue de la page.

| Pour qui | Événement |
|---|---|
| Lecteur | son commentaire est approuvé · quelqu'un d'autre commente une discussion où il a écrit · son lien proposé est publié ou refusé |
| Lecteur | un nouvel article est publié dans un **tag** ou par un **auteur** qu'il suit (aussi à l'heure d'un article programmé) · **une seule** notification par import RSS pour une **source** suivie |
| Admin | un commentaire attend la modération · un lien est proposé |

Détails : un article n'est notifié qu'une fois (jamais l'auteur lui-même), les anciens articles ne déclenchent rien à la mise à jour, les notifications de plus de 60 jours sont purgées, une notification n'est lisible que par son destinataire. **Limite** : les connexions temps réel sont gardées en mémoire du processus, donc une seule instance du serveur (pour plusieurs instances, il faudrait un bus type Redis). Derrière nginx, désactivez le buffering sur `/events` (`proxy_buffering off;`, l'en-tête `X-Accel-Buffering: no` est déjà envoyé).

## Landing page

Les visiteurs non connectés qui arrivent sur l'accueil (`/`, `/en/`…) voient une page de présentation : accroche, aperçu des articles du moment, chiffres réels (articles, sources, tags), fonctionnalités, étapes, FAQ et appel à l'inscription. Le fil reste accessible via `/?tab=popular`, et les lecteurs connectés arrivent directement sur le fil. Désactivable dans **Réglages** (« Page de présentation… »). Textes dans `src/i18n.js` (clés `land_*`, en français, anglais et espagnol).

## Fil, comptes lecteurs et interactions

- **Look** : thème clair/sombre (préférence du système, bascule mémorisée ; `?theme=light|dark` pour forcer), polices auto-hébergées (`public/fonts`, licence OFL), barre de rubriques collante, « À la une » + grille, couverture générative quand l'article n'a pas d'image, barre de progression de lecture, barre d'onglets sur mobile.
- **Raccourcis clavier** : `/` recherche, `j` / `k` carte suivante / précédente, `u` voter, `b` favori, `o` ouvrir.
- **Démo** : `DATA_DIR=./data-demo UPLOAD_DIR=./data-demo/uploads npm run demo` remplit une base vide avec des articles, sources et comptes d'essai (`demo@example.com` / `lecteur@example.com`, mot de passe `demodemo`).
- **Comptes lecteurs** (`/signup`, `/login`) : votes (▲), favoris, historique, **série de lecture** (jours consécutifs), profil, suppression du compte. Les lecteurs n'ont pas accès à `/admin`. **Inscription avec code OTP** : après le formulaire, un code à 6 chiffres est envoyé à l'adresse indiquée et le compte n'est créé qu'une fois le code saisi (10 min de validité, 5 essais, renvoi toutes les 60 s, 5 envois max ; code haché en base). L'envoi passe par un modèle d'e-mail (API emaildo : `EMAILDO_API_KEY`, `EMAILDO_SERVICE_ID`, `EMAILDO_OTP_TEMPLATE_ID`, variables du modèle : `{{prenom}}`, `{{code_otp}}`, `{{entreprise}}`), à défaut par SMTP (`SMTP_URL` / `MAIL_FROM`). **Sans envoi configuré** : en développement le code s'affiche dans la console du serveur ; avec `NODE_ENV=production` l'inscription est refusée (jamais de compte sans adresse vérifiée).
- **Pour vous** : classement calculé à partir des tags/sources/auteurs suivis, des tags des articles votés ou mis en favori, de la fraîcheur et de la popularité ; les articles déjà lus remontent moins. **Populaires** : engagement (votes, commentaires, vues) pondéré par l'âge. Le classement porte sur les 500 articles publiés les plus récents de la langue.
- **Explorer** : `/tags` et `/sources` avec boutons Suivre.
- **Sources RSS** (admin > Sources) : import automatique de flux RSS/Atom (toutes les `FEED_REFRESH_MINUTES` min, 60 par défaut, 0 pour désactiver). Seuls titre, résumé, image HTTPS et tags sont repris ; la fiche mène à l'article d'origine et reste ouverte aux votes et commentaires (non indexée). Les adresses internes (localhost, réseau privé, métadonnées cloud) sont refusées, y compris après redirection.
- **Liens proposés** : un lecteur connecté propose une URL (`/submit`, 5 en attente max), un admin la valide (titre/description/image repris de la page si besoin) ; elle apparaît dans la source « Communauté ».

## Multilingue

Activez des langues dans **Réglages** (français, anglais, espagnol fournis ; `src/i18n.js` pour en ajouter). La langue par défaut garde les URLs sans préfixe, les autres vivent sous `/en/…`, `/es/…`.

- Chaque article a une langue ; les **traductions** sont liées entre elles (menu « Traduction de… » ou lien « Créer la version English » dans l'éditeur).
- Sélecteur de langue dans l'en-tête (mène à la traduction de l'article si elle existe), balises `hreflang`, RSS et sitemap par langue.
- Catégories et tags sont propres à chaque langue ; titre, description et pied de page se règlent par langue.
- L'interface d'administration reste en français.

## Newsletter

Formulaire d'inscription dans la barre latérale, double confirmation par e-mail, désinscription en un clic (lien dans chaque e-mail + en-tête `List-Unsubscribe`), liste et export CSV dans **Newsletter**.
Un article publié s'envoie aux abonnés de sa langue depuis son écran d'édition (admin). Il faut configurer `SMTP_URL` et `MAIL_FROM` ; sans cela, les inscriptions sont directes et l'envoi est désactivé.

## Brouillons partagés

Dans l'éditeur, « Partage privé » crée un lien secret `/preview/<jeton>` qui permet de relire un brouillon (non indexé, révocable ou régénérable à tout moment).

## Export / import

### Import en masse (admin > Export / import)

- **Plusieurs fichiers Markdown d'un coup** (`.md`, `.markdown`, `.txt` ; 100 par lot, 1 Mo chacun). Chaque fichier est traité séparément : une erreur n'arrête pas le lot, et un **rapport** liste le résultat de chaque fichier (importé, ignoré, erreur, avertissements).
- **En-tête facultatif** (`---` … `---`) : `title`, `slug`, `date`, `status` (ou `draft: true`), `lang`, `category` (créée si absente), `tags`, `excerpt`, `cover` (URL https), `translation_of` (slug d'un autre article, y compris dans le même lot). Sans titre : premier `#` du texte, sinon nom du fichier. Statut, langue, catégorie et tags par défaut sont réglables pour tout le lot ; une date future programme l'article.
- Un article dont le slug existe déjà est **ignoré** (rien n'est écrasé). Le HTML est assaini. L'import est **silencieux** : il ne déclenche aucune notification.
- **Liste de liens** : un lien par ligne (30 max) ; chaque page devient un article externe de la source « Communauté » (titre, description et image lus sur la page, 5 pages en parallèle). Les adresses internes (localhost, IP privées, `.local`) sont refusées, et les liens déjà présents ignorés.

### Export / import JSON

**Export / import** (admin) télécharge un JSON (articles, tags, langues et traductions, catégories, commentaires, option images de couverture). L'import ajoute sans écraser (les slugs existants sont ignorés), de façon atomique ; le HTML est régénéré depuis le Markdown. Comptes, réglages et abonnés ne sont pas exportés.

## Thème

Dans **Réglages > Apparence** : couleur d'accent (clair/sombre, texte automatiquement lisible), police de l'interface (Schibsted Grotesk, Fraunces ou JetBrains Mono), logo. Servi par `/theme.css`, valeurs validées côté serveur.

## Configuration (.env)

| Variable | Rôle |
|---|---|
| `PORT` | Port d'écoute (3000) |
| `SITE_URL` | URL publique, pour RSS / sitemap / canonical |
| `NODE_ENV=production` | Cookies `Secure` + HSTS (à utiliser derrière HTTPS) |
| `TRUST_PROXY=true` | Derrière nginx / Caddy (IP réelle pour les limiteurs) |
| `DATA_DIR`, `UPLOAD_DIR` | Emplacement de la base SQLite et des images |
| `SMTP_URL`, `MAIL_FROM` | Envoi des e-mails de la newsletter (et OTP en repli) |
| `EMAILDO_URL`, `EMAILDO_API_KEY`, `EMAILDO_SERVICE_ID`, `EMAILDO_OTP_TEMPLATE_ID` | Envoi du code OTP par modèle d'e-mail (clé secrète : dans `.env`, jamais commitée) |
| `FEED_REFRESH_MINUTES` | Fréquence d'import des flux RSS (60 ; 0 = désactivé) |

## Déploiement

Lancez `NODE_ENV=production npm start` derrière un reverse proxy HTTPS (Caddy, nginx), avec `TRUST_PROXY=true`.
**Sauvegarde** : copiez `data/` et `uploads/`. Les dates « programmé » utilisent l'heure du serveur.

## Structure

```
server.js            app Express (middlewares, sécurité)
src/db.js            schéma SQLite et réglages
src/auth.js          sessions, CSRF, rôles
src/posts.js         requêtes d'articles, tags, traductions, barre latérale
src/lang.js, i18n.js langues, préfixes d'URL, textes traduits
src/newsletter.js    inscriptions et envois (src/mail.js : SMTP)
src/engage.js        votes, favoris, abonnements, lectures, séries
src/notify.js        notifications (base + flux temps réel SSE)
src/otp.js           code de vérification à l'inscription
src/feeds.js         import RSS/Atom, liens soumis (src/safe-fetch.js : anti-SSRF)
src/theme.js         CSS du thème
src/bulk.js          import en masse (Markdown, liens)
src/util.js          slugs, Markdown, dates, limiteur
src/routes/public.js site public, RSS, sitemap
src/routes/admin.js  administration
views/  public/      templates EJS, CSS et JS
```
