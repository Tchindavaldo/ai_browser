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
