import { BrowserHost, renderSnapshot } from './browser.js';
import { TOOL_SCHEMAS, runTool } from './tools.js';
import { chat, modelName, visionAvailable } from './llm.js';
import { usageCost } from './cost.js';

const SYSTEM = `Tu es Rauvalia, un agent qui pilote un vrai navigateur web pour accomplir un objectif.

Tu reçois après chaque action l'état complet de la page : URL, titre, liste des éléments
interactifs numérotés [n], le texte de la page, les messages console et les erreurs réseau.
Tu es seul à décider : aucune logique n'est codée en dur pour toi.

Règles :
- Au tout début aucune page n'est chargée. Ta première action est alors navigate.
- Agis sur les éléments par leur ref [n] du DERNIER snapshot. Les refs changent à chaque snapshot :
  ne réutilise jamais un ref d'un snapshot précédent.
- Si la page semble vide, incomplète ou en cours de chargement, c'est à toi de décider :
  attendre (wait), scroller, recharger (navigate sur la même URL), ou conclure.
- Si une erreur console/réseau apparaît, interprète-la toi-même et adapte ta stratégie.
- Pour un formulaire : remplis tous les champs requis avant de soumettre, puis vérifie sur le
  snapshot suivant que la soumission a réussi (message de confirmation, changement d'URL).
- Pour du scraping : eval_js est souvent plus fiable et plus complet que lire le texte.
- Ne devine pas de données personnelles : n'utilise que celles fournies dans l'objectif.
- Persévérance : une erreur n'est jamais une raison de t'arrêter. Après un échec, essaie une autre
  méthode (autre élément, libellé, clavier, scroll, attente, eval_js). Ne déclare l'objectif
  impossible qu'après au moins 3 méthodes vraiment différentes sur le même blocage, et dis
  précisément lesquelles dans done.
- Ne devine pas d'URL internes d'un parcours (inscription, paiement…) : y aller directement fait
  souvent perdre la progression et renvoie à l'accueil. Avance avec les boutons de la page. Si tu
  es renvoyé en arrière, reprends le parcours depuis là où tu es.
- Si l'état du navigateur signale une erreur de lecture (page figée ou en chargement), ne recharge
  pas d'office : regarde d'abord la capture jointe si tu en as une ; si la page est bien là, continue,
  sinon attends quelques secondes (wait), et ne recharge qu'en dernier recours (tu perdrais la saisie).
- Si une action a réussi mais que la page ne change pas, vérifie d'abord ce qu'elle demande
  (champ obligatoire vide, choix à faire, message d'erreur, case à cocher) avant de recommencer.
- Quand l'objectif est atteint, ou impossible après ces essais, appelle done avec le résultat.
  N'appelle done qu'à ce moment-là : ne t'arrête pas en cours de route pour rendre compte.
- N'appelle qu'un seul outil à la fois.
- Quand une action échoue, une capture de la page entière peut t'être jointe (si tu lis les images).
  Regarde-la pour comprendre la cause (fenêtre qui recouvre, élément dessiné autrement, message
  d'erreur affiché, page différente de ce que tu crois) et change de méthode au lieu de répéter
  la même action : autre élément, libellé associé, touche clavier, eval_js, scroll.

La conversation continue après chaque done : l'utilisateur peut enchaîner sur une nouvelle
demande, et le navigateur reste sur la page où tu l'as laissé. Tiens compte de l'historique.`;

export class Cancelled extends Error {
  constructor() { super('Tâche annulée.'); this.name = 'Cancelled'; }
}

/**
 * Une conversation attachée à un onglet. Le navigateur reste ouvert entre
 * deux objectifs et l'historique est conservé.
 */
export class Session {
  constructor({ tab, maxSteps = 40 } = {}) {
    this.tab = tab;
    this.model = null; // { provider, model } choisi pour cette session, sinon la chaîne par défaut
    this.shotEveryStep = false; // true : capture de la page envoyée au modèle à chaque étape
    this.saveEveryStep = false; // true (avec shotEveryStep) : ces captures sont aussi rangées dans le panneau Captures
    this.maxSteps = maxSteps;
    this.messages = [{ role: 'system', content: SYSTEM }];
    this.busy = false;
    this.ac = null;
  }

  get page() { return this.tab?.page; }

  /** Vide la conversation sans toucher au navigateur. */
  clear() {
    this.messages = [{ role: 'system', content: SYSTEM }];
  }

  /** Coupe la tâche en cours. Retourne false s'il n'y avait rien à couper. */
  cancel() {
    if (!this.busy) return false;
    this.cancelled = true;
    this.ac?.abort();
    return true;
  }

  #check() { if (this.cancelled) throw new Cancelled(); }

  async run(objective, { onEvent = () => {}, maxSteps = this.maxSteps } = {}) {
    if (this.busy) throw new Error('Une tâche est déjà en cours sur cette session.');
    this.busy = true;
    this.cancelled = false;
    this.ac = new AbortController();
    // Total des jetons et du coût de cette demande.
    const total = { input: 0, output: 0, usd: 0, cfa: 0, unknown: false, bytes: 0 };
    // Données consommées par les pages depuis la dernière mesure.
    let mark = this.tab.bytes ?? 0;
    const measure = (step) => {
      const now = this.tab.bytes ?? 0, d = Math.max(0, now - mark);
      mark = now; total.bytes += d;
      onEvent({ type: 'data', step, bytes: d, total: total.bytes });
    };
    const withTotal = (res) => ({ ...res, usage: { ...total } });

    try {
      this.messages.push({ role: 'user', content: `OBJECTIF:\n${objective}` });
      this.messages.push({
        role: 'user',
        content: `ÉTAT DU NAVIGATEUR:\n${renderSnapshot(await this.tab.snapshot())}`
      });

      for (let step = 1; step <= maxSteps; step++) {
        this.#check();
        const msg = await chat({ messages: this.messages, tools: TOOL_SCHEMAS, signal: this.ac.signal, prefer: this.model });
        this.#check();
        this.messages.push(msg);
        if (msg.usedModel) {
          const u = msg.usedModel;
          this.usingModel = modelName(u);
          onEvent({ type: 'model', step, provider: u.provider, model: u.model, text: modelName(u) });
          const c = await usageCost(u, msg.usage).catch(() => null);
          if (c) {
            total.input += c.input; total.output += c.output;
            if (c.usd === null) total.unknown = true; else { total.usd += c.usd; total.cfa += c.cfa; }
            onEvent({ type: 'usage', step, ...c });
          }
          if (msg.imageDropped) onEvent({ type: 'shot', step, ok: false, text: 'Capture non lue : aucun modèle lisant les images n’a répondu, un modèle texte seul a pris le relais.' });
        }

        // reasoning_content : chaîne de pensée des modèles « reasoner ».
        if (msg.reasoning_content) onEvent({ type: 'thought', step, text: msg.reasoning_content });
        if (msg.content) onEvent({ type: 'thought', step, text: msg.content });

        const calls = msg.tool_calls || [];
        if (!calls.length) {
          this.messages.push({
            role: 'user',
            content: `Aucun outil appelé. Appelle un outil, ou done si c'est terminé.\n\nÉTAT DU NAVIGATEUR:\n${renderSnapshot(await this.tab.snapshot())}`
          });
          continue;
        }

        let failed = null, wantShot = false;
        for (const call of calls) {
          this.#check();
          let args = {};
          try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* arguments illisibles */ }
          const name = call.function.name;
          const { raison, etape, ...params } = args;
          if (etape) onEvent({ type: 'title', step, text: String(etape).slice(0, 80) });
          if (raison) onEvent({ type: 'thought', step, text: raison });
          onEvent({ type: 'action', step, name, args: params });

          if (name === 'done') {
            measure(step);
            const res = withTotal({ success: !!params.success, result: params.result ?? '', steps: step });
            this.messages.push({ role: 'tool', tool_call_id: call.id, content: 'Tâche terminée.' });
            onEvent({ type: 'done', step, ...res });
            return res;
          }

          let output, artifact;
          try {
            const r = await runTool(this.tab, name, params);
            // Certains outils produisent un livrable (capture d'écran…) en plus de leur sortie texte.
            if (r && typeof r === 'object') { output = r.output; artifact = r.artifact; } else output = r;
            if (r?.seen) wantShot = true;
          } catch (e) { output = `ERREUR: ${String(e.message).slice(0, 600)}`; }
          if (String(output).startsWith('ERREUR')) failed = name;

          if (artifact) onEvent({ type: 'artifact', step, ...artifact });
          onEvent({ type: 'result', step, name, output: String(output).slice(0, 400) });
          this.messages.push({ role: 'tool', tool_call_id: call.id, content: String(output) });
        }

        this.#check();
        const snap = await this.tab.snapshot();
        measure(step);
        const state = `ÉTAT DU NAVIGATEUR:\n${renderSnapshot(snap)}`;
        // Lecture de la page impossible (page figée, en plein chargement) : la capture montre où elle en est.
        if (snap.error && !failed) failed = 'lecture de la page';
        // Capture de la page : après un échec, sur demande (outil screenshot) ou à chaque étape si l'option est active.
        let shot = null;
        // Inutile de capturer si le modèle prévu ne lit pas les images.
        const needShot = failed || wantShot || this.shotEveryStep;
        if (needShot && await visionAvailable(this.model).catch(() => false)) {
          shot = await this.tab.pageShotForModel().catch((e) => {
            onEvent({ type: 'shot', step, ok: false, text: `Capture impossible : ${String(e.message).slice(0, 160)}` });
            return null;
          });
        }
        stripOldImages(this.messages);
        if (shot) {
          const area = shot.full ? 'la page entière' : 'la zone visible (page entière impossible)';
          const why = failed === 'lecture de la page'
            ? `La lecture de la page n'a pas abouti. Voici ${area} telle qu'elle est affichée : regarde-la avant de décider d'attendre ou de recharger.`
            : failed ? `L'action ${failed} a échoué. Voici ${area} telle qu'elle est affichée.`
            : `Capture de ${area} telle qu'elle est affichée.`;
          this.messages.push({ role: 'user', content: [
            { type: 'text', text: state },
            { type: 'text', text: why },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${shot.b64}` } }
          ] });
          // keep : option « Enregistrer chaque étape » (dépend de « Capture à chaque étape ») : rangée dans le panneau Captures.
          onEvent({ type: 'shot', step, ok: true, url: shot.url, keep: this.shotEveryStep && this.saveEveryStep,
            text: `${failed ? `Après l'échec de ${failed} : capture` : 'Capture'} de ${area} envoyée au modèle (${shot.kb} Ko)` });
        } else {
          this.messages.push({ role: 'user', content: state });
        }
        trimHistory(this.messages);
      }

      const res = withTotal({ success: false, result: `Limite de ${maxSteps} étapes atteinte.`, steps: maxSteps });
      onEvent({ type: 'done', ...res });
      return res;
    } catch (e) {
      if (this.cancelled || e.name === 'Cancelled' || e.name === 'AbortError') {
        // L'historique reste cohérent : on note l'interruption pour la suite.
        this.messages.push({ role: 'user', content: '(tâche interrompue par l’utilisateur)' });
        const res = withTotal({ success: false, result: 'Tâche coupée.', cancelled: true });
        onEvent({ type: 'done', ...res });
        return res;
      }
      throw e;
    } finally {
      this.busy = false;
      this.cancelled = false;
      this.ac = null;
    }
  }
}

/** Run one-shot : ouvre un navigateur, exécute l'objectif, ferme. */
export async function runAgent({ objective, maxSteps = 40, headless = false, engine, onEvent } = {}) {
  const host = await new BrowserHost({ engine, headless }).start();
  try {
    const s = new Session({ tab: await host.newTab(), maxSteps });
    return await s.run(objective, { onEvent, maxSteps });
  } finally {
    await host.close();
  }
}

/** Une seule image à la fois dans l'historique : les anciennes captures redeviennent du texte. */
function stripOldImages(messages) {
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      m.content = m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') + '\n(capture retirée)';
    }
  }
}

/** Remplace le contenu des anciens états de page par un marqueur, pour ne pas exploser le contexte. */
function trimHistory(messages, keep = 3) {
  const idx = [];
  messages.forEach((m, i) => {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('ÉTAT DU NAVIGATEUR:')) idx.push(i);
  });
  for (const i of idx.slice(0, -keep)) {
    const url = messages[i].content.match(/URL: (.*)/)?.[1] ?? '';
    messages[i].content = `ÉTAT DU NAVIGATEUR: (ancien snapshot élidé — ${url})`;
  }
}
