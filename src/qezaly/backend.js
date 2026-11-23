/**
 * Appels de l'agent vers le back-end Qezaly (contrat : qezaly-agent/CONTRAT.md).
 * - callback : fin ou changement d'état d'une tâche.
 * - mails : mails Zoho rattachés à une tâche (codes, liens).
 * Un seul jeton partagé, QEZALY_AGENT_TOKEN, en Bearer dans les deux sens.
 */
const BASE = () => (process.env.QEZALY_BACKEND_URL || '').replace(/\/$/, '');
const TOKEN = () => process.env.QEZALY_AGENT_TOKEN || '';
const RETRIES = [2000, 8000, 30000];

const headers = () => ({ authorization: `Bearer ${TOKEN()}`, 'content-type': 'application/json' });

/** Envoie l'état d'une tâche. 3 nouveaux essais (2 s, 8 s, 30 s) ; ne lève jamais d'erreur. */
export async function callback(payload) {
  if (!BASE()) return false;
  for (let i = 0; i <= RETRIES.length; i++) {
    try {
      const res = await fetch(`${BASE()}/api/agent/callback`, {
        method: 'POST', headers: headers(), body: JSON.stringify(payload), signal: AbortSignal.timeout(15000)
      });
      if (res.ok) return true;
      // Erreur du client (jeton, format) : inutile de réessayer.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        console.log(`  Qezaly : callback refusé (HTTP ${res.status}) pour la tâche ${payload.taskId}`);
        return false;
      }
    } catch { /* réseau : nouvel essai */ }
    if (i < RETRIES.length) await new Promise((r) => setTimeout(r, RETRIES[i]));
  }
  console.log(`  Qezaly : callback non remis après ${RETRIES.length + 1} essais pour la tâche ${payload.taskId}`);
  return false;
}

/** Mails de la tâche reçus depuis `since` (ISO). Liste vide si le back-end n'est pas réglé. */
export async function fetchMails(taskId, since) {
  if (!BASE()) return [];
  const q = since ? `?since=${encodeURIComponent(since)}` : '';
  const res = await fetch(`${BASE()}/api/agent/tasks/${encodeURIComponent(taskId)}/mails${q}`, {
    headers: headers(), signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`back-end : HTTP ${res.status}`);
  return (await res.json()).mails ?? [];
}

/** Forme commune d'un mail, quel que soit le nom des champs envoyés. */
export function normalizeMail(m) {
  const text = String(m.text ?? m.body_text ?? '');
  return {
    id: String(m.id ?? m.message_id ?? `${m.from}-${m.subject}-${m.receivedAt ?? m.received_at}`),
    from: String(m.from ?? m.from_address ?? ''),
    subject: String(m.subject ?? ''),
    text,
    links: Array.isArray(m.links) ? m.links.map(String) : [],
    codes: Array.isArray(m.codes) && m.codes.length ? m.codes.map(String) : [...new Set(text.match(/\b\d{4,8}\b/g) ?? [])],
    receivedAt: m.receivedAt ?? m.received_at ?? new Date().toISOString()
  };
}
