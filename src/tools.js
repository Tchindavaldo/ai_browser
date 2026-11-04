/**
 * Outils exposés à l'IA. Aucun de ces outils ne décide quoi que ce soit :
 * ils exécutent et renvoient le résultat brut (succès ou message d'erreur).
 */

/**
 * `raison` est ajoutée et rendue obligatoire sur chaque outil : le modèle doit
 * verbaliser sa décision à chaque action, ce qui alimente le panneau « Réflexions ».
 */
const t = (name, description, properties, required = []) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        raison: { type: 'string', description: 'En une phrase : pourquoi cette action maintenant.' },
        etape: { type: 'string', description: "Titre court (2 à 6 mots) de l'étape du parcours où tu te trouves, d'après la page actuelle. Ex. : Choix de l'offre, Création du compte, Paiement par carte." },
        ...properties
      },
      required: ['raison', 'etape', ...required]
    }
  }
});

export const TOOL_SCHEMAS = [
  t('navigate', "Charge une URL dans l'onglet actif.", {
    url: { type: 'string', description: 'URL complète, ex. https://example.com' }
  }, ['url']),

  t('click', 'Clique sur un élément identifié par son ref du dernier snapshot.', {
    ref: { type: 'integer', description: 'Numéro [n] de l’élément' }
  }, ['ref']),

  t('type', 'Saisit du texte dans un champ (vide le champ avant).', {
    ref: { type: 'integer' },
    text: { type: 'string' },
    submit: { type: 'boolean', description: 'Appuyer sur Entrée après la saisie' }
  }, ['ref', 'text']),

  t('select', 'Choisit une option dans un <select>.', {
    ref: { type: 'integer' },
    value: { type: 'string', description: 'Valeur ou libellé de l’option' }
  }, ['ref', 'value']),

  t('check', 'Coche ou décoche une case / un bouton radio.', {
    ref: { type: 'integer' },
    checked: { type: 'boolean' }
  }, ['ref', 'checked']),

  t('press_key', 'Appuie sur une touche (Enter, Escape, Tab, PageDown…).', {
    key: { type: 'string' }
  }, ['key']),

  t('scroll', 'Fait défiler la page.', {
    direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
    amount: { type: 'integer', description: 'Pixels (défaut 600)' }
  }, ['direction']),

  t('wait', 'Attend un nombre de secondes (max 30).', {
    seconds: { type: 'number' }
  }, ['seconds']),

  t('go_back', 'Revient à la page précédente.', {}),

  t('read_page', 'Relit la page en entier (texte long, au-delà du snapshot tronqué).', {
    max_chars: { type: 'integer', description: 'Défaut 20000' }
  }),

  t('eval_js', "Exécute du JavaScript dans la page et renvoie le résultat JSON. Utile pour extraire des données structurées.", {
    code: { type: 'string', description: 'Corps de fonction, ex. "return [...document.querySelectorAll(\'h2\')].map(e=>e.innerText)"' }
  }, ['code']),

  t('screenshot', "Prend une capture d'écran de la page et la livre à l'utilisateur (affichée dans la conversation, téléchargeable).", {
    full_page: { type: 'boolean', description: 'Capturer la page entière au lieu de la partie visible' },
    label: { type: 'string', description: 'Nom court pour le fichier, ex. "panier" ou "confirmation"' }
  }),

  t('done', "Termine la tâche. À appeler quand l'objectif est atteint OU définitivement impossible.", {
    success: { type: 'boolean' },
    result: { type: 'string', description: 'Résultat demandé (données scrapées, confirmation) ou raison de l’échec' }
  }, ['success', 'result'])
];

/**
 * Essaie chaque méthode dans l'ordre et renvoie le nom de celle qui a marché.
 * Si toutes échouent, l'erreur rapporte chaque tentative (le modèle sait ce qui a été essayé).
 */
async function tryInOrder(methods) {
  const errs = [];
  for (const [name, fn] of methods) {
    try { await fn(); return name; } catch (e) { errs.push(`${name} : ${String(e.message).split('\n')[0]}`); }
  }
  throw new Error(`toutes les méthodes ont échoué. ${errs.join(' | ')}`);
}

export async function runTool(tab, name, args) {
  const page = tab.page;
  const browser = tab;
  switch (name) {
    case 'navigate':
      await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      return `Navigué vers ${page.url()}`;

    case 'click': {
      const l = await browser.locate(args.ref);
      await l.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      // Clic normal, sinon forcé (élément recouvert ou jugé « non cliquable »), sinon par le JavaScript de la page.
      const how = await tryInOrder([
        ['normal', () => l.click({ timeout: 4000 })],
        ['JavaScript', () => l.evaluate((el) => el.click(), null, { timeout: 2000 })],
        ['forcé', () => l.click({ timeout: 2000, force: true })]
      ]);
      await page.waitForTimeout(500);
      return `Clic sur [${args.ref}] effectué${how === 'normal' ? '' : ` (clic ${how}, le clic normal avait échoué)`}. URL: ${page.url()}`;
    }

    case 'type': {
      const l = await browser.locate(args.ref);
      await l.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      // Saisie directe, sinon clic dans le champ puis frappe au clavier (champs masqués ou habillés).
      const how = await tryInOrder([
        ['normal', async () => { await l.fill('', { timeout: 4000 }).catch(() => {}); await l.fill(args.text, { timeout: 4000 }); }],
        ['clavier', async () => {
          await l.click({ timeout: 2000, force: true }).catch(() => l.evaluate((el) => el.focus(), null, { timeout: 2000 }));
          await page.keyboard.press('ControlOrMeta+A');
          await page.keyboard.press('Backspace');
          await page.keyboard.type(args.text, { delay: 30 });
        }]
      ]);
      if (args.submit) { await page.keyboard.press('Enter'); await page.waitForTimeout(800); }
      return `Saisi ${JSON.stringify(args.text)} dans [${args.ref}]${how === 'normal' ? '' : ' (au clavier, la saisie directe avait échoué)'}${args.submit ? ' + Entrée' : ''}`;
    }

    case 'select':
      await (await browser.locate(args.ref)).selectOption({ label: args.value }, { timeout: 4000 }).catch(async () => {
        await (await browser.locate(args.ref)).selectOption(args.value, { timeout: 4000 });
      });
      return `Option ${JSON.stringify(args.value)} sélectionnée dans [${args.ref}]`;

    case 'check': {
      const l = await browser.locate(args.ref);
      // Case normale, sinon forcée (case cachée sous un dessin), sinon clic sur son libellé.
      const how = await tryInOrder([
        ['normal', () => l.setChecked(args.checked, { timeout: 4000 })],
        ['forcé', () => l.setChecked(args.checked, { timeout: 2000, force: true })],
        ['libellé', () => l.evaluate((el, want) => {
          if (el.checked === want) return;
          const lab = el.labels?.[0] ?? el.closest('label');
          (lab ?? el).click();
          if (el.checked !== undefined && el.checked !== want) throw new Error('état inchangé');
        }, args.checked, { timeout: 2000 })]
      ]);
      return `[${args.ref}] ${args.checked ? 'coché' : 'décoché'}${how === 'normal' ? '' : ` (méthode : ${how})`}`;
    }

    case 'press_key':
      await page.keyboard.press(args.key);
      await page.waitForTimeout(300);
      return `Touche ${args.key} pressée`;

    case 'scroll': {
      const px = args.amount ?? 600;
      const js = {
        down: `window.scrollBy(0, ${px})`,
        up: `window.scrollBy(0, -${px})`,
        top: 'window.scrollTo(0, 0)',
        bottom: 'window.scrollTo(0, document.body.scrollHeight)'
      }[args.direction];
      await page.evaluate(js);
      await page.waitForTimeout(400);
      return `Scroll ${args.direction}`;
    }

    case 'wait':
      await page.waitForTimeout(Math.min(args.seconds, 30) * 1000);
      return `Attendu ${args.seconds}s`;

    case 'go_back':
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
      return `Retour arrière. URL: ${page.url()}`;

    case 'read_page': {
      const txt = await page.evaluate(() => document.body?.innerText || '');
      return txt.slice(0, args.max_chars ?? 20000);
    }

    case 'screenshot': {
      const cap = await tab.saveCapture({ fullPage: !!args.full_page, label: args.label });
      return {
        seen: true,
        output: `Capture enregistrée et envoyée à l'utilisateur (tu la verras aussi si ton modèle lit les images) : ${cap.name} (${Math.round(cap.bytes / 1024)} Ko, ${cap.fullPage ? 'page entière' : 'zone visible'}) — ${cap.pageUrl}`,
        artifact: { kind: 'image', ...cap }
      };
    }

    case 'eval_js': {
      let timer;
      const r = await Promise.race([
        page.evaluate(new Function(args.code)).finally(() => clearTimeout(timer)),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('le script ne rend pas la main après 30 s')), 30000); })
      ]);
      // Un script sans « return » renvoie undefined : ce n'est pas une erreur.
      return r === undefined ? 'Script exécuté (aucune valeur renvoyée).' : String(JSON.stringify(r, null, 2)).slice(0, 20000);
    }

    default:
      return `Outil inconnu: ${name}`;
  }
}
