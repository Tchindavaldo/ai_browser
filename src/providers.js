/**
 * Fournisseurs d'IA compatibles OpenAI (/chat/completions avec outils).
 * Tous proposent des modèles gratuits en plus des payants, sauf DeepSeek
 * (gardé car c'est le fournisseur d'origine).
 */
export const PROVIDERS = [
  {
    id: 'deepseek', name: 'DeepSeek', base: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    env: 'DEEPSEEK_API_KEY', defaultModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys', free: 'Payant uniquement (très bon marché).'
  },
  {
    id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1',
    env: 'OPENROUTER_API_KEY', defaultModel: 'deepseek/deepseek-chat-v3-0324:free',
    keyUrl: 'https://openrouter.ai/settings/keys',
    free: 'Modèles « :free » gratuits (environ 50 requêtes par jour, 1000 avec 10 $ de crédits). Des centaines de modèles payants.'
  },
  {
    id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1',
    env: 'GROQ_API_KEY', defaultModel: 'openai/gpt-oss-120b',
    keyUrl: 'https://console.groq.com/keys', allFree: true,
    free: 'Tous les modèles gratuits avec limites par minute et par jour (Llama, Qwen, GPT-OSS, Kimi). Très rapide.'
  },
  {
    id: 'cerebras', name: 'Cerebras', base: 'https://api.cerebras.ai/v1',
    env: 'CEREBRAS_API_KEY', defaultModel: 'llama-3.3-70b',
    keyUrl: 'https://cloud.cerebras.ai/', allFree: true,
    free: 'Tous les modèles gratuits avec limites par minute et par jour (Llama, Qwen, GPT-OSS).'
  },
  {
    id: 'gemini', name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    env: 'GEMINI_API_KEY', defaultModel: 'gemini-3.8-flash',
    keyUrl: 'https://aistudio.google.com/apikey', allFree: true,
    free: 'Modèles Google uniquement. Flash gratuit avec limites, Pro payant.'
  },
  {
    id: 'mistral', name: 'Mistral AI', base: 'https://api.mistral.ai/v1',
    env: 'MISTRAL_API_KEY', defaultModel: 'mistral-small-latest',
    keyUrl: 'https://console.mistral.ai/api-keys', allFree: true,
    free: 'Modèles Mistral uniquement. Offre « Experiment » gratuite avec limites strictes.'
  },
  {
    id: 'together', name: 'Together AI', base: 'https://api.together.xyz/v1',
    env: 'TOGETHER_API_KEY', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
    keyUrl: 'https://api.together.ai/settings/api-keys',
    free: 'Quelques modèles « -Free » gratuits, beaucoup de payants.'
  },
  {
    id: 'huggingface', name: 'Hugging Face', base: 'https://router.huggingface.co/v1',
    env: 'HF_TOKEN', defaultModel: 'Qwen/Qwen2.5-72B-Instruct',
    keyUrl: 'https://huggingface.co/settings/tokens',
    free: 'Pas de modèle gratuit à proprement parler : petit crédit offert chaque mois.'
  }
];

export const provider = (id) => PROVIDERS.find((p) => p.id === id);

const zero = (v) => v !== undefined && Number(v) === 0;

function isFree(p, m) {
  if (p.allFree) return true;
  if (p.id === 'openrouter') return m.id.endsWith(':free') || (zero(m.pricing?.prompt) && zero(m.pricing?.completion));
  if (p.id === 'together') return m.id.includes('-Free') || (zero(m.pricing?.input) && zero(m.pricing?.output));
  return false;
}

// Noms typiques des modèles qui acceptent des images, quand l'API ne le dit pas.
const VISION_NAME = /vision|[-_.]vl\b|-vl-|llama-4|scout|maverick|pixtral|gemma-3|gemma-4|gpt-4o|gpt-4\.1|gpt-5|claude|gemini|llava|qwen.*omni|mistral-(small|medium)/i;

function acceptsImages(p, m, id) {
  const mods = m.architecture?.input_modalities;
  if (Array.isArray(mods)) return mods.includes('image');
  if (m.capabilities && 'vision' in m.capabilities) return !!m.capabilities.vision;
  if (p.id === 'gemini') return /gemini|gemma-3|gemma-4/.test(id);
  if (p.id === 'deepseek') return false;
  return VISION_NAME.test(id);
}

/** Devine d'après le nom si un modèle lit les images (quand la liste de l'hébergeur ne le dit pas). */
export const guessVision = (p, id) => acceptsImages(p, {}, id);

/** Liste des modèles d'un fournisseur : [{ id, free, vision, inputs }], gratuits d'abord. */
export async function listModels(p, key) {
  const res = await fetch(`${p.base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const raw = Array.isArray(body) ? body : body.data ?? [];
  const out = [];
  for (const m of raw) {
    let id = m.id;
    if (!id) continue;
    if (p.id === 'together' && m.type && !['chat', 'language'].includes(m.type)) continue;
    // L'agent pilote le navigateur par appels d'outils : on écarte les modèles qui ne les gèrent pas.
    if (p.id === 'openrouter' && m.supported_parameters && !m.supported_parameters.includes('tools')) continue;
    if (p.id === 'gemini') {
      id = id.replace(/^models\//, '');
      if (/embedding|imagen|veo|tts|image/.test(id)) continue;
    }
    if (/whisper|embed|guard|tts|transcribe|orpheus/i.test(id)) continue;
    const vision = acceptsImages(p, m, id);
    // Types d'entrée : donnés par l'API quand elle le dit (OpenRouter), sinon texte (+ image).
    const mods = m.architecture?.input_modalities;
    const inputs = Array.isArray(mods) && mods.length ? [...new Set(['text', ...mods])] : vision ? ['text', 'image'] : ['text'];
    out.push({ id, free: isFree(p, m), vision, inputs });
  }
  return out.sort((a, b) => (b.free - a.free) || a.id.localeCompare(b.id));
}
