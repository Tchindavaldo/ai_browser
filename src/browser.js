import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const ENGINES = {
  firefox: {
    launcher: firefox,
    args: [],
    // Sur certaines machines Windows, le binaire livré sous %LOCALAPPDATA%\ms-playwright
    // échoue au démarrage (résolution SxS de mozglue). Copier le dossier vers un chemin
    // simple (ex. C:\ffx) et pointer RAUVALIA_FIREFOX_PATH dessus contourne le problème.
    executablePath: process.env.RAUVALIA_FIREFOX_PATH || undefined,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0'
  },
  chromium: {
    launcher: chromium,
    args: ['--disable-blink-features=AutomationControlled'],
    // Même problème SxS que Firefox : le chrome.exe livré sous ms-playwright peut échouer
    // au démarrage en fenêtre visible. Le copier vers un chemin simple (ex. C:\chromium)
    // et pointer RAUVALIA_CHROMIUM_PATH dessus contourne le problème.
    executablePath: process.env.RAUVALIA_CHROMIUM_PATH || undefined,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  },
  // Le Microsoft Edge réellement installé sur la machine, pas un binaire téléchargé.
  edge: { launcher: chromium, channel: 'msedge', args: ['--disable-blink-features=AutomationControlled'] },
  // Le Google Chrome réellement installé, s'il est présent.
  chrome: { launcher: chromium, channel: 'chrome', args: ['--disable-blink-features=AutomationControlled'] },
  webkit: { launcher: webkit, args: [] }
};

export const ENGINE_NAMES = Object.keys(ENGINES);

/**
 * Un navigateur lancé = un profil invite, neuf et jetable.
 * Il peut héberger plusieurs onglets qui partagent ce profil (cookies, sessions).
 */
export class BrowserHost {
  constructor({ engine = process.env.RAUVALIA_ENGINE || 'chromium', headless = true,
                viewport = { width: 1280, height: 800 }, locale = 'fr-FR' } = {}) {
    if (!ENGINES[engine]) throw new Error(`Moteur inconnu: ${engine} (${ENGINE_NAMES.join(' | ')})`);
    this.engine = engine;
    this.headless = headless;
    this.opts = { viewport, locale };
    this.tabs = new Set();
  }

  async start() {
    const eng = ENGINES[this.engine];
    this.browser = await eng.launcher.launch({
      headless: this.headless,
      args: eng.args,
      channel: eng.channel,
      executablePath: eng.executablePath
    });
    // Un contexte neuf = profil invite : aucun cookie, aucune session héritée.
    this.context = await this.browser.newContext({
      viewport: this.opts.viewport,
      locale: this.opts.locale,
      userAgent: eng.userAgent
    });
    return this;
  }

  async newTab() {
    const tab = new Tab(await this.context.newPage(), this);
    this.tabs.add(tab);
    return tab;
  }

  async close() {
    this.tabs.clear();
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }
}

const INTERACTIVE = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'summary', 'label',
  '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]',
  '[role=tab]', '[role=menuitem]', '[role=combobox]', '[role=textbox]',
  '[role=option]', '[role=switch]', '[contenteditable=""]', '[contenteditable=true]',
  '[onclick]', '[tabindex]:not([tabindex="-1"])'
].join(',');

/**
 * Un onglet : la page et tout ce qu'elle donne à voir (DOM, console, réseau).
 * Ne décide de rien — expose et exécute.
 */
export class Tab {
  constructor(page, host) {
    this.host = host;
    this.console = [];
    this.network = [];
    this.attach(page);
  }

  /** Branche les écoutes sur une page (ou sur la popup qui la remplace). */
  attach(page) {
    this.page = page;
    page.on('console', (m) => this.#push(this.console, `[${m.type()}] ${m.text()}`, 50));
    page.on('pageerror', (e) => this.#push(this.console, `[pageerror] ${e.message}`, 50));
    page.on('requestfailed', (r) =>
      this.#push(this.network, `${r.method()} ${r.url().slice(0, 200)} → ${r.failure()?.errorText}`, 30));
    page.on('response', (r) => {
      if (r.status() >= 400) {
        this.#push(this.network, `${r.request().method()} ${r.url().slice(0, 200)} → HTTP ${r.status()}`, 30);
      }
    });
    // Une popup ouverte par la page devient la page active de cet onglet.
    page.on('popup', (p) => this.attach(p));
  }

  #push(arr, line, max) {
    arr.push(String(line).slice(0, 500));
    if (arr.length > max) arr.shift();
  }

  loc(ref) { return this.page.locator(`[data-rv-ref="${ref}"]`).first(); }

  /**
   * Comme loc(), mais si la page a redessiné l'élément depuis le dernier snapshot (la référence
   * a disparu), on le retrouve par son type et son libellé, et on lui redonne sa référence.
   */
  async locate(ref) {
    const l = this.loc(ref);
    if (await l.count().catch(() => 0)) return l;
    const want = this.lastElements?.get(Number(ref));
    if (!want) return l;
    await this.page.evaluate(({ ref, want, sel }) => {
      const label = (el) => (
        el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') ||
        el.getAttribute('name') || el.value || el.innerText || el.getAttribute('alt') || ''
      ).replace(/\s+/g, ' ').trim().slice(0, 120);
      const hit = [...document.querySelectorAll(sel)].find((el) =>
        el.tagName.toLowerCase() === want.tag && label(el) === want.name);
      if (hit) hit.setAttribute('data-rv-ref', String(ref));
    }, { ref, want, sel: INTERACTIVE }).catch(() => {});
    return l;
  }

  async close() {
    this.host?.tabs.delete(this);
    await this.page?.close().catch(() => {});
  }

  /**
   * État complet de la page. Ne bloque jamais : si la page est vide
   * (about:blank), on retourne un snapshot vide et l'IA décidera.
   */
  async snapshot({ maxText = 6000, maxElements = 150 } = {}) {
    const url = this.page.url();
    const drain = () => {
      const c = this.console.slice(); const n = this.network.slice();
      this.console = []; this.network = [];
      return { console: c, network: n };
    };

    if (!url || url === 'about:blank') {
      return { url: url || 'about:blank', title: '', empty: true, elements: [], text: '', ...drain() };
    }

    try {
      await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 });
    } catch { /* l'IA verra la page telle quelle */ }

    let data;
    try {
      data = await withTimeout(this.page.evaluate(
        ({ sel, maxText, maxElements }) => {
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) return false;
            const s = getComputedStyle(el);
            return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
          };
          const label = (el) => (
            el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') ||
            el.getAttribute('name') || el.value || el.innerText || el.getAttribute('alt') || ''
          ).replace(/\s+/g, ' ').trim().slice(0, 120);

          document.querySelectorAll('[data-rv-ref]').forEach((e) => e.removeAttribute('data-rv-ref'));

          const out = [];
          let i = 0;
          for (const el of document.querySelectorAll(sel)) {
            if (out.length >= maxElements) break;
            if (!visible(el)) continue;
            const ref = ++i;
            el.setAttribute('data-rv-ref', String(ref));
            const e = {
              ref, tag: el.tagName.toLowerCase(),
              type: el.getAttribute('type') || undefined,
              role: el.getAttribute('role') || undefined,
              name: label(el)
            };
            if (el.tagName === 'A' && el.href) e.href = el.href.slice(0, 200);
            if (el.tagName === 'SELECT') e.options = [...el.options].slice(0, 30).map((o) => o.value || o.text);
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
              e.value = (el.value || '').slice(0, 80);
              if (el.required) e.required = true;
            }
            if (el.checked !== undefined && (el.type === 'checkbox' || el.type === 'radio')) e.checked = el.checked;
            out.push(e);
          }

          const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, maxText);
          return { title: document.title, elements: out, text, scrollY: window.scrollY,
                   scrollHeight: document.body?.scrollHeight ?? 0 };
        },
        { sel: INTERACTIVE, maxText, maxElements }
      ), 10000, "lecture de la page");
    } catch (err) {
      // Page en cours de navigation / contexte détruit : l'IA verra l'erreur brute.
      return { url, title: '', error: String(err.message).slice(0, 300), elements: [], text: '', ...drain() };
    }

    // Garde de quoi retrouver un élément si la page le redessine avant l'action.
    this.lastElements = new Map(data.elements.map((e) => [e.ref, { tag: e.tag, name: e.name }]));
    return { url, ...data, ...drain() };
  }

  async screenshot() {
    const buf = await this.page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
    return buf.toString('base64');
  }

  /**
   * Capture de la page entière pour le modèle (pas seulement la zone visible).
   * Hauteur plafonnée pour que l'image reste lisible une fois réduite par le modèle.
   */
  async pageShotForModel(maxHeight = 6000) {
    const h = await this.page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)).catch(() => 0);
    const vp = this.page.viewportSize() ?? { width: 1280, height: 800 };
    // animations: 'disabled' et caret masqué : évite d'attendre une page qui bouge sans cesse.
    const opts = { type: 'jpeg', quality: 55, timeout: 8000, animations: 'disabled', caret: 'hide' };
    if (h > maxHeight) Object.assign(opts, { fullPage: true, clip: { x: 0, y: 0, width: vp.width, height: maxHeight } });
    else opts.fullPage = true;
    let buf, full = true;
    try {
      buf = await this.page.screenshot(opts);
    } catch {
      // Page entière impossible (trop lourde, polices qui ne finissent pas de charger) : zone visible.
      buf = await this.page.screenshot({ type: 'jpeg', quality: 55, timeout: 5000, animations: 'disabled', caret: 'hide' });
      full = false;
    }
    // Copie sur disque pour l'afficher dans « Activité de l'agent ».
    await fs.mkdir(CAPTURES, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}_modele.jpg`;
    await fs.writeFile(path.join(CAPTURES, name), buf);
    return { b64: buf.toString('base64'), url: `/captures/${name}`, full, kb: Math.round(buf.length / 1024) };
  }

  /**
   * Capture enregistrée sur disque, destinée à être livrée à l'utilisateur.
   * Retourne de quoi l'afficher et la télécharger.
   */
  async saveCapture({ fullPage = false, label } = {}) {
    await fs.mkdir(CAPTURES, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = String(label ?? 'capture').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '');
    const name = `${stamp}_${slug || 'capture'}.png`;
    const file = path.join(CAPTURES, name);
    const buf = await this.page.screenshot({ type: 'png', fullPage });
    await fs.writeFile(file, buf);
    return {
      file, name,
      url: `/captures/${name}`,
      bytes: buf.length,
      pageUrl: this.page.url(),
      title: await this.page.title().catch(() => ''),
      fullPage
    };
  }
}

/** Dossier où atterrissent les captures demandées par l'agent. */
export const CAPTURES = process.env.RAUVALIA_CAPTURES
  || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'captures');

/** Rend un snapshot sous forme de texte compact pour le prompt. */
export function renderSnapshot(s) {
  const L = [`URL: ${s.url}`, `TITRE: ${s.title || '(vide)'}`];
  if (s.empty) L.push('PAGE VIDE — aucune page chargée.');
  if (s.error) L.push(`ERREUR SNAPSHOT: ${s.error}`);
  if (s.scrollHeight) L.push(`SCROLL: ${s.scrollY}px / ${s.scrollHeight}px`);

  L.push('', 'ÉLÉMENTS INTERACTIFS:');
  if (!s.elements.length) L.push('(aucun)');
  for (const e of s.elements) {
    const bits = [`[${e.ref}]`, `<${e.tag}${e.type ? ` type=${e.type}` : ''}>`];
    if (e.role) bits.push(`role=${e.role}`);
    if (e.name) bits.push(JSON.stringify(e.name));
    if (e.value) bits.push(`valeur=${JSON.stringify(e.value)}`);
    if (e.checked !== undefined) bits.push(`coché=${e.checked}`);
    if (e.required) bits.push('requis');
    if (e.options) bits.push(`options=${JSON.stringify(e.options)}`);
    if (e.href) bits.push(e.href);
    L.push('  ' + bits.join(' '));
  }

  L.push('', 'TEXTE DE LA PAGE:', s.text || '(vide)');
  if (s.console?.length) L.push('', 'CONSOLE:', ...s.console.map((c) => '  ' + c));
  if (s.network?.length) L.push('', 'RÉSEAU (échecs / HTTP >= 400):', ...s.network.map((n) => '  ' + n));
  return L.join('\n');
}

/** Rejette si la promesse ne se termine pas à temps (page figée, script qui ne rend pas la main). */
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} : pas de réponse en ${ms / 1000} s`)), ms); })
  ]);
}
