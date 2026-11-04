# AI Browser

Navigateur piloté par IA : Node.js + Playwright, l'IA prend toutes les décisions.
Ex `rauvalia-web`, déplacé ici. Dépôt GitHub : `Tchindavaldo/ai_browser`.
L'ancienne version Python est sur la branche `legacy-python`.

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
