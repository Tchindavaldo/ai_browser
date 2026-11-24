# Qezaly : tâches d'abonnement envoyées par le back-end

Code : `src/qezaly/` (file, objectifs Netflix et Spotify, appels au back-end).
L'agent n'accède à aucune base : réglages, coûts et reprise passent par le back-end.
Réglages : `.env.example`, section Qezaly.
Dans l'interface : tuile « Tâches Qezaly » du tableau de bord ; chaque tâche est une session
normale (titre « Qezaly netflix ... »), où l'admin peut reprendre la main après un échec.

## Sur Fly

- Fly arrête la machine quand aucune requête n'arrive. Tant qu'une tâche tourne ou attend,
  l'agent appelle sa propre adresse publique (`/api/health`) chaque minute pour rester allumé.

# Contrat back-end Qezaly <-> agent ai_browser (v1)

Un seul jeton partagé, `QEZALY_AGENT_TOKEN`, en `Authorization: Bearer` dans les deux sens.
Une tâche = un service. Netflix et Spotify en même temps = deux tâches envoyées ensemble.

## Back-end -> agent (ai_browser sur Fly)

### `POST /api/qezaly/tasks`
Corps : une tâche, ou `{ "tasks": [ ... ] }`. Idempotent sur `taskId` (renvoyer ne duplique pas).

```json
{
  "taskId": "uuid de agent_tasks",
  "orderId": "uuid de orders",
  "service": "netflix | spotify",
  "plan": { "code": "mobile", "label": "Mobile 480p" },
  "account": { "email": "jeandupont-qezaly@rauval.com", "password": "en clair, seulement dans cet appel" },
  "card": { "number": "...", "expiry": "MM/AA", "cvc": "...", "holder": "JEAN DUPONT" },
  "customer": { "firstName": "Jean", "lastName": "Dupont", "birthDate": "1995-01-15" },
  "country": "CM",
  "profile": { "name": "Jean", "kids": false, "languages": ["Français"] }
}
```
Réponse `202` : `{ "accepted": [{ "taskId", "status": "queued", "position": 3 }] }`.
`birthDate` et `profile` facultatifs (Spotify demande une date de naissance).

### `GET /api/qezaly/tasks/:taskId`
`{ taskId, status, success, result, needsAdmin, steps, usage, sessionId, queuedAt, startedAt, finishedAt }`

### `GET /api/qezaly/tasks`
`{ limit, running, queued, tasks: [...] }`

### `POST /api/qezaly/tasks/:taskId/mails`
Le back-end pousse les mails Zoho rattachés à la tâche dès leur arrivée.
```json
{ "mails": [{ "id": "message_id", "from": "info@account.netflix.com", "subject": "...",
  "text": "corps texte", "links": ["https://..."], "codes": ["123456"], "receivedAt": "ISO" }] }
```

### `POST /api/qezaly/tasks/:taskId/cancel`

## Agent -> back-end

### `POST {QEZALY_BACKEND_URL}/api/agent/callback`
Envoyé à chaque changement d'état (3 essais, 2 s, 8 s, 30 s).
```json
{
  "taskId": "...", "orderId": "...", "service": "netflix",
  "status": "running | waiting_mail | done | failed | cancelled",
  "success": true, "result": "texte de l'agent",
  "needsAdmin": false, "sessionId": "id de session ai_browser",
  "steps": 37, "usage": { "input": 0, "output": 0, "usd": 0.02, "cfa": 13 },
  "captures": ["/captures/qezaly/<taskId>/fin.jpg"], "at": "ISO"
}
```
`failed` porte toujours `needsAdmin: true` : le back-end prévient l'admin par WhatsApp
et laisse la commande « en cours » côté client. La session reste ouverte dans ai_browser
(60 min par défaut) pour que l'admin reprenne la main dans l'interface.
Après un redémarrage de l'agent, les tâches qui tournaient sont renvoyées en `failed`
avec `needsAdmin: true` et le motif « interrompue par un redémarrage ».

### `GET {QEZALY_BACKEND_URL}/api/agent/settings`
`{ "maxParallel": 10 }`. Relu chaque minute ; 10 si l'appel échoue.

### `GET {QEZALY_BACKEND_URL}/api/agent/tasks/unfinished`
`{ "tasks": [{ "taskId", "orderId", "service", "sessionId", "status" }] }` : tâches en queued,
running ou waiting_mail. Appelé 15 s après le démarrage de l'agent, qui renvoie un callback
`failed` pour chaque tâche en running ou waiting_mail qu'il ne connaît pas.

### `GET {QEZALY_BACKEND_URL}/api/agent/tasks/:taskId/mails?since=ISO`
Même format que ci-dessus : `{ "mails": [...] }`. L'agent l'appelle quand il attend un code
et qu'aucun mail poussé n'est arrivé.

## Ce que l'agent garantit
- Mots de passe et carte jamais envoyés au modèle IA : il ne voit que des repères
  (`{{carte_numero}}`...), remplacés au moment de la saisie et masqués dans les sorties.
- Coûts et jetons par tâche dans chaque callback (`usage`, `steps`) : le back-end les enregistre.
- Tâches en parallèle : `maxParallel` de `GET /api/agent/settings` (10 par défaut), relu chaque minute.
