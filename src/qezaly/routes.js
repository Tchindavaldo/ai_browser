/**
 * Routes appelées par le back-end Qezaly (contrat : qezaly-agent/CONTRAT.md).
 * Jeton : QEZALY_AGENT_TOKEN en Authorization Bearer (le jeton de l'interface marche aussi).
 */
import { validateTask } from './prompts.js';

const PREFIX = '/api/qezaly/';

/** true si la requête vise les routes Qezaly ou les captures Qezaly. */
export const isQezalyPath = (p) => p.startsWith(PREFIX) || p === '/api/qezaly' || p.startsWith('/captures/qezaly/');

/** Jeton du back-end présent et valide. */
export function qezalyAuthorized(req) {
  const tok = process.env.QEZALY_AGENT_TOKEN || '';
  if (!tok) return false;
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '') === tok;
}

/**
 * Traite la requête si elle vise /api/qezaly/*. Renvoie true si elle a été traitée.
 * @param {{ queue, json, readBody }} deps
 */
export async function handleQezaly(req, res, url, { queue, json, readBody }) {
  if (!url.pathname.startsWith('/api/qezaly')) return false;
  const parts = url.pathname.slice('/api/qezaly'.length).split('/').filter(Boolean); // ['tasks', id?, action?]
  if (parts[0] !== 'tasks') { json(res, 404, { error: 'not found' }); return true; }
  const [, taskId, action] = parts.map(decodeURIComponent);

  if (!taskId && req.method === 'POST') {
    const body = await readBody(req);
    const list = Array.isArray(body.tasks) ? body.tasks : [body];
    if (!list.length || list.length > 50) { json(res, 400, { error: 'entre 1 et 50 tâches par appel' }); return true; }
    const errors = list.map((t, i) => ({ i, taskId: t?.taskId ?? null, errors: validateTask(t) })).filter((e) => e.errors.length);
    if (errors.length) { json(res, 400, { error: 'tâche invalide', details: errors }); return true; }
    json(res, 202, { accepted: list.map((t) => queue.enqueue(t)) });
    return true;
  }

  if (!taskId && req.method === 'GET') { json(res, 200, queue.state()); return true; }

  const rec = queue.get(taskId);
  if (!rec) { json(res, 404, { error: 'tâche inconnue' }); return true; }

  if (!action && req.method === 'GET') { json(res, 200, queue.view(rec)); return true; }

  if (action === 'mails' && req.method === 'POST') {
    const body = await readBody(req);
    const mails = Array.isArray(body.mails) ? body.mails : [body];
    json(res, 200, { received: queue.pushMails(taskId, mails) });
    return true;
  }

  if (action === 'cancel' && req.method === 'POST') { json(res, 200, { stopped: queue.cancel(taskId) }); return true; }

  json(res, 404, { error: 'not found' });
  return true;
}
