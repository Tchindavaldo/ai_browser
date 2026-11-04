import { randomUUID } from 'node:crypto';
import { BrowserHost, ENGINE_NAMES } from './browser.js';
import { Session } from './agent.js';

/**
 * Gère plusieurs conversations en parallèle.
 *
 * - Un « navigateur » (BrowserHost) = un profil invite neuf et jetable.
 * - Une « session » = une conversation + un onglet.
 * - Deux sessions dans le même navigateur partagent le profil (cookies, connexions) ;
 *   deux navigateurs distincts sont totalement cloisonnés.
 */
export class Manager {
  constructor({ onEvent = () => {} } = {}) {
    this.hosts = new Map();     // hostId -> { id, host, engine, headless, label }
    this.sessions = new Map();  // sessionId -> { id, title, hostId, tab, session, events, stats }
    this.feed = [];             // activité récente, toutes sessions confondues
    this.onEvent = onEvent;
    this.activeId = null;
  }

  get engines() { return ENGINE_NAMES; }

  #emit(sessionId, event) {
    const e = { ...event, sessionId, ts: Date.now() };
    const s = this.sessions.get(sessionId);

    if (s && ['title', 'model', 'thought', 'action', 'result', 'artifact', 'done', 'user', 'system'].includes(event.type)) {
      s.events.push(e);
      if (s.events.length > 600) s.events.shift();
      this.#track(s, e);
    }

    // Flux global : ce que le tableau de bord affiche en temps réel.
    if (s && ['action', 'done', 'user'].includes(event.type)) {
      this.feed.push({ ...e, title: s.title, browserLabel: this.hosts.get(s.hostId)?.label });
      if (this.feed.length > 60) this.feed.shift();
    }

    this.onEvent(e);
  }

  /** Compteurs par session, pour l'état global. */
  #track(s, e) {
    const st = s.stats;
    if (e.type === 'user') {
      st.objective = e.text;
      st.startedAt = e.ts;
      st.steps = 0;
      st.lastAction = null;
      st.tasks++;
    }
    if (e.type === 'action') {
      st.actions++;
      st.steps = e.step ?? st.steps;
      st.lastAction = { name: e.name, args: e.args, ts: e.ts };
    }
    if (e.type === 'thought') st.lastThought = e.text;
    if (e.type === 'done') {
      st.lastResult = { success: !!e.success, result: e.result, cancelled: !!e.cancelled, ts: e.ts };
      st.startedAt = null;
      st.lastAction = null;
    }
  }

  /**
   * Crée une conversation.
   * @param {'browser'|'tab'} mode  nouveau navigateur (profil invite) ou nouvel onglet
   * @param {string} [hostId]       navigateur à réutiliser en mode 'tab'
   */
  async createSession({ mode = 'browser', engine, headless = true, hostId, title } = {}) {
    let entry;

    if (mode === 'tab') {
      entry = this.hosts.get(hostId) ?? [...this.hosts.values()].at(-1);
      if (!entry) mode = 'browser'; // aucun navigateur ouvert : on en lance un
    }

    if (mode === 'browser') {
      const host = await new BrowserHost({ engine, headless }).start();
      const id = randomUUID().slice(0, 8);
      entry = { id, host, engine: host.engine, headless: host.headless, label: `${host.engine} #${this.hosts.size + 1}` };
      this.hosts.set(id, entry);
    }

    const tab = await entry.host.newTab();
    const id = randomUUID().slice(0, 8);
    const rec = {
      id,
      title: title || `Session ${this.sessions.size + 1}`,
      hostId: entry.id,
      tab,
      session: new Session({ tab }),
      events: [],
      createdAt: Date.now(),
      stats: { tasks: 0, actions: 0, steps: 0, objective: null, startedAt: null,
               lastAction: null, lastThought: null, lastResult: null }
    };
    this.sessions.set(id, rec);
    this.activeId = id;
    this.#emit(id, { type: 'system', text: `Nouvel onglet dans ${entry.label}.` });
    return rec;
  }

  get(id) {
    const rec = this.sessions.get(id);
    if (!rec) throw new Error('session inconnue');
    return rec;
  }

  /** Lance un objectif sur une session, sans bloquer l'appelant. */
  run(id, objective) {
    const rec = this.get(id);
    if (rec.session.busy) throw new Error('une tâche est déjà en cours sur cette session');
    this.#emit(id, { type: 'user', text: objective });
    rec.session
      .run(objective, { onEvent: (e) => this.#emit(id, e) })
      .catch((e) => this.#emit(id, { type: 'done', success: false, result: `ERREUR: ${e.message}` }))
      .finally(() => this.onEvent({ type: 'state', sessionId: id }));
    return rec;
  }

  /** Coupe la tâche en cours. */
  cancel(id) {
    const rec = this.get(id);
    const stopped = rec.session.cancel();
    if (!stopped) this.#emit(id, { type: 'system', text: 'Aucune tâche en cours.' });
    return stopped;
  }

  /** Vide la conversation ET repart sur une page blanche, sans fermer le navigateur. */
  async clear(id) {
    const rec = this.get(id);
    rec.session.cancel();
    rec.session.clear();
    rec.events = [];
    await rec.tab.page.goto('about:blank').catch(() => {});
    this.#emit(id, { type: 'system', text: 'Session nettoyée : historique vidé, page blanche.' });
  }

  /** Ferme une session (et son navigateur s'il devient vide). */
  async closeSession(id) {
    const rec = this.get(id);
    rec.session.cancel();
    await rec.tab.close();
    this.sessions.delete(id);

    const entry = this.hosts.get(rec.hostId);
    const stillUsed = [...this.sessions.values()].some((s) => s.hostId === rec.hostId);
    if (entry && !stillUsed) {
      await entry.host.close();
      this.hosts.delete(entry.id);
    }
    if (this.activeId === id) this.activeId = [...this.sessions.keys()].at(-1) ?? null;
  }

  async closeAll() {
    for (const id of [...this.sessions.keys()]) await this.closeSession(id).catch(() => {});
  }

  /** Vue destinée à l'interface. */
  state() {
    const sessions = [...this.sessions.values()].map((s) => ({
      id: s.id,
      title: s.title,
      hostId: s.hostId,
      engine: this.hosts.get(s.hostId)?.engine,
      browserLabel: this.hosts.get(s.hostId)?.label,
      headless: this.hosts.get(s.hostId)?.headless,
      busy: s.session.busy,
      model: s.session.model,
      shots: !!s.session.shotEveryStep,
      using: s.session.usingModel ?? null,
      url: safeUrl(s.tab),
      createdAt: s.createdAt,
      ...s.stats
    }));

    return {
      activeId: this.activeId,
      engines: this.engines,
      browsers: [...this.hosts.values()].map((h) => ({
        id: h.id, label: h.label, engine: h.engine, headless: h.headless,
        sessions: sessions.filter((s) => s.hostId === h.id).length,
        busy: sessions.some((s) => s.hostId === h.id && s.busy)
      })),
      sessions,
      feed: this.feed.slice(-40).reverse(),
      totals: {
        browsers: this.hosts.size,
        sessions: this.sessions.size,
        running: sessions.filter((s) => s.busy).length,
        actions: sessions.reduce((n, s) => n + s.actions, 0),
        tasks: sessions.reduce((n, s) => n + s.tasks, 0)
      }
    };
  }

  /** Vignettes de toutes les sessions, pour le tableau de bord. */
  async thumbs() {
    const out = {};
    await Promise.all([...this.sessions.values()].map(async (s) => {
      try { out[s.id] = await s.tab.screenshot(); } catch { out[s.id] = null; }
    }));
    return out;
  }
}

const safeUrl = (tab) => { try { return tab.page.url(); } catch { return null; } };
