import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/**
 * Connexion du navigateur de l'agent : proxy (pour sortir sur Internet depuis un autre pays,
 * ex. le Cameroun) et fuseau horaire. Réglages dans browser-settings.json, à côté de
 * llm-settings.json (volume /data sur Fly), ignoré par git car il peut contenir un mot de passe.
 * Appliqués à chaque nouveau navigateur ; les navigateurs déjà ouverts gardent leur connexion.
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LLM_FILE = process.env.RAUVALIA_SETTINGS || path.join(ROOT, 'llm-settings.json');
const FILE = path.join(path.dirname(LLM_FILE), 'browser-settings.json');

const DEFAULTS = { enabled: false, server: '', username: '', password: '', timezone: 'Africa/Douala' };
let conf = { ...DEFAULTS };
try { conf = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch { /* pas encore de fichier */ }

/** État lisible par l'interface (sans le mot de passe). */
export function netState() {
  const { password, ...rest } = conf;
  return { ...rest, hasPassword: !!password };
}

export function updateNet({ enabled, server, username, password, timezone }) {
  if (server !== undefined) {
    const s = String(server).trim();
    if (s && !/^(https?|socks5):\/\/[^\s/]+:\d+$/i.test(s)) {
      throw new Error('Adresse du proxy invalide. Exemple : http://102.244.78.61:8089 ou socks5://hote:1080');
    }
    conf.server = s;
  }
  if (username !== undefined) conf.username = String(username).trim();
  // Mot de passe : vide = inchangé ; "-" = effacé.
  if (password !== undefined && String(password) !== '') conf.password = String(password) === '-' ? '' : String(password);
  if (timezone !== undefined) {
    const tz = String(timezone).trim();
    if (tz) { try { new Intl.DateTimeFormat('fr', { timeZone: tz }); } catch { throw new Error(`Fuseau horaire inconnu : ${tz}`); } }
    conf.timezone = tz;
  }
  if (enabled !== undefined) conf.enabled = !!enabled;
  if (conf.enabled && !conf.server) throw new Error('Indique l\'adresse du proxy avant de l\'activer.');
  fs.writeFileSync(FILE, JSON.stringify(conf, null, 2));
  return netState();
}

/** Options Playwright : proxy au lancement, fuseau horaire au contexte. */
export function proxyOption(c = conf) {
  if (!c.enabled || !c.server) return undefined;
  return { server: c.server, ...(c.username ? { username: c.username } : {}), ...(c.password ? { password: c.password } : {}) };
}
export const timezoneOption = (c = conf) => (c.enabled && c.timezone ? c.timezone : undefined);

/** Ouvre un navigateur avec la connexion réglée et demande à un site public d'où il voit la visite. */
export async function testNet() {
  const t0 = Date.now();
  const browser = await chromium.launch({ headless: true, proxy: proxyOption({ ...conf, enabled: true }) ?? undefined });
  try {
    const page = await browser.newPage();
    const res = await page.goto('http://ip-api.com/json/?fields=status,message,country,countryCode,city,isp,query', { timeout: 25000 });
    const info = JSON.parse(await res.text());
    return { ok: info.status === 'success', viaProxy: !!conf.server, ...info, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, viaProxy: !!conf.server, error: String(e.message).split('\n')[0].slice(0, 200), ms: Date.now() - t0 };
  } finally {
    await browser.close().catch(() => {});
  }
}
