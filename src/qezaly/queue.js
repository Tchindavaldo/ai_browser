/**
 * File des tâches Qezaly : reçues du back-end, exécutées par l'agent, au plus N à la fois.
 *
 * - N = maxParallel donné par le back-end (GET /api/agent/settings), relu chaque minute
 *   (sinon QEZALY_MAX_PARALLEL, sinon 10). L'agent n'accède à aucune base.
 * - Chaque tâche a son propre navigateur (profil neuf, cloisonné) : une session normale,
 *   visible dans le tableau de bord, où l'admin peut reprendre la main.
 * - Chaque changement d'état est renvoyé au back-end (callback), avec étapes, jetons et coût.
 */
import { objectiveOf, secretsOf } from './prompts.js';
import { callback, fetchMails, fetchSettings, fetchUnfinished, normalizeMail } from './backend.js';

const DEFAULT_LIMIT = Number(process.env.QEZALY_MAX_PARALLEL || 10);
const MAX_STEPS = Number(process.env.QEZALY_MAX_STEPS || 80);
// Session gardée ouverte après un échec, pour que l'admin reprenne la main dans l'interface.
const KEEP_FAILED_MS = Number(process.env.QEZALY_KEEP_FAILED_MIN || 60) * 60 * 1000;
const KEEP_DONE_MS = 60 * 1000;
const FINISHED_KEPT = 500; // tâches terminées gardées en mémoire pour GET /tasks/:id

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

export class TaskQueue {
  constructor(manager) {
    this.manager = manager;
    this.tasks = new Map(); // taskId -> rec
    this.order = [];        // taskIds en attente, dans l'ordre d'arrivée
    this.limit = DEFAULT_LIMIT;
    this.limitSource = 'défaut';
  }

  async start() {
    await this.refreshLimit();
    setInterval(() => this.refreshLimit().then(() => this.#pump()), 60 * 1000).unref();
    // Garde la machine Fly allumée tant qu'il y a du travail (voir #keepAlive).
    setInterval(() => this.#keepAlive(), 60 * 1000).unref();
    // Attente : une tâche envoyée juste au réveil de la machine doit arriver avant la reprise.
    setTimeout(() => this.#recover(), 15 * 1000).unref();
    return this;
  }

  async refreshLimit() {
    try {
      const v = Number((await fetchSettings())?.maxParallel);
      if (Number.isInteger(v) && v > 0) { this.limit = v; this.limitSource = 'back-end'; return; }
    } catch (e) { console.log(`  Qezaly : réglage maxParallel illisible (${e.message}), on garde ${this.limit}`); return; }
    this.limit = DEFAULT_LIMIT; this.limitSource = 'défaut';
  }

  get running() { return [...this.tasks.values()].filter((r) => ['running', 'waiting_mail'].includes(r.status)).length; }

  /** Ajoute une tâche. Renvoyer la même taskId ne la duplique pas, sauf pour relancer un échec. */
  enqueue(task) {
    const known = this.tasks.get(task.taskId);
    // Une tâche en échec ou annulée peut être relancée (reprise par l'admin) ; sinon pas de doublon.
    if (known && !['failed', 'cancelled'].includes(known.status)) return this.#brief(known);
    const rec = {
      task, status: 'queued', success: null, result: null, needsAdmin: false,
      sessionId: null, steps: 0, usage: null, captures: [],
      inbox: [], seenMails: new Set(), queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null
    };
    this.tasks.set(task.taskId, rec);
    this.order.push(task.taskId);
    this.#report(rec);
    this.#pump();
    return this.#brief(rec);
  }

  get(taskId) { return this.tasks.get(taskId); }

  /** Mails poussés par le back-end pour une tâche. */
  pushMails(taskId, mails) {
    const rec = this.tasks.get(taskId);
    if (!rec) return 0;
    let n = 0;
    for (const m of mails.map(normalizeMail)) if (!rec.seenMails.has(m.id) && !rec.inbox.some((x) => x.id === m.id)) { rec.inbox.push(m); n++; }
    return n;
  }

  cancel(taskId) {
    const rec = this.tasks.get(taskId);
    if (!rec) return false;
    if (rec.status === 'queued') {
      this.order = this.order.filter((id) => id !== taskId);
      this.#finish(rec, { status: 'cancelled', success: false, result: 'Tâche annulée avant son lancement.' });
      return true;
    }
    if (rec.sessionId && this.manager.sessions.has(rec.sessionId)) return this.manager.cancel(rec.sessionId);
    return false;
  }

  view(rec) {
    return {
      taskId: rec.task.taskId, orderId: rec.task.orderId ?? null, service: rec.task.service,
      status: rec.status, success: rec.success, result: rec.result, needsAdmin: rec.needsAdmin,
      sessionId: rec.sessionId, steps: rec.steps, usage: rec.usage, captures: rec.captures,
      position: rec.status === 'queued' ? this.order.indexOf(rec.task.taskId) + 1 : null,
      queuedAt: rec.queuedAt, startedAt: rec.startedAt, finishedAt: rec.finishedAt
    };
  }

  state() {
    return {
      limit: this.limit, limitSource: this.limitSource, running: this.running, queued: this.order.length,
      tasks: [...this.tasks.values()].map((r) => this.view(r)).reverse().slice(0, 100)
    };
  }

  #brief(rec) {
    return { taskId: rec.task.taskId, status: rec.status, position: rec.status === 'queued' ? this.order.indexOf(rec.task.taskId) + 1 : null };
  }

  #pump() {
    while (this.order.length && this.running < this.limit) {
      const rec = this.tasks.get(this.order.shift());
      if (rec?.status === 'queued') this.#run(rec).catch((e) => this.#finish(rec, { status: 'failed', success: false, result: `ERREUR: ${e.message}` }));
    }
  }

  async #run(rec) {
    const { task } = rec;
    rec.status = 'running';
    rec.startedAt = new Date().toISOString();
    this.#report(rec);
    let session;
    try {
      session = await this.manager.createSession({
        mode: 'browser', headless: true,
        title: `Qezaly ${task.service} ${String(task.taskId).slice(0, 8)}`,
        sessionOptions: { maxSteps: MAX_STEPS, secrets: secretsOf(task), extraTools: [this.#mailTool(rec)] }
      });
    } catch (e) {
      return this.#finish(rec, { status: 'failed', success: false, result: `Navigateur impossible à lancer : ${e.message}` });
    }
    rec.sessionId = session.id;

    const res = await this.manager.runTask(session.id, objectiveOf(task));
    rec.captures = session.events.filter((e) => e.type === 'artifact' && e.url).map((e) => e.url);
    const status = res.cancelled ? 'cancelled' : res.success ? 'done' : 'failed';
    this.#finish(rec, { status, success: !!res.success, result: res.result, steps: res.steps ?? 0, usage: res.usage ?? null });

    // Réussite : la session se ferme. Échec : elle reste ouverte pour l'admin.
    setTimeout(() => {
      if (this.manager.sessions.has(session.id) && !this.manager.sessions.get(session.id).session.busy) {
        this.manager.closeSession(session.id).catch(() => {});
      }
    }, status === 'done' ? KEEP_DONE_MS : KEEP_FAILED_MS).unref();
  }

  #finish(rec, { status, success, result, steps, usage }) {
    Object.assign(rec, { status, success, result: String(result ?? ''), finishedAt: new Date().toISOString() });
    if (steps !== undefined) rec.steps = steps;
    if (usage !== undefined) rec.usage = usage;
    rec.needsAdmin = status === 'failed';
    this.#report(rec);
    this.#forgetOld();
    this.#pump();
  }

  /** Callback au back-end (état, étapes, jetons, coût). Jamais bloquant. */
  #report(rec) {
    const v = this.view(rec);
    const u = rec.usage ?? {};
    callback({
      ...v, at: new Date().toISOString(),
      // Noms attendus aussi par le back-end (premier brouillon).
      session_id: v.sessionId, task_ref: v.taskId, cost_usd: u.usd ?? null, tokens_in: u.input ?? null, tokens_out: u.output ?? null
    });
  }

  #forgetOld() {
    const done = [...this.tasks.values()].filter((r) => r.finishedAt);
    for (const r of done.slice(0, Math.max(0, done.length - FINISHED_KEPT))) this.tasks.delete(r.task.taskId);
  }

  /** Outil lire_mail : mails poussés par le back-end, sinon demandés au back-end, jusqu'à l'attente fixée. */
  #mailTool(rec) {
    return {
      schema: {
        type: 'function',
        function: {
          name: 'lire_mail',
          description: "Lit les e-mails reçus pour ce compte (codes de vérification, liens de confirmation). Attend qu'un nouveau mail arrive, jusqu'à `attente` secondes.",
          parameters: {
            type: 'object',
            properties: {
              raison: { type: 'string', description: 'En une phrase : pourquoi cette action maintenant.' },
              etape: { type: 'string', description: "Titre court (2 à 6 mots) de l'étape du parcours où tu te trouves." },
              attente: { type: 'integer', description: 'Secondes à attendre au plus (défaut 90, max 180)' }
            },
            required: ['raison', 'etape']
          }
        }
      },
      run: async (params, { signal }) => {
        const until = Date.now() + Math.min(Math.max(Number(params.attente) || 90, 5), 180) * 1000;
        rec.status = 'waiting_mail'; this.#report(rec);
        try {
          while (Date.now() < until && !signal?.aborted) {
            let fresh = rec.inbox.filter((m) => !rec.seenMails.has(m.id));
            if (!fresh.length) {
              try {
                const got = (await fetchMails(rec.task.taskId, rec.startedAt)).map(normalizeMail);
                fresh = got.filter((m) => !rec.seenMails.has(m.id));
              } catch (e) { if (Date.now() + 5000 >= until) return `ERREUR: mails indisponibles (${e.message})`; }
            }
            if (fresh.length) {
              fresh.forEach((m) => rec.seenMails.add(m.id));
              rec.inbox = rec.inbox.filter((m) => !rec.seenMails.has(m.id));
              return fresh.map((m) => [
                `De : ${m.from}`, `Objet : ${m.subject}`, `Reçu : ${m.receivedAt}`,
                m.codes.length ? `Codes trouvés : ${m.codes.join(', ')}` : null,
                m.links.length ? `Liens :\n${m.links.slice(0, 15).join('\n')}` : null,
                `Texte :\n${m.text.slice(0, 2000)}`
              ].filter(Boolean).join('\n')).join('\n\n---\n\n');
            }
            await sleep(5000, signal);
          }
          return 'Aucun nouveau mail reçu pendant l’attente.';
        } finally {
          if (rec.status === 'waiting_mail') { rec.status = 'running'; this.#report(rec); }
        }
      }
    };
  }

  /**
   * Fly arrête la machine quand aucune requête ne passe (auto_stop_machines).
   * Une tâche en cours n'envoie aucune requête entrante : on en fait passer une par minute
   * par l'adresse publique, pour que Fly voie du trafic tant qu'il reste du travail.
   */
  #keepAlive() {
    if (!this.running && !this.order.length) return;
    const self = process.env.QEZALY_SELF_URL || (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : '');
    if (self) fetch(`${self.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(10000) }).catch(() => {});
  }

  /** Tâches coupées par un redémarrage : signalées en échec pour que l'admin les reprenne. */
  async #recover() {
    let rows = [];
    try { rows = await fetchUnfinished(); } catch (e) { console.log(`  Qezaly : reprise impossible (${e.message})`); return; }
    // Seules les tâches déjà lancées ont été coupées ; une tâche « queued » peut être en route.
    rows = (rows ?? []).filter((r) => ['running', 'waiting_mail'].includes(r.status));
    for (const r of rows) {
      const rec = {
        task: { taskId: r.taskId, orderId: r.orderId, service: r.service }, status: 'failed', success: false,
        result: 'Tâche interrompue par un redémarrage de l’agent.', needsAdmin: true, sessionId: r.sessionId ?? null,
        steps: 0, usage: null, captures: [], inbox: [], seenMails: new Set(),
        queuedAt: null, startedAt: null, finishedAt: new Date().toISOString()
      };
      if (!r.taskId || this.tasks.has(r.taskId)) continue;
      this.tasks.set(r.taskId, rec);
      this.#report(rec);
    }
    if (rows.length) console.log(`  Qezaly : ${rows.length} tâche(s) interrompue(s) signalée(s) au back-end.`);
  }
}
