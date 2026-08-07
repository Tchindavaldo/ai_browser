const sessionId = {
  name: 'id', in: 'query', required: true, schema: { type: 'string' },
  description: 'Identifiant de session'
};

const ok = (desc, schema) => ({ description: desc, content: { 'application/json': { schema } } });
const T = (type, props, required) => ({ type, properties: props, required });

export const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Rauvalia API',
    version: '1.0.0',
    description:
      "Pilotage d'un navigateur par IA. Une **session** est une conversation attachée à un onglet ; " +
      "un **navigateur** (BrowserHost) est un profil invite pouvant héberger plusieurs onglets. " +
      "L'agent décide seul de ses actions à partir de l'objectif qu'on lui donne.\n\n" +
      "**Authentification** — si `RAUVALIA_TOKEN` est défini côté serveur, toutes les routes exigent " +
      "`Authorization: Bearer <token>` (ou `?token=<token>` pour un accès navigateur)."
  },
  servers: [{ url: '/', description: 'Serveur courant' }],
  tags: [
    { name: 'Sessions', description: 'Créer, basculer, nettoyer, fermer' },
    { name: 'Exécution', description: 'Lancer et couper des tâches' },
    { name: 'Observation', description: 'État, historique, captures, flux temps réel' },
    { name: 'Serveur', description: 'Santé et arrêt' }
  ],
  components: {
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer' },
      tokenQuery: { type: 'apiKey', in: 'query', name: 'token' }
    },
    schemas: {
      Session: T('object', {
        id: { type: 'string' },
        title: { type: 'string' },
        hostId: { type: 'string', description: 'Navigateur hôte' },
        engine: { type: 'string', enum: ['firefox', 'chromium', 'edge', 'chrome', 'webkit'] },
        browserLabel: { type: 'string' },
        headless: { type: 'boolean' },
        busy: { type: 'boolean', description: 'Une tâche est en cours' },
        url: { type: 'string', nullable: true },
        steps: { type: 'integer' },
        actions: { type: 'integer' },
        tasks: { type: 'integer' },
        objective: { type: 'string', nullable: true },
        lastAction: { type: 'object', nullable: true },
        lastResult: { type: 'object', nullable: true }
      }),
      Browser: T('object', {
        id: { type: 'string' }, label: { type: 'string' }, engine: { type: 'string' },
        headless: { type: 'boolean' }, sessions: { type: 'integer' }, busy: { type: 'boolean' }
      }),
      State: T('object', {
        activeId: { type: 'string', nullable: true },
        engines: { type: 'array', items: { type: 'string' } },
        browsers: { type: 'array', items: { $ref: '#/components/schemas/Browser' } },
        sessions: { type: 'array', items: { $ref: '#/components/schemas/Session' } },
        feed: { type: 'array', items: { type: 'object' }, description: 'Activité récente, toutes sessions' },
        totals: T('object', {
          browsers: { type: 'integer' }, sessions: { type: 'integer' },
          running: { type: 'integer' }, actions: { type: 'integer' }, tasks: { type: 'integer' }
        })
      }),
      Event: T('object', {
        type: { type: 'string', enum: ['user', 'thought', 'action', 'result', 'artifact', 'done', 'system', 'sessions'] },
        sessionId: { type: 'string' }, step: { type: 'integer' }, ts: { type: 'integer' },
        name: { type: 'string', description: 'Outil appelé (type=action)' },
        args: { type: 'object' }, text: { type: 'string' }, output: { type: 'string' },
        url: { type: 'string', description: 'Chemin du fichier livré (type=artifact)' },
        success: { type: 'boolean' }, result: { type: 'string' }
      }),
      Error: T('object', { error: { type: 'string' } })
    }
  },
  security: [{ bearer: [] }, { tokenQuery: [] }],
  paths: {
    '/api/session/new': {
      post: {
        tags: ['Sessions'], summary: 'Créer une session',
        description: "`mode=browser` lance un navigateur au profil invite neuf. `mode=tab` ouvre un onglet " +
          "dans un navigateur existant (`hostId`, sinon celui de la session active) : même profil, mêmes connexions.",
        requestBody: { content: { 'application/json': { schema: T('object', {
          mode: { type: 'string', enum: ['browser', 'tab'], default: 'browser' },
          engine: { type: 'string', enum: ['firefox', 'chromium', 'edge', 'chrome', 'webkit'] },
          headless: { type: 'boolean', default: true, description: 'false ouvre une vraie fenêtre' },
          hostId: { type: 'string' },
          title: { type: 'string' }
        }) } } },
        responses: {
          200: ok('Session créée (l’état complet est renvoyé, avec `id`)', { $ref: '#/components/schemas/State' }),
          500: ok('Le moteur n’a pas pu démarrer', { $ref: '#/components/schemas/Error' })
        }
      }
    },
    '/api/session/select': {
      post: { tags: ['Sessions'], summary: 'Rendre une session active', parameters: [sessionId],
        responses: { 200: ok('Nouvel état', { $ref: '#/components/schemas/State' }), 404: ok('Session inconnue', { $ref: '#/components/schemas/Error' }) } }
    },
    '/api/session/rename': {
      post: { tags: ['Sessions'], summary: 'Renommer une session', parameters: [sessionId],
        requestBody: { content: { 'application/json': { schema: T('object', { title: { type: 'string' } }, ['title']) } } },
        responses: { 200: ok('Renommée', T('object', { ok: { type: 'boolean' } })) } }
    },
    '/api/session/clear': {
      post: { tags: ['Sessions'], summary: 'Nettoyer une session',
        description: 'Vide l’historique de conversation et revient sur une page blanche, sans fermer le navigateur.',
        parameters: [sessionId], responses: { 200: ok('Nettoyée', T('object', { ok: { type: 'boolean' } })) } }
    },
    '/api/session/close': {
      post: { tags: ['Sessions'], summary: 'Fermer une session',
        description: 'Ferme l’onglet ; le navigateur se ferme si c’était son dernier onglet.',
        parameters: [sessionId], responses: { 200: ok('Nouvel état', { $ref: '#/components/schemas/State' }) } }
    },
    '/api/message': {
      post: {
        tags: ['Exécution'], summary: 'Donner un objectif à l’agent',
        description: "Retourne immédiatement (202) : l’exécution se suit sur `/api/events` ou `/api/history`. " +
          "Sans `id`, une session est créée automatiquement.",
        requestBody: { required: true, content: { 'application/json': { schema: T('object', {
          objective: { type: 'string', description: 'Objectif en langage naturel' },
          id: { type: 'string', description: 'Session cible ; par défaut la session active' }
        }, ['objective']) } } },
        responses: {
          202: ok('Tâche acceptée', T('object', { id: { type: 'string' } })),
          400: ok('Objectif vide', { $ref: '#/components/schemas/Error' }),
          409: ok('Une tâche est déjà en cours sur cette session', { $ref: '#/components/schemas/Error' })
        }
      }
    },
    '/api/session/cancel': {
      post: { tags: ['Exécution'], summary: 'Couper la tâche en cours',
        description: 'Annule l’appel au modèle et arrête la boucle entre deux actions.',
        parameters: [sessionId],
        responses: { 200: ok('`stopped` vaut false s’il n’y avait rien à couper', T('object', { stopped: { type: 'boolean' } })) } }
    },
    '/api/state': {
      get: { tags: ['Observation'], summary: 'État global',
        responses: { 200: ok('Sessions, navigateurs, compteurs et flux', { $ref: '#/components/schemas/State' }) } }
    },
    '/api/history': {
      get: { tags: ['Observation'], summary: 'Historique d’une session', parameters: [sessionId],
        responses: { 200: ok('Événements rejouables', T('object', {
          id: { type: 'string' }, title: { type: 'string' },
          events: { type: 'array', items: { $ref: '#/components/schemas/Event' } }
        })) } }
    },
    '/api/events': {
      get: {
        tags: ['Observation'], summary: 'Flux temps réel (SSE)',
        description: "`text/event-stream`. Chaque ligne `data:` est un `Event` JSON portant son `sessionId`. " +
          "Le type `sessions` transporte l’état complet.",
        responses: { 200: { description: 'Flux SSE', content: { 'text/event-stream': { schema: { type: 'string' } } } } }
      }
    },
    '/api/screenshot': {
      get: { tags: ['Observation'], summary: 'Capture live d’une session',
        parameters: [{ ...sessionId, required: false, description: 'Par défaut la session active' }],
        responses: { 200: ok('JPEG en base64', T('object', {
          image: { type: 'string', nullable: true }, url: { type: 'string', nullable: true }, title: { type: 'string' }
        })) } }
    },
    '/api/thumbs': {
      get: { tags: ['Observation'], summary: 'Vignettes de toutes les sessions',
        responses: { 200: ok('Dictionnaire sessionId → JPEG base64', { type: 'object', additionalProperties: { type: 'string', nullable: true } }) } }
    },
    '/api/captures': {
      get: { tags: ['Observation'], summary: 'Captures livrées par l’agent',
        description: "Fichiers produits par l’outil `screenshot`. Chaque entrée est téléchargeable sur `/captures/<name>`.",
        responses: { 200: ok('Liste, plus récente d’abord', T('object', { captures: { type: 'array', items: T('object', {
          name: { type: 'string' }, url: { type: 'string' }, bytes: { type: 'integer' }, ts: { type: 'integer' }
        }) } })) } }
    },
    '/api/health': {
      get: { tags: ['Serveur'], summary: 'Santé du serveur', security: [],
        responses: { 200: ok('OK', T('object', {
          ok: { type: 'boolean' }, uptime: { type: 'number' }, sessions: { type: 'integer' },
          browsers: { type: 'integer' }, running: { type: 'integer' }, model: { type: 'string' }
        })) } }
    },
    '/api/shutdown': {
      post: { tags: ['Serveur'], summary: 'Couper le serveur',
        description: 'Ferme tous les navigateurs puis termine le processus.',
        responses: { 200: ok('Arrêt engagé', T('object', { ok: { type: 'boolean' } })) } }
    }
  }
};
