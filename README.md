# Rauvalia Web

Navigateur piloté par IA — **sans fork Chromium**. Playwright fournit le navigateur,
DeepSeek prend **toutes** les décisions.

Le fork natif est intact dans [`../rauvalia-natif/`](../rauvalia-natif).

## Principe

Identique à celui du natif (`../rauvalia-natif/CLAUDE.md`) :

- L'IA navigue elle-même — le code ne charge jamais d'URL avant de lancer l'agent.
- Tout ce que le navigateur voit est envoyé à l'IA : DOM interactif, texte, console, erreurs réseau.
- Aucun `if/else` codé en dur pour les erreurs. L'IA reçoit les signaux bruts et interprète.
- Le snapshot ne bloque jamais : page vide → snapshot vide immédiat, l'IA décide de naviguer.

## Installation

```bash
cd rauvalia-web && npm install
```

Variables d'environnement :

| Variable | Défaut | Rôle |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | **requis** |
| `DEEPSEEK_MODEL` | `deepseek-chat` | modèle |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | endpoint compatible OpenAI |
| `RAUVALIA_PORT` | `7331` | port du serveur |
| `RAUVALIA_HOST` | `127.0.0.1` | `0.0.0.0` pour exposer sur le réseau / un tunnel |
| `RAUVALIA_TOKEN` | — | si défini, toutes les routes exigent ce jeton |
| `RAUVALIA_CAPTURES` | `./captures` | dossier des captures livrées par l'agent |
| `RAUVALIA_CLOUDFLARED` | `cloudflared` (PATH) | chemin du binaire pour `npm run tunnel` |
| `RAUVALIA_ENGINE` | `chromium` | `firefox` \| `chromium` \| `edge` \| `chrome` \| `webkit` |
| `RAUVALIA_FIREFOX_PATH` | — | binaire Firefox alternatif (voir ci-dessous) |

Un fichier `.env` à la racine du projet est chargé automatiquement (`--env-file-if-exists`).

### Moteur Firefox (Windows)

Firefox fonctionne, mais **le binaire installé sous `%LOCALAPPDATA%\ms-playwright\` refuse
de démarrer sur cette machine** — indépendamment de ce projet, `firefox.exe --version`
lancé à la main échoue pareil :

```
Assembly dépendant mozglue,language="*",type="win32",version="1.0.0.0" introuvable
```

**Le même binaire copié vers un chemin simple démarre normalement.** Contournement :

```powershell
Copy-Item "$env:LOCALAPPDATA\ms-playwright\firefox-1538\firefox" C:\ffx -Recurse
```

puis dans `.env` :

```
RAUVALIA_ENGINE=firefox
RAUVALIA_FIREFOX_PATH=C:\ffx\firefox.exe
```

Ce n'est ni le Visual C++ Redistributable (14.51, à jour), ni `mozglue.dll` (présent, avec
son manifeste SxS embarqué correct) : c'est la résolution SxS depuis ce chemin précis.
`sfc /scannow`, la réinstallation propre et le canal `firefox-beta` n'y changent rien.

```powershell
$env:DEEPSEEK_API_KEY="<ta clé>"
```

## Exemples d'objectifs

[EXEMPLES.md](EXEMPLES.md) — prompts réels, dont un parcours d'inscription complet
avec formulaire de paiement (~0,05 USD d'API), et ce qui fait un bon objectif.

## CLI

```bash
node src/cli.js "Va sur news.ycombinator.com et donne-moi les 10 premiers titres avec leur URL"
```

Options : `--headless` (sans fenêtre), `--steps 40` (limite d'itérations),
`--engine firefox|chromium|webkit`.

## Interface graphique

```bash
npm run serve
```

puis ouvrir <http://localhost:7331>. Deux vues, accessibles par le rail de gauche.

### Tableau de bord

L'état global en un coup d'œil :

- quatre compteurs — sessions, navigateurs, tâches en cours, actions exécutées ;
- une carte par navigateur ouvert (moteur, profil, nombre d'onglets), avec la liste de ses
  onglets : vignette live, titre, URL, statut, et **l'action en cours** de l'agent ;
- un **flux d'activité** temps réel, toutes sessions confondues ;
- ouvrir / couper / fermer chaque session directement depuis sa ligne.

### Espace de travail

- **Conversation** — tes demandes et les résultats, rien d'autre.
- **Vue live** — capture du navigateur, avec URL et titre.
- **Activité de l'agent** — raisonnement et détail des actions, étape par étape.
  Chaque outil porte un paramètre `raison` obligatoire, donc l'agent justifie
  systématiquement ce qu'il fait ; le `reasoning_content` des modèles « reasoner »
  s'affiche en plus quand il existe.

Chaque zone défile indépendamment — la page elle-même ne défile jamais.

### Moteurs disponibles

| Moteur | Binaire utilisé |
|---|---|
| `firefox` / `chromium` / `webkit` | builds téléchargés par Playwright |
| `edge` | le **Microsoft Edge installé** sur la machine (canal `msedge`) |
| `chrome` | le **Google Chrome installé** (canal `chrome`) |

`edge` et `chrome` lancent le vrai navigateur du système, mais avec un **profil neuf et
jetable** : ni tes onglets, ni tes extensions, ni tes sessions connectées. C'est voulu —
l'agent ne touche pas à ton profil personnel.

Chaque session est **persistante** : le navigateur reste ouvert entre deux demandes et
l'IA garde l'historique. On peut enchaîner « et le paragraphe de cette même page ? » sans
redonner l'URL — l'agent reste sur la page au lieu de repartir de zéro.

### Sessions multiples

Une barre d'onglets liste les conversations. Deux façons d'en créer une :

| Bouton | Effet |
|---|---|
| **＋ Onglet** | nouvel onglet **dans le navigateur de la session active** — même profil, donc mêmes cookies et mêmes connexions |
| **＋ Navigateur** | nouveau navigateur, **profil invite neuf** — totalement cloisonné du reste |

Les sessions tournent **en parallèle** : une tâche peut travailler pendant qu'on discute
dans une autre. Un point orange sur l'onglet signale celles qui travaillent. Cliquer sur un
onglet bascule dessus et rejoue son historique (chat + activité) ; `✕` la ferme, et le
navigateur se ferme tout seul quand son dernier onglet part.

### Couper et nettoyer

- **■ Couper la tâche** — interrompt la tâche en cours : la requête au modèle est annulée
  et la boucle s'arrête entre deux actions. L'historique note l'interruption, donc la
  conversation reste utilisable derrière.
- **🧹 Nettoyer la session** — vide l'historique et repart sur une page blanche, sans
  fermer le navigateur.

### Captures livrées par l'agent

L'agent dispose d'un outil `screenshot` : si on lui demande « prends une capture et
envoie-la moi », il enregistre un PNG dans `captures/` et le livre **dans la conversation**
(aperçu + lien de téléchargement). Les fichiers restent accessibles sur `/captures/<nom>`
et se listent via `GET /api/captures`.

## Accès depuis un autre PC

Le serveur n'écoute que sur `127.0.0.1` par défaut. Pour l'ouvrir :

```
RAUVALIA_HOST=0.0.0.0
RAUVALIA_TOKEN=<jeton long et aléatoire>
```

Génère le jeton avec :

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Une fois `RAUVALIA_TOKEN` défini, **toutes** les routes l'exigent — sauf `/api/health` :

- API : en-tête `Authorization: Bearer <jeton>`
- navigateur : `https://…/?token=<jeton>` une seule fois, un cookie prend le relais

### Tunnel Cloudflare

```bash
npm run tunnel
```

Affiche une URL publique `https://…trycloudflare.com` (avec le jeton déjà dans le lien).
Le script **refuse de démarrer** si `RAUVALIA_TOKEN` est absent ou si le serveur tourne
sans authentification : exposer un navigateur pilotable sans jeton revient à donner à
n'importe qui un navigateur sur cette machine.

Prérequis — `cloudflared`. Ce n'est **pas** un logiciel à installer : c'est un seul `.exe`
autonome. À ne pas confondre avec *Cloudflare One Client* (WARP), qui ne sert pas à ça.
Aucun compte Cloudflare n'est nécessaire pour un tunnel rapide.

Télécharger depuis le dépôt officiel :
<https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe>

puis indiquer son chemin dans `.env` :

```
RAUVALIA_CLOUDFLARED=C:\chemin\vers\cloudflared-windows-amd64.exe
```

(sans cette variable, le binaire est cherché dans le `PATH`)

## Documentation de l'API

Spécification OpenAPI 3.1 complète, avec Swagger UI servi localement (aucune ressource
externe) :

- **<http://localhost:7331/docs>** — interface, avec « Try it out »
- **<http://localhost:7331/api/openapi.json>** — la spécification brute

### Résumé des routes

| Route | Rôle |
|---|---|
| `POST /api/session/new` | `{ mode: 'browser'\|'tab', engine, headless, hostId }` |
| `POST /api/session/select?id=` | bascule d'onglet |
| `POST /api/session/cancel?id=` | coupe la tâche en cours |
| `POST /api/session/clear?id=` | vide l'historique, page blanche |
| `POST /api/session/close?id=` | ferme la session (et son navigateur s'il devient vide) |
| `POST /api/message` | `{ objective, id }` → `202`, exécution en tâche de fond |
| `GET /api/events` | flux SSE, chaque événement porte son `sessionId` |
| `GET /api/history?id=` | historique rejouable d'une session |
| `GET /api/screenshot?id=` | `{ image (jpeg base64), url, title }` |
| `GET /api/thumbs` | vignettes de toutes les sessions (tableau de bord) |
| `GET /api/state` | sessions, navigateurs, compteurs, flux d'activité |
| `POST /api/session/rename?id=` | `{ title }` |
| `GET /api/captures` | captures livrées par l'agent |
| `GET /api/health` | santé du serveur — seule route non protégée |
| `POST /api/shutdown` | coupe le serveur |
| `GET /api/openapi.json` · `GET /docs` | spécification et Swagger UI |

Exemple depuis une autre application :

```bash
curl -X POST https://mon-tunnel.trycloudflare.com/api/message \
  -H "Authorization: Bearer $RAUVALIA_TOKEN" \
  -H "content-type: application/json" \
  -d '{"objective":"Va sur example.com et donne-moi le titre h1"}'
```

## Architecture

| Fichier | Rôle |
|---|---|
| [src/browser.js](src/browser.js) | `BrowserHost` (un navigateur = un profil invite) + `Tab` (snapshot : éléments `[n]`, texte, console, réseau) |
| [src/tools.js](src/tools.js) | Outils exposés à l'IA — exécutent, ne décident pas |
| [src/llm.js](src/llm.js) | Appel DeepSeek (chat/completions + tool calling, retry) |
| [src/agent.js](src/agent.js) | `Session` : boucle objectif → snapshot → décision IA → action, annulable |
| [src/manager.js](src/manager.js) | Sessions parallèles, navigateurs partagés ou cloisonnés |
| [src/server.js](src/server.js) + [public/index.html](public/index.html) | Interface graphique (SSE + vue live) |
| [src/cli.js](src/cli.js) | Mode terminal one-shot |

Outils disponibles pour l'IA : `navigate`, `click`, `type`, `select`, `check`,
`press_key`, `scroll`, `wait`, `go_back`, `read_page`, `eval_js`, `done`.

Les refs `[n]` sont réattribués à chaque snapshot — le prompt système l'impose à l'IA.
