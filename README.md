# Web Wget Pro v4

Télécharge vidéos, flux et fichiers via un serveur **aria2c + yt-dlp + ffmpeg**, avec une interface web et une extension Chrome.

## Démarrage rapide

```bash
npm install
npm start            # puis ouvrir http://localhost:3000
```

Outils nécessaires sur le serveur : `aria2c`, `ffmpeg`, `yt-dlp` (à garder à jour : `pipx upgrade yt-dlp`).

---

## Ce que ça sait faire

| Lien collé / détecté | Moteur utilisé |
|---|---|
| YouTube, Vimeo, TikTok, Instagram, Pinterest, X, Twitch… | yt-dlp |
| Flux HLS (`.m3u8`) / DASH (`.mpd`) | yt-dlp, secours ffmpeg |
| Vimeo privé/intégré (`playlist.json`, `master.json`) | moteur Vimeo intégré (segments + fusion ffmpeg) |
| Fichier direct (mp4, pdf, zip…) | aria2c (16 connexions, reprise) |
| Page web quelconque | yt-dlp, puis **scraping** de la page (balises vidéo, JSON, lecteurs intégrés) |

- **Bouton Analyser** : montre le titre, les qualités disponibles et tous les médias trouvés dans la page avant de télécharger.
- **Qualité** : meilleure, 4K → 360p, ou audio MP3. Option « Playlist entière ».
- **Détection automatique du vrai contenu** : un lien qui renvoie une playlist ou une page change tout seul de moteur.
- **Fiable** : nouvelles tentatives sur erreur réseau, reprise après redémarrage du serveur, annulation propre (aucun fichier partiel dans la bibliothèque).
- **Bibliothèque** : lecture dans le navigateur, téléchargement sur le PC, « récupérer puis supprimer », recherche.

## Extension Chrome

1. `chrome://extensions` → activer le **mode développeur**
2. **Charger l'extension non empaquetée** → dossier `extension/`
3. Options de l'extension → adresse du serveur (par défaut `http://localhost:3000`) → **Tester la connexion**

Elle détecte les médias **pendant la lecture** (réseau + page, iframes comprises) et envoie au serveur les en-têtes et cookies nécessaires (vidéos de cours privées, comptes connectés).

- Clic droit sur un lien / une vidéo / la page → **Télécharger avec Web Wget**
- `Ctrl+Shift+D` : envoie le meilleur média de la page
- Option **Rapatrier sur ce PC** : le fichier arrive dans « Téléchargements » quand le serveur a fini
- Vidéo non détectée ? Lancez la lecture quelques secondes puis cliquez sur ↻

## Configuration (`.env`, tout est optionnel)

```env
PORT=3000
# HOST=127.0.0.1               # écouter seulement en local
# API_KEY=une-cle-secrete      # obligatoire si le serveur est accessible depuis Internet
# ALLOWED_DOMAINS=vimeo.com,youtube.com   # vide = tous les domaines
# ALLOWED_ORIGIN=https://mon-interface.example
MAX_CONCURRENT_DOWNLOADS=5
MAX_FILE_SIZE=5G               # 0 = illimité
DOWNLOAD_TIMEOUT=14400         # secondes (0 = illimité)
RETRY_ATTEMPTS=2
# DOWNLOADS_DIR=downloads
# ARIA2_CONNECTIONS=16
# YTDLP_CONCURRENT_FRAGMENTS=8
# MERGE_FORMAT=mp4
# YTDLP_EXTRA_ARGS=--impersonate chrome
# DELETE_AFTER_TRANSFER=true   # "récupérer" supprime le fichier du serveur
# ALLOW_PRIVATE_NETWORKS=false # autoriser les adresses du réseau local
```

**Sécurité** : sans `API_KEY`, n'exposez pas le serveur sur Internet. Avec `API_KEY`, les requêtes venant de la machine elle-même restent autorisées (`TRUST_LOCALHOST=false` pour l'interdire). Les adresses locales/privées sont bloquées (anti-SSRF).

## API

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/download` | lancer un ou plusieurs téléchargements (`url` ou `urls[]`, `quality`, `playlist`, `customFilename`, `referer`, `cookies`, `cookieJar`…) |
| POST | `/api/analyze` | analyser un lien sans télécharger |
| GET | `/api/jobs` | liste des téléchargements (`?ids=a,b`) |
| POST | `/cancel`, `/cancel-all`, `/retry` | annuler / relancer |
| GET | `/events` | temps réel (SSE) |
| GET | `/history` | fichiers de la bibliothèque |
| GET | `/files/<chemin>` · `/dl/<chemin>` · `/transfer/<chemin>` | lire · télécharger · télécharger puis supprimer |
| DELETE | `/files/<chemin>` · `/clear-history` | supprimer un fichier / tout |
| GET | `/health` · `/config` | état du serveur et des outils |

Clé API : en-tête `X-API-Key` (ou `?api_key=` pour les liens et le SSE).

## Développement

```bash
npm test      # tests unitaires (node --test)
npm run dev
```

Structure : `server.js` (routes) · `lib/` (détection, scraping, file d'attente, sécurité) · `lib/engines/` (aria2, yt-dlp, ffmpeg, Vimeo) · `public/` (interface) · `extension/` (Chrome MV3).

## Licence

MIT © OctaveBAHOUN-HOUTOUKPE
