import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, provider, listModels, guessVision } from './providers.js';

/**
 * Appels IA avec une chaîne de modèles et bascule automatique.
 *
 * Réglages (chaîne, clés, bascule) dans llm-settings.json, ignoré par git,
 * modifiables depuis l'interface. Les clés peuvent aussi venir des variables
 * d'environnement (DEEPSEEK_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY...).
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// RAUVALIA_SETTINGS : autre emplacement (ex. volume Fly /data/llm-settings.json).
const FILE = process.env.RAUVALIA_SETTINGS || path.join(ROOT, 'llm-settings.json');

// Un modèle en quota épuisé ou limité est sauté pendant ce délai.
const COOLDOWN_MS = 10 * 60 * 1000;
// Temps maximum d'attente d'une réponse du modèle (au-delà, on passe au modèle suivant).
const CALL_TIMEOUT_MS = 90 * 1000;
const cooldown = new Map(); // "fournisseur|modèle" -> fin de pause (ms)

function load() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  const chain = Array.isArray(s.chain) && s.chain.length
    ? s.chain
    : [{ provider: 'deepseek', model: provider('deepseek').defaultModel }];
  return { chain, keys: s.keys ?? {}, fallback: s.fallback ?? true };
}

let settings = load();

const save = () => fs.writeFileSync(FILE, JSON.stringify(settings, null, 2));

export const keyFor = (id) => settings.keys[id] || process.env[provider(id)?.env] || '';

const mask = (k) => (k.length > 10 ? `${k.slice(0, 4)}...${k.slice(-4)}` : k ? '***' : '');

/** État lisible par l'interface (sans exposer les clés). */
export function llmState() {
  const now = Date.now();
  return {
    chain: settings.chain,
    fallback: settings.fallback,
    cooldowns: Object.fromEntries([...cooldown].filter(([, t]) => t > now).map(([k, t]) => [k, Math.ceil((t - now) / 60000)])),
    providers: PROVIDERS.map((p) => ({
      id: p.id, name: p.name, free: p.free, keyUrl: p.keyUrl, env: p.env,
      defaultModel: p.defaultModel, hasKey: !!keyFor(p.id), keyHint: mask(keyFor(p.id))
    }))
  };
}

export function updateSettings({ chain, fallback, keys }) {
  if (chain !== undefined) {
    if (!Array.isArray(chain) || !chain.length) throw new Error('Il faut au moins un modèle.');
    for (const e of chain) {
      if (!provider(e?.provider) || !String(e?.model ?? '').trim()) throw new Error('Modèle invalide.');
    }
    settings.chain = chain.map((e) => ({ provider: e.provider, model: String(e.model).trim() }));
    cooldown.clear();
  }
  if (fallback !== undefined) settings.fallback = !!fallback;
  for (const [id, k] of Object.entries(keys ?? {})) {
    if (!provider(id)) continue;
    if (String(k).trim()) settings.keys[id] = String(k).trim();
    else delete settings.keys[id];
  }
  save();
  return llmState();
}

/** Un appel sur un seul modèle, avec relance sur erreur passagère (pas sur quota). */
async function callOne(entry, { messages, tools, temperature, signal }) {
  const p = provider(entry.provider);
  if (!p) throw Object.assign(new Error(`Fournisseur inconnu : ${entry.provider}`), { skip: true });
  const key = keyFor(p.id);
  if (!key) throw Object.assign(new Error(`Clé manquante (${p.env})`), { skip: true });

  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  if (p.id === 'openrouter') headers['x-title'] = 'AI Browser';
  // Gemini refuse un contenu null (messages d'appel d'outil) et les champs qu'il ne connaît pas.
  const msgs = p.id === 'gemini'
    ? messages.map(({ reasoning_content, ...m }) => (m.content == null ? { ...m, content: '' } : m))
    : messages;
  const body = { model: entry.model, messages: msgs, temperature };
  if (tools?.length) Object.assign(body, { tools, tool_choice: 'auto' });

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    let res;
    // Limite de temps : un modèle qui ne répond pas ne doit pas bloquer l'agent indéfiniment.
    const limit = AbortSignal.timeout(CALL_TIMEOUT_MS);
    try {
      res = await fetch(`${p.base}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, limit]) : limit
      });
    } catch (e) {
      if (e.name === 'AbortError' && signal?.aborted) throw e;
      if (e.name === 'TimeoutError' || limit.aborted) {
        throw new Error(`${p.name} n'a pas répondu en ${CALL_TIMEOUT_MS / 1000} s`);
      }
      lastErr = e; continue;
    }
    if (res.ok) {
      const json = await res.json();
      const msg = json.choices?.[0]?.message;
      if (!msg) throw new Error(`Réponse vide : ${JSON.stringify(json).slice(0, 200)}`);
      return msg;
    }
    const text = (await res.text()).slice(0, 400);
    // Quota épuisé ou limite atteinte : inutile d'insister, on passe au suivant.
    if (res.status === 402 || res.status === 429 || /quota|rate.?limit|credit/i.test(text)) {
      cooldown.set(`${entry.provider}|${entry.model}`, Date.now() + COOLDOWN_MS);
      throw new Error(`${p.name} épuisé (${res.status}) : ${text}`);
    }
    if (res.status >= 500) { lastErr = new Error(`${p.name} ${res.status} : ${text}`); continue; }
    throw new Error(`${p.name} ${res.status} : ${text}`);
  }
  throw lastErr;
}

// Le modèle lit-il les images ? D'après la liste de l'hébergeur (gardée 1 h), sinon d'après son nom.
const VISION = new Map(); // fournisseur -> { at, ids: Map(id -> vision) }
export async function readsImages(entry) {
  const p = provider(entry.provider);
  let c = VISION.get(p.id);
  if (!c || Date.now() - c.at > 3600_000) {
    try {
      const list = await listModels(p, keyFor(p.id));
      c = { at: Date.now(), ids: new Map(list.map((m) => [m.id, m.vision])) };
      VISION.set(p.id, c);
    } catch { c = null; }
  }
  return c?.ids.has(entry.model) ? c.ids.get(entry.model) : guessVision(p, entry.model);
}

/** Pour un modèle texte seul, les captures sont retirées et remplacées par une note. */
function textOnly(messages) {
  return messages.map((m) => Array.isArray(m.content)
    ? { ...m, content: m.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n') + '\n(capture non envoyée : ce modèle ne lit pas les images)' }
    : m);
}

let lastUsed = null;

/** Modèle qui sera essayé en premier (celui de la session, sinon le premier de la chaîne disponible). */
export function plannedModel(prefer) {
  if (prefer?.provider && prefer?.model) return prefer;
  const now = Date.now();
  return settings.chain.find((e) => (cooldown.get(`${e.provider}|${e.model}`) ?? 0) <= now) ?? settings.chain[0];
}

/** Appel chat/completions compatible OpenAI, en suivant la chaîne de modèles. */
export async function chat({ messages, tools, temperature = 0, signal, prefer }) {
  // prefer : modèle choisi pour une session précise ; il passe en tête, la chaîne sert de secours.
  let chain = settings.chain;
  if (prefer?.provider && prefer?.model) {
    chain = [prefer, ...chain.filter((e) => !(e.provider === prefer.provider && e.model === prefer.model))];
  }
  if (!settings.fallback) chain = chain.slice(0, 1);
  const now = Date.now();
  const ready = chain.filter((e) => (cooldown.get(`${e.provider}|${e.model}`) ?? 0) <= now);
  const errors = [];
  for (const entry of ready.length ? ready : chain) {
    try {
      const hasImage = messages.some((m) => Array.isArray(m.content));
      const msgs = hasImage && !(await readsImages(entry)) ? textOnly(messages) : messages;
      const msg = await callOne(entry, { messages: msgs, tools, temperature, signal });
      lastUsed = entry;
      // Modèle qui a répondu, invisible dans le JSON renvoyé aux API.
      Object.defineProperty(msg, 'usedModel', { value: entry, enumerable: false });
      // true : une capture était jointe mais ce modèle (texte seul) ne l'a pas reçue.
      Object.defineProperty(msg, 'imageDropped', { value: hasImage && msgs !== messages, enumerable: false });
      return msg;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      errors.push(`${entry.provider}/${entry.model} : ${e.message}`);
    }
  }
  throw new Error(`Aucun modèle n'a répondu.\n${errors.join('\n')}`);
}

/** Test rapide depuis l'interface : quel modèle répond, et pourquoi les autres échouent. */
export async function testChain() {
  const results = [];
  for (const entry of settings.chain) {
    try {
      const msg = await callOne(entry, { messages: [{ role: 'user', content: 'Réponds juste : OK' }], temperature: 0 });
      results.push({ ...entry, ok: true, text: String(msg.content ?? '').slice(0, 80) });
    } catch (e) {
      results.push({ ...entry, ok: false, error: e.message.slice(0, 300) });
    }
  }
  return results;
}

export const modelName = (entry) => {
  const e = entry ?? lastUsed ?? settings.chain[0];
  return e ? `${provider(e.provider)?.name ?? e.provider} · ${e.model}` : 'aucun';
};
