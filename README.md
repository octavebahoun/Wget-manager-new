# Web Wget | Premium Downloader

⚡ Télécharger des vidéos et fichiers via serveur distant avec **aria2c + ffmpeg**
Supporte : DASH / HLS / MP4 / Vimeo / sites avec headers personnalisés

---

## Fonctionnalités

* Téléchargement haute performance multi-segment
* Suivi en temps réel des téléchargements via **SSE**
* Historique des téléchargements et possibilité d’annulation
* Support **User-Agent**, **Referer**, **Cookies**
* Extension navigateur pour un clic-droit → télécharger directement depuis la page
* Option fusion audio+video pour DASH / HLS

---

## Prérequis

* Node.js >= 20
* npm ou yarn
* aria2c installé ([https://aria2.github.io/](https://aria2.github.io/))
* ffmpeg installé (optionnel pour fusion audio/video) 

---

## Installation

1. Cloner le dépôt

```bash
git clone https://github.com/tonpseudo/web-wget.git
cd web-wget
```

2. Installer les dépendances

```bash
npm install
```

3. Créer le fichier `.env` à la racine

```env
PORT=3000
ALLOWED_DOMAINS=vimeo.com,vimeocdn.com,youtube.com
DOWNLOAD_TIMEOUT=3600
MAX_FILE_SIZE=5G
```

---

## Lancer le serveur

```bash
node server.js ou utiliser nodemon server.js  mais faire npm install nodemon en premier
```

Le serveur sera accessible à l’adresse :

```
http://localhost:3000
```

---

## Utilisation Web

1. Ouvrir `http://localhost:3000` dans votre navigateur
2. Coller l’URL du fichier / vidéo
3. Remplir les options facultatives :

   * Nom du fichier personnalisé
   * Referer (pré-rempli automatiquement par l’extension)
   * User-Agent (pré-rempli automatiquement)
   * Ignorer le certificat SSL si nécessaire
4. Cliquer sur **“Démarrer le téléchargement”**
5. Suivre la progression et gérer les téléchargements actifs ou l’historique

---

## Avec l’extension navigateur

1. Aller dans `chrome://extensions` (ou `edge://extensions`)
2. Activer **Mode développeur**
3. Cliquer sur **“Charger l’extension non empaquetée”**
4. Sélectionner le dossier `extension/` dans le dossier cloné
5. Cliquer droit sur un lien vidéo → **“Download with Web Wget”**// peut ne pas fonctionner 
6. Vous pouvez aussi copier le lien clické sur l'icone de l'extension et telecharger la vidéo 

---

## Endpoints disponibles

* `POST /download` : démarrer un téléchargement
* `GET /history` : récupérer l’historique
* `GET /clear-history` : vider l’historique et supprimer les fichiers
* `POST /cancel` : annuler un téléchargement
* `POST /cancel-all` : annuler tous les téléchargements actifs
* `GET /events` : SSE pour progression en temps réel
* `GET /config` : récupérer la configuration (ALLOWED_DOMAINS, etc.)

---

## Contribution

* Fork → branche → Pull Request
* Issues pour bugs ou idées
* Contributions possibles :

  * Extension Firefox
  * Support DASH/HLS avancé
  * Optimisation des performances et sécurité
  * Interface web / UI

---

## Licence

MIT License © OctaveBAHOUN-HOUTOUKPE


