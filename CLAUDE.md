# AI Browser

Navigateur piloté par IA : Node.js + Playwright, l'IA prend toutes les décisions.
Ex `rauvalia-web`, déplacé ici. Dépôt GitHub : `Tchindavaldo/ai_browser`.

- Serveur et interface : `npm run serve` (port 7331), page `public/index.html`.
- Accès à distance au visuel : tunnel Cloudflare, `npm run tunnel` (`src/tunnel.js`).

## Règles impératives

- **Aucun emoji, nulle part.** Ni dans le code, ni dans l'interface (HTML, textes, boutons),
  ni dans les logs, ni dans les messages de commit, ni dans les réponses à l'utilisateur.
  Utiliser des mots à la place (« Retirer », « gratuit », « Échec »...).
- Interface en français et simple : un accueil épuré, les détails s'ouvrent au clic.
  Les nouvelles fonctions s'intègrent à l'interface existante (rail, tuiles, vues),
  jamais dans une page à part.
- **Ne jamais changer ce qui existe déjà sans accord.** Quand on demande de corriger,
  on corrige le problème dans le fonctionnement existant, sans le remplacer par une autre
  solution (exemple interdit : basculer sur Edge ou Chrome installés à la place du
  Chromium de Playwright). Si on ne sait pas comment corriger ou si la correction modifie
  le comportement, **demander d'abord** à l'utilisateur.
- Faire exactement ce qui est demandé, à l'endroit demandé (exemple : une information
  demandée « dans la liste déroulante » va dans chaque ligne de la liste, pas dans une case à cocher).
- Ne jamais commiter de clé API : `.env` et `llm-settings.json` sont ignorés par git.

## Modèles IA

- `src/providers.js` : fournisseurs compatibles OpenAI (OpenRouter, Groq, Cerebras, Gemini,
  Mistral, Together, Hugging Face, DeepSeek) et détection des modèles gratuits.
  L'agent pilote le navigateur par appels d'outils : seuls les modèles qui les gèrent conviennent.
- `src/llm.js` : chaîne de modèles avec bascule automatique ; un modèle en quota épuisé
  (HTTP 402/429) est sauté pendant 10 minutes. Réglages dans `llm-settings.json`.
- Vue « Modèles IA » de l'interface (icône du rail, tuile « Modèle IA » du tableau de bord).
- Captures pour les modèles qui lisent les images (`src/agent.js`) : après une action en échec,
  quand l'agent appelle screenshot, ou à chaque étape si l'option « Capture à chaque étape » de la
  session est cochée, une capture de la page entière est jointe. Une seule image gardée dans
  l'historique ; `src/llm.js` la retire pour les modèles texte seul.
- Le modèle qui a réellement répondu s'affiche à chaque étape (« bascule vers ... » s'il diffère
  du modèle prévu) et dans le tableau de bord.

## Projet Qezaly

- Qezaly : payer des abonnements (Netflix, Spotify...) par Mobile Money, via un agent IA.
- Ce dépôt = **l'agent IA** qui gère le back office (activation des abonnements).
- Dépôts liés : `Netflix-Automation` (back-end, endpoints ; il transmet les codes et OTP
  captés dans Zoho Mail), `moobilPay-frontend-reactNative-expo` (app mobile),
  `mobilwallet-backend` (paiement Mobile Money).
- `src/qezaly/` : file des tâches envoyées par le back-end Qezaly (abonnements Netflix et Spotify),
  routes `/api/qezaly/*`, contrat dans `QEZALY.md`. Jeton `QEZALY_AGENT_TOKEN`.
- Le modèle IA ne voit jamais carte ni mot de passe : repères `{{nom}}` remplacés à la saisie
  (`Session.secrets` dans `src/agent.js`) et masqués dans ce qu'il relit.
- Tâches en parallèle : `agent_settings.max_parallel` dans le Supabase de l'agent (10 par défaut).

## Style de réponse

- **Court et droit au but.** Listes à puces, pas de paragraphes.
- Répondre à ce qui est demandé, rien de plus. Pas de post-scriptum.
- Jamais de `.md` récapitulatif sans demande.

## L'IA décide, le code informe

- Le code fournit à l'IA ce qu'elle voit (page, URL, captures) et les outils pour agir.
- Le code ne décide jamais à sa place qu'une étape a réussi ou échoué.

## Architecture

- Un fichier = une responsabilité. Viser ~400 lignes, **500 = plafond** : au-delà, découper automatiquement, sans demander.
- `public/index.html` dépasse déjà ce plafond : le découper dès qu'on y touche.
- Pas d'agent Explore pour « découvrir » le projet : lire ce fichier et `README.md`.

## Branches Git

- Jamais de travail direct sur `main`.
- `feature/<sujet>` : fonctionnalité ; `debug/<sujet>` : un bug.
- Fusion seulement après validation de l'utilisateur.

## Plusieurs options : demander

- Quand une action a plusieurs options (déployer ou non, quelle branche...), demander d'abord.
  Ne jamais inventer un paramètre non donné.

## Hooks

- `.claude/hooks/` (déclarés dans `.claude/settings.json`), repris du modèle yaammoo :
  - `session-start-read.sh` : injecte ce fichier au premier message de la session.
  - `no-secret-commit.sh` : refuse un commit qui contient `.env*` ou une clé.
  - `enforce-file-size.sh` : fichier de code > 500 lignes = découpé automatiquement, sans demander.
- Un hook qui bloque applique la règle : ne pas le contourner.
