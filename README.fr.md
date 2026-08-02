# mjloop

> Des cycles de développement vérifiés pour Claude Code.

[![Plugin Claude Code](https://img.shields.io/badge/Claude_Code-plugin-6B5CE7?style=flat-square)](https://docs.anthropic.com/en/docs/claude-code)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[English](README.md) · [العربية](README.ar.md) · [简体中文](README.zh-CN.md) · [Español](README.es.md) · [Português (Brasil)](README.pt-BR.md) · **Français** · [Deutsch](README.de.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md)

**Demandez aux agents de programmation de prouver qu'ils ont terminé.**

`mjloop` est un plugin Claude Code qui transforme le travail des agents en cycles limités
et étayés par des preuves. Un responsable choisit les agents adaptés, les exécute dans des
contextes isolés et n'accepte la réussite qu'après l'enregistrement, par le moteur, du
résultat des commandes de vérification propres au projet.

`demande → piste → agents isolés → vérification du moteur → résultat prouvé`

> [!IMPORTANT]
> `mjloop` prend actuellement en charge Claude Code. Les adaptateurs pour les autres
> agents de programmation ne font pas encore partie du plugin publié.

## Pourquoi mjloop ?

- **Des preuves, pas de la confiance** — une déclaration de réussite ne peut pas remplacer
  un reçu du moteur absent ou en échec.
- **Un état que les agents ne réécrivent pas** — le serveur MCP possède l'état d'exécution
  et les manifestes dérivés.
- **Une autonomie limitée** — les limites de cycles et les protections contre la
  stagnation et les erreurs répétées arrêtent un travail qui ne progresse plus.
- **Un flux pour chaque tâche** — modification courte, construction en plusieurs cycles,
  correction après reproduction ou planification relue.

## Démarrage rapide

Vous avez besoin de Claude Code, de Node.js 20 ou plus récent et de Git.

```bash
git clone https://github.com/MohdAljahdali/mjloop.git
cd mjloop/engine
npm install
npm run build
cd ..
claude plugin marketplace add "$PWD"
claude plugin install mjloop@mjloop
```

Ouvrez ensuite Claude Code dans un projet et exécutez :

```text
/mjloop:init
/mjloop:edit ajoute la validation des entrées au formulaire d'inscription
```

> [!NOTE]
> Un nouveau clone doit être compilé une fois, car le serveur MCP et la CLI des hooks
> s'exécutent depuis `engine/dist/`. Consultez le [guide d'installation complet](docs/install.md).

## Choisissez la bonne piste

| Commande | Idéale pour | Règle intégrée |
|---|---|---|
| `/mjloop:edit <demande>` | Les changements petits et ciblés | Un cycle ; escalade si le périmètre grandit |
| `/mjloop:build <objectif>` | Les fonctionnalités et grandes implémentations | Répète des cycles vérifiés jusqu'à la fin ou l'arrêt |
| `/mjloop:fix <problème>` | Les défauts et régressions | Reproduit l'échec avant d'accepter la correction |
| `/mjloop:plan <idée>` | Transformer une idée en récits réalisables | Vérifie l'adéquation et demande une approbation avant les récits |

Utilisez `/mjloop:status` pour inspecter l'exécution, `/mjloop:resume` pour la reprendre,
`/mjloop:stop` pour l'arrêter et `/mjloop:web` pour ouvrir le cockpit dans le navigateur.

## Que se passe-t-il pendant un cycle ?

1. Le responsable compose une équipe depuis la piste et justifie l'ajout ou l'omission de chaque spécialiste.
2. Des agents liés par contrat travaillent dans des contextes isolés avec des responsabilités ciblées.
3. Le moteur lance les commandes figées au démarrage et conserve le journal complet hors du récit de l'agent.
4. Un échec alimente le cycle suivant ; un reçu valide peut fermer l'exécution.
5. Les protections arrêtent les cycles qui atteignent leur limite, stagnent ou répètent le même échec.

## Plus que de l'exécution

- **Découverte de fonctionnalité** — la compétence `mjloop-feature-discovery` pose une
  décision à la fois et s'arrête sur un brief qu'une personne peut approuver.
- **Routage conscient du projet** — les cartes de composants et compétences acceptées
  guident les rôles fixes sans modifier une exécution en cours.
- **Cockpit web** — consultez exécutions, plans, récits, preuves, configuration et mémoire
  avec `/mjloop:web`.
- **Pistes extensibles** — ajoutez un agent, une compétence ou une piste avec `/mjloop:add`.

> [!TIP]
> Commencez par `/mjloop:edit` sur un changement réel et limité. C'est le moyen le plus
> rapide de voir le contrat de vérification sans payer plusieurs cycles.

## Pour aller plus loin

- [Pourquoi mjloop existe](docs/about.md)
- [Installation et dépannage](docs/install.md)
- [Commandes, configuration et flux](docs/usage.md)
- [Documentation en arabe](docs/about.ar.md)

Si `mjloop` résout un problème qui vous est familier, ajoutez une étoile au dépôt pour
aider d'autres développeurs à le découvrir.
