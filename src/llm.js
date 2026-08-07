const BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

/** Appel chat/completions compatible OpenAI, avec retry sur erreur transitoire. */
export async function chat({ messages, tools, temperature = 0, signal }) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY manquant dans l’environnement.');

  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', temperature })
      });
      if (!res.ok) {
        const body = await res.text();
        if (res.status >= 500 || res.status === 429) { lastErr = new Error(`${res.status}: ${body.slice(0, 300)}`); continue; }
        throw new Error(`DeepSeek ${res.status}: ${body.slice(0, 500)}`);
      }
      const json = await res.json();
      return json.choices[0].message;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

export const modelName = () => MODEL;
