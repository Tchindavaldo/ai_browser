/**
 * Objectifs des tâches Qezaly, écrits pour l'agent. Ce sont des indications, pas un script :
 * l'agent lit la page à chaque tour et s'adapte (voir EXEMPLES.md).
 *
 * Les données sensibles n'apparaissent jamais en clair : l'objectif contient des repères
 * {{nom}}, remplacés au moment de la saisie (Session.secrets).
 */

export const SERVICES = ['netflix', 'spotify'];

/** Repères -> valeurs réelles. Seul ce qui est secret passe par ici. */
export function secretsOf(task) {
  return {
    compte_mdp: task.account.password,
    carte_numero: String(task.card.number).replace(/\s+/g, ''),
    carte_expiration: task.card.expiry,
    carte_cvc: task.card.cvc,
    carte_titulaire: task.card.holder
  };
}

const COMMON_END = (task) => `
CODES ET MAILS :
- Si une page demande un code ou un lien reçu par e-mail : appelle l'outil lire_mail
  (attente 90 s), puis saisis le code ou ouvre le lien qu'il te donne. Si rien n'arrive,
  rappelle lire_mail une deuxième fois avant de conclure.
- Les mails arrivent sur ${task.account.email}. N'ouvre aucune boîte mail toi-même.

RÈGLES :
- Les repères entre doubles accolades ({{compte_mdp}}, {{carte_numero}}...) se saisissent
  tels quels avec l'outil type : la vraie valeur est mise au moment de la saisie.
  Ne les modifie pas et ne les découpe pas.
- Peu importe les erreurs rencontrées : lis toujours le contenu de la page pour savoir où
  tu es et ce qu'il faut faire, continue, et va le plus loin possible.
- Si la carte est refusée, ou si une validation bancaire (3D Secure) ou un SMS est demandé,
  ne réessaie pas plus de deux fois : prends une capture (screenshot, dossier
  "qezaly/${task.taskId}") puis appelle done avec success=false et la raison exacte.

FIN :
- Quand l'abonnement est actif, prends une capture (screenshot, label "fin", dossier
  "qezaly/${task.taskId}") puis appelle done avec success=true et, dans result :
  l'offre activée, le prix affiché et la date du prochain paiement si elle est visible.
- Si c'est impossible, appelle done avec success=false et la raison précise
  (étape bloquante, message affiché, méthodes essayées).`;

function netflix(task) {
  const p = task.profile ?? {};
  const name = p.name || task.customer?.firstName || 'garder celui proposé';
  const langs = (p.languages?.length ? p.languages : ['Français']).join(', ');
  return `OBJECTIF : Sur Netflix (pays ${task.country || 'CM'}), crée le compte ci-dessous et
va au bout de l'abonnement à l'offre « ${task.plan.label} » jusqu'à arriver sur l'accueil
de Netflix. Lis toujours le contenu de la page pour savoir où tu es et ce qu'il faut faire.

IDENTIFIANTS :
- E-mail : ${task.account.email}
- Mot de passe : {{compte_mdp}}

PAIEMENT :
- Numéro de carte : {{carte_numero}}
- Date d'expiration : {{carte_expiration}}
- Cryptogramme : {{carte_cvc}}
- Nom figurant sur la carte : {{carte_titulaire}}

INSTRUCTIONS DÉTAILLÉES :
1. Navigue vers https://www.netflix.com/signup.
2. Choisis l'offre « ${task.plan.label} » (code ${task.plan.code}) et clique sur « Suivant ».
3. Remplis l'e-mail et le mot de passe ci-dessus, coche la case de consentement si elle
   est présente, et clique sur « Suivant ».
4. Si Netflix indique que le compte existe déjà ou te renvoie vers la connexion :
   connecte-toi avec ces mêmes identifiants, puis reprends le parcours d'abonnement.
5. À l'étape de paiement, choisis « Carte de crédit ou de débit », remplis TOUS les
   champs, coche « J'accepte », puis clique sur « Activer mon abonnement ».
6. Après le paiement : profil principal ${name} ; profils enfants : ${p.kids ? 'oui' : 'non'} ;
   langues : cocher ${langs}. Sur les autres écrans (bienvenue, application, offres),
   clique sur « Suivant », « OK » ou « Plus tard » jusqu'à l'accueil avec les films et séries.
${COMMON_END(task)}`;
}

function spotify(task) {
  const c = task.customer ?? {};
  const birth = c.birthDate || process.env.QEZALY_DEFAULT_BIRTHDATE || '1995-01-15';
  return `OBJECTIF : Sur Spotify (pays ${task.country || 'CM'}), crée le compte ci-dessous et
souscris l'offre Premium « ${task.plan.label} » jusqu'à la confirmation que Premium est actif.
Lis toujours le contenu de la page pour savoir où tu es et ce qu'il faut faire.

IDENTIFIANTS :
- E-mail : ${task.account.email}
- Mot de passe : {{compte_mdp}}
- Nom affiché : ${[c.firstName, c.lastName].filter(Boolean).join(' ') || 'garder celui proposé'}
- Date de naissance : ${birth} (AAAA-MM-JJ)

PAIEMENT :
- Numéro de carte : {{carte_numero}}
- Date d'expiration : {{carte_expiration}}
- Cryptogramme : {{carte_cvc}}
- Nom figurant sur la carte : {{carte_titulaire}}

INSTRUCTIONS DÉTAILLÉES :
1. Navigue vers https://www.spotify.com/premium/.
2. Choisis l'offre « ${task.plan.label} » (code ${task.plan.code}) et clique sur son bouton.
3. Si Spotify demande de se connecter ou de s'inscrire : choisis l'inscription par e-mail
   avec les identifiants ci-dessus (date de naissance, genre « Je préfère ne pas le dire »
   s'il est demandé). Refuse les e-mails marketing. Si le compte existe déjà, connecte-toi.
4. À l'étape de paiement, choisis la carte de crédit ou de débit, remplis TOUS les champs
   et valide l'achat.
5. Si un écran propose de télécharger l'application ou d'inviter des membres, passe-le.
${COMMON_END(task)}`;
}

export function objectiveOf(task) {
  return task.service === 'spotify' ? spotify(task) : netflix(task);
}

/** Vérifie une tâche reçue du back-end. Renvoie la liste des erreurs (vide si tout va bien). */
export function validateTask(t) {
  const errs = [];
  if (!t || typeof t !== 'object') return ['tâche illisible'];
  if (!t.taskId) errs.push('taskId manquant');
  if (!SERVICES.includes(t.service)) errs.push(`service inconnu (${SERVICES.join(' | ')})`);
  if (!t.plan?.label) errs.push('plan.label manquant');
  if (!t.account?.email || !t.account?.password) errs.push('account.email et account.password requis');
  if (!t.card?.number || !t.card?.expiry || !t.card?.cvc || !t.card?.holder) errs.push('card.number, expiry, cvc et holder requis');
  return errs;
}
