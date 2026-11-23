/**
 * Supabase propre à l'agent (pas celui du back-end Qezaly) : réglages et coûts par tâche.
 * Appels REST directs (PostgREST), sans dépendance. Sans SUPABASE_URL, tout est ignoré.
 *
 * Tables (voir supabase/schema.sql) :
 * - agent_settings (key, value) : max_parallel = 10 par défaut.
 * - agent_runs : une ligne par tâche (état, étapes, jetons, coût).
 */
const URL_ = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_KEY || '';

export const supabaseOn = () => !!(URL_ && KEY);

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': 'application/json',
      ...(prefer ? { prefer } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} : HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

/** Valeur d'un réglage, ou null s'il n'existe pas (ou si Supabase est absent / injoignable). */
export async function getSetting(key) {
  if (!supabaseOn()) return null;
  const rows = await rest(`agent_settings?key=eq.${encodeURIComponent(key)}&select=value`);
  return rows?.[0]?.value ?? null;
}

/** Crée ou met à jour la ligne de la tâche. Les erreurs sont journalisées, jamais bloquantes. */
export async function saveRun(row) {
  if (!supabaseOn()) return;
  try {
    await rest('agent_runs?on_conflict=task_id', {
      method: 'POST', body: { ...row, updated_at: new Date().toISOString() },
      prefer: 'resolution=merge-duplicates,return=minimal'
    });
  } catch (e) { console.log(`  Qezaly : enregistrement Supabase impossible (${e.message})`); }
}

/** Tâches restées « queued » ou « running » : elles ont été coupées par un redémarrage. */
export async function unfinishedRuns() {
  if (!supabaseOn()) return [];
  return rest('agent_runs?status=in.(queued,running,waiting_mail)&select=task_id,order_id,service,session_id');
}
