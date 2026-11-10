# Exemples d'objectifs

Ce que l'agent sait faire, avec les prompts réels utilisés pour le vérifier.

Un objectif se donne en langage naturel. Plus il est détaillé, plus l'agent est
fiable sur les parcours longs — mais rien n'est codé en dur : les étapes ci-dessous
sont des **indications**, pas un script. L'agent lit la page à chaque tour et décide
lui-même de la suite ; si le site ne correspond pas à ce qui est décrit, il s'adapte.

---

## Formulaire long avec paiement — inscription Netflix

Le cas le plus exigeant : parcours multi-étapes, choix d'offre, création de compte,
saisie de carte, et une capture livrée à la fin.

> **Coût constaté : ~0,05 USD d'API DeepSeek** pour le parcours complet.

### Le prompt

```
OBJECTIF : Va sur Netflix Cameroun, prends le plan le moins cher, remplis TOUT le
formulaire d'inscription jusqu'au bout, y compris les données de paiement par carte,
et envoie-moi une capture d'écran à la fin. Lis toujours le contenu de la page pour
savoir où tu es et ce qu'il faut faire.

INSTRUCTIONS DÉTAILLÉES :

1. Navigue vers https://www.netflix.com/signup (page de base).

2. Clique sur « Suivant » pour passer l'étape de choix de l'offre.

3. Sélectionne le plan le moins cher. Clique ensuite sur « Suivant ».

4. Sur le formulaire de création de compte, remplis :
   - Adresse e-mail : une adresse valide et non déjà utilisée
     (ex. une adresse outlook/gmail plausible et libre).
   - Mot de passe : un mot de passe simple.
   - Coche la case « J'accepte » / consentement.
   - Clique sur « Suivant ».

5. Si Netflix demande une vérification par e-mail (lien de confirmation), clique sur
   « Modifier » pour revenir au formulaire, change l'adresse e-mail si nécessaire,
   puis renvoie le lien.

6. À l'étape de paiement, clique sur « Carte de crédit ou de débit » et remplis TOUS
   les champs :
   - Numéro de carte : 4242 4242 4242 4242
   - Date d'expiration : 12/28
   - Cryptogramme : 123
   - Nom figurant sur la carte : Jean Dupont
   - Coche la case « J'accepte ».

7. Ne clique PAS sur « Activer mon abonnement ».

8. Peu importe les erreurs rencontrées (e-mail déjà utilisé, reCAPTCHA, carte
   refusée) : lis toujours le contenu de la page pour savoir où tu es et ce qu'il
   faut faire, continue, et va le plus loin possible dans le processus.

9. À la fin, prends une capture d'écran de l'état final et envoie-la-moi.
```

### Ce que ce prompt exerce

| Point | Détail |
|---|---|
| **Lecture continue** | « lis toujours le contenu de la page » — l'agent se resitue à chaque tour au lieu de dérouler les étapes à l'aveugle |
| **Tolérance à l'échec** | l'étape 8 lui dit d'interpréter l'erreur et de poursuivre, au lieu de s'arrêter au premier blocage |
| **Arrêt volontaire** | l'étape 7 interdit la soumission finale : le formulaire est rempli, rien n'est validé |
| **Livraison** | l'étape 9 déclenche l'outil `screenshot`, dont l'image arrive dans la conversation |

L'étape 7 est ce qui fait de ce parcours un **test** : on va jusqu'au dernier écran
pour vérifier que l'agent sait remplir un tunnel de paiement, sans jamais créer
d'abonnement. `4242 4242 4242 4242` est le numéro de test public des passerelles de
paiement — il ne correspond à aucune carte réelle.

Pour tes propres essais, préfère des sites qui prévoient ce genre d'automatisation
(bacs à sable de démonstration, formulaires de test) : beaucoup de services
commerciaux interdisent les inscriptions automatisées dans leurs conditions
d'utilisation, et coupent l'accès aux comptes concernés.

---

## Compte existant — connexion et abonnement jusqu'au bout

Variante du parcours Netflix quand le compte existe déjà : l'agent part toujours de
la page d'inscription, se connecte si Netflix le renvoie vers la connexion, termine
le paiement et va jusqu'à l'accueil de Netflix. Une capture est envoyée à chaque étape.

**Attention : ce parcours valide un vrai abonnement payant avec une vraie carte.**
Les valeurs entre crochets se remplacent au moment de lancer la tâche, dans le champ
de la session. Ne jamais les écrire dans ce fichier ni dans un fichier du dépôt.

Cocher l'option « Capture à chaque étape » de la session avant de lancer.

> **Constaté le 10 novembre 2026** :
> 37 étapes en 3 min 10 s, 606 412 jetons envoyés et 6 894 reçus avec GLM 5.3 Flash
> via OpenRouter, soit 13,4 F CFA (0,023 USD), en passant par un proxy au Cameroun.
> Paiement validé à l'étape 20 ; les 17 étapes suivantes (profils, langues,
> application) ont pris 1 min 37 s.

### Le prompt

```
OBJECTIF : Sur Netflix, avec mon compte existant, va au bout de l'abonnement au plan
le moins cher jusqu'à arriver sur l'accueil de Netflix. Envoie-moi une capture
d'écran à chaque étape. Lis toujours le contenu de la page pour savoir où tu es et
ce qu'il faut faire.

IDENTIFIANTS :
- E-mail : [E-MAIL]
- Mot de passe : [MOT DE PASSE]

PAIEMENT :
- Numéro de carte : [NUMÉRO DE CARTE]
- Date d'expiration : [MM/AA]
- Cryptogramme : [CVC]
- Nom figurant sur la carte : [NOM SUR LA CARTE]

INSTRUCTIONS DÉTAILLÉES :

1. Navigue vers https://www.netflix.com/signup (page de base).

2. Clique sur « Suivant » pour passer l'étape de choix de l'offre.

3. Sélectionne le plan le moins cher. Clique ensuite sur « Suivant ».

4. Sur le formulaire de compte, remplis l'e-mail et le mot de passe ci-dessus,
   coche la case de consentement si elle est présente, et clique sur « Suivant ».

5. Si Netflix indique que le compte existe déjà ou te renvoie vers la page de
   connexion : connecte-toi avec ces mêmes identifiants. Une fois connecté, si tu
   n'es pas renvoyé vers le parcours d'abonnement, retourne sur
   https://www.netflix.com/signup et reprends là où tu en étais.

6. À l'étape de paiement, clique sur « Carte de crédit ou de débit » et remplis TOUS
   les champs avec les données de paiement ci-dessus, puis coche « J'accepte ».

7. Clique sur « Activer mon abonnement » (ou le bouton de validation équivalent).

8. Une fois le paiement validé, règle les écrans suivants avec ces valeurs :
   - Profils (« Who will be watching Netflix? ») : nom du profil principal
     [NOM DU PROFIL] (sinon garder celui proposé) ; autres profils : [NOMS, ou aucun].
   - Profils enfants : [oui / non].
   - Langues (« Which languages... ») : cocher [Français], en plus de celle déjà
     cochée.
   Sur les autres écrans (bienvenue, application mobile, proposition d'offre), clique
   directement sur « Next », « OK » ou « Not Now », jusqu'à arriver sur l'accueil
   de Netflix avec les films et séries.

9. Si une vérification est demandée (code par e-mail ou SMS, validation 3D Secure
   de la banque) : prends une capture avec l'outil screenshot, puis appelle done en
   me disant précisément ce qui est demandé. Je te répondrai avec le code dans la
   conversation : remplis-le alors dans le champ et continue le parcours.

10. Peu importe les erreurs rencontrées : lis toujours le contenu de la page pour
    savoir où tu es et ce qu'il faut faire, continue, et va le plus loin possible.

11. Dès que tu as cliqué sur « Activer mon abonnement », prends une capture avec
    l'outil screenshot à chaque nouvelle étape, avec dossier = "netflix/tache-1"
    et un label qui nomme l'étape (ex. "paiement-valide", "profils", "accueil").
    La dernière capture est celle de l'accueil de Netflix.
```

Après un done pour un code, il suffit d'envoyer le code dans la même session : la
conversation et le navigateur restent là où l'agent s'est arrêté. Pour une nouvelle
tâche, changer le numéro du dossier (`netflix/tache-2`...).

---

## Écrire un bon objectif

Ce qui marche, d'après les essais :

- **Dire le but, pas seulement les gestes.** L'agent rattrape une étape décalée s'il
  sait où il va ; il se perd s'il n'a qu'une liste de clics.
- **Nommer les libellés visibles** (« Suivant », « Carte de crédit ou de débit »)
  plutôt que des positions à l'écran.
- **Dire quoi faire en cas d'erreur** — sans quoi l'agent s'arrête et rend la main.
- **Poser les limites explicitement** : ce qu'il ne doit surtout pas cliquer.
- **Demander la capture** si tu veux une preuve visuelle : sans consigne, il te répond
  en texte.

Les tâches courtes n'ont besoin de rien de tout ça :

```
Va sur news.ycombinator.com et donne-moi les 10 premiers titres avec leur URL.
```
