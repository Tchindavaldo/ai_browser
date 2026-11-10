import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/**
 * Connexion du navigateur de l'agent : liste de proxys (téléphones, PC, fournisseur payant...)
 * pour sortir sur Internet depuis un autre pays (ex. le Cameroun), et fuseau horaire.
 *
 * Bascule automatique : à l'ouverture d'un navigateur, le premier proxy de la liste qui répond
 * est utilisé ; s'il est éteint ou injoignable, on passe au suivant. Si aucun ne répond,
 * le navigateur ne s'ouvre pas (pour ne jamais sortir par erreur depuis le pays du serveur).
 *
 * Réglages dans browser-settings.json, à côté de llm-settings.json (volume /data sur Fly),
 * ignoré par git car il peut contenir des mots de passe.
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LLM_FILE = process.env.RAUVALIA_SETTINGS || path.join(ROOT, 'llm-settings.json');
const FILE = path.join(path.dirname(LLM_FILE), 'browser-settings.json');
// Délai pour savoir si un appareil proxy est joignable.
const REACH_MS = 4000;
const SERVER_RE = /^(https?|socks5):\/\/([^\s/:]+):(\d+)$/i;

let conf = { enabled: false, timezone: 'Africa/Douala', proxies: [] };
try {
  const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  conf.enabled = !!s.enabled;
  if (s.timezone !== undefined) conf.timezone = s.timezone;
  conf.proxies = Array.isArray(s.proxies) ? s.proxies
    // Ancien format : un seul proxy.
    : s.server ? [{ name: 'Proxy 1', server: s.server, username: s.username ?? '', password: s.password ?? '' }] : [];
} catch { /* pas encore de fichier */ }

const save = () => fs.writeFileSync(FILE, JSON.stringify(conf, null, 2));

/** Dernier proxy réellement utilisé, pour l'affichage. */
let lastUsed = null;

/** État lisible par l'interface (sans les mots de passe). */
export function netState() {
  return {
    enabled: conf.enabled,
    timezone: conf.timezone,
    proxies: conf.proxies.map(({ password, ...p }) => ({ ...p, hasPassword: !!password })),
    lastUsed
  };
}

/**
 * Remplace les réglages. proxies : liste complète dans l'ordre voulu.
 * Mot de passe d'un proxy : vide = inchangé (retrouvé par son adresse), "-" = effacé.
 */
export function updateNet({ enabled, timezone, proxies }) {
  if (proxies !== undefined) {
    if (!Array.isArray(proxies)) throw new Error('Liste de proxys invalide.');
    conf.proxies = proxies.map((p, i) => {
      const server = String(p?.server ?? '').trim();
      if (!SERVER_RE.test(server)) {
        throw new Error(`Adresse invalide pour le proxy ${i + 1}. Exemple : http://100.64.1.2:8080 ou socks5://hote:1080`);
      }
      const old = conf.proxies.find((o) => o.server === server);
      const pw = String(p.password ?? '');
      return {
        name: String(p.name ?? '').trim() || `Proxy ${i + 1}`,
        server,
        username: String(p.username ?? '').trim(),
        password: pw === '-' ? '' : pw || old?.password || ''
      };
    });
  }
  if (timezone !== undefined) {
    const tz = String(timezone).trim();
    if (tz) { try { new Intl.DateTimeFormat('fr', { timeZone: tz }); } catch { throw new Error(`Fuseau horaire inconnu : ${tz}`); } }
    conf.timezone = tz;
  }
  if (enabled !== undefined) conf.enabled = !!enabled;
  if (conf.enabled && !conf.proxies.length) throw new Error('Ajoute au moins un proxy avant d\'activer.');
  save();
  return netState();
}

/** L'appareil proxy répond-il ? (simple connexion à son port) */
function reachable(server) {
  const [, , host, port] = server.match(SERVER_RE) ?? [];
  if (!host) return Promise.resolve(false);
  return new Promise((resolve) => {
    const s = net.connect({ host, port: Number(port) });
    const end = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(REACH_MS, () => end(false));
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
  });
}

const toOption = (p) => ({ server: p.server, ...(p.username ? { username: p.username } : {}), ...(p.password ? { password: p.password } : {}) });

/**
 * Options Playwright pour un nouveau navigateur : premier proxy joignable de la liste.
 * @returns {{ proxy?: object, timezoneId?: string, via?: string }}
 */
export async function connectionOptions() {
  if (!conf.enabled || !conf.proxies.length) return {};
  const tried = [];
  for (const p of conf.proxies) {
    if (await reachable(p.server)) {
      lastUsed = { name: p.name, server: p.server, at: Date.now(), skipped: tried };
      return { proxy: toOption(p), timezoneId: conf.timezone || undefined, via: p.name };
    }
    tried.push(p.name);
  }
  throw new Error(`Aucun proxy ne répond (${tried.join(', ')}). Vérifie que les appareils sont allumés et connectés, ou désactive le proxy dans la vue Connexion.`);
}

/** Ouvre un navigateur par un proxy (ou en direct) et demande à un site public d'où il voit la visite. */
async function testOne(p) {
  const t0 = Date.now();
  if (p && !(await reachable(p.server))) return { ok: false, name: p.name, error: 'appareil injoignable (éteint, hors réseau ou application proxy fermée)', ms: Date.now() - t0 };
  const browser = await chromium.launch({ headless: true, ...(p ? { proxy: toOption(p) } : {}) });
  try {
    const page = await browser.newPage();
    const res = await page.goto('http://ip-api.com/json/?fields=status,message,country,countryCode,city,isp,query', { timeout: 25000 });
    const info = JSON.parse(await res.text());
    return { ok: info.status === 'success', name: p?.name ?? 'Connexion directe', ...info, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, name: p?.name ?? 'Connexion directe', error: String(e.message).split('\n')[0].slice(0, 200), ms: Date.now() - t0 };
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Teste chaque proxy de la liste (ou la connexion directe s'il n'y en a pas). */
export async function testNet() {
  if (!conf.proxies.length) return [await testOne(null)];
  return Promise.all(conf.proxies.map(testOne));
}
