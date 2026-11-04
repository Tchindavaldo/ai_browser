/**
 * Coût des appels IA : jetons consommés à chaque étape, montant en dollars et en francs CFA.
 *
 * Prix : donné par OpenRouter dans sa réponse (usage.cost) quand il le fournit, sinon d'après sa liste
 * publique des modèles (prix par jeton, gardée 1 h). Pour les autres fournisseurs, le prix n'est connu
 * que si le même modèle existe sur OpenRouter ; sinon le coût reste inconnu.
 * Taux dollar -> franc CFA : open.er-api.com (gardé 12 h), sinon dernière valeur connue.
 */
const PRICE_TTL = 60 * 60 * 1000;
const RATE_TTL = 12 * 60 * 60 * 1000;
let prices = { at: 0, ids: new Map() }; // id -> { in, out } en dollars par jeton
let rate = { at: 0, xof: 586.1 }; // francs CFA pour 1 dollar (valeur de secours : 4 novembre 2026)

async function loadPrices() {
  if (Date.now() - prices.at < PRICE_TTL) return prices.ids;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(10000) });
    const ids = new Map();
    for (const m of (await res.json()).data ?? []) {
      const i = Number(m.pricing?.prompt), o = Number(m.pricing?.completion);
      if (Number.isFinite(i) && Number.isFinite(o)) ids.set(m.id, { in: i, out: o });
    }
    prices = { at: Date.now(), ids };
  } catch { prices.at = Date.now() - PRICE_TTL + 5 * 60 * 1000; /* nouvel essai dans 5 min */ }
  return prices.ids;
}

export async function cfaRate() {
  if (Date.now() - rate.at < RATE_TTL) return rate.xof;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(10000) });
    const x = Number((await res.json()).rates?.XOF);
    rate = { at: Date.now(), xof: x > 0 ? x : rate.xof };
  } catch { rate.at = Date.now() - RATE_TTL + 30 * 60 * 1000; }
  return rate.xof;
}

/**
 * Jetons et coût d'une réponse.
 * @returns {{ input: number, output: number, usd: number|null, cfa: number|null }}
 */
export async function usageCost(entry, usage) {
  const input = Number(usage?.prompt_tokens) || 0;
  const output = Number(usage?.completion_tokens) || 0;
  let usd = Number.isFinite(Number(usage?.cost)) && usage?.cost !== null && usage?.cost !== undefined ? Number(usage.cost) : null;
  if (usd === null) {
    const ids = await loadPrices();
    const id = String(entry?.model ?? '');
    const p = ids.get(id) ?? ids.get(id.replace(/^models\//, '')) ?? [...ids].find(([k]) => k.endsWith('/' + id))?.[1];
    if (p) usd = input * p.in + output * p.out;
    else if (/:free$/.test(id)) usd = 0;
  }
  const cfa = usd === null ? null : usd * (await cfaRate());
  return { input, output, usd, cfa };
}
