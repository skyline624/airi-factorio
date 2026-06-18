# FLE — Analyse d'architecture & plan de reproduction dans airi-factorio

> Rédigé 2026-06-18 après dissection du code source de FLE (`D:\developpement\factorio-learning-environment`)
> et de l'existant airi-factorio (`packages/agent/src/learning/*`, `packages/autorio/src/*`).
> Contexte : le benchmark FLE a montré **glm-5.2 = 1.0 (quota atteint)** vs gemma4 0.5 / kimi 0.375 — donc nos
> échecs glm-5.2 dans airi-factorio venaient du **harnais**, pas du modèle. Ce doc dit *quoi* du harnais FLE
> fait la différence et *comment* le porter chez nous. Voir mémoire `airi-factorio-fle-benchmark`.

## TL;DR

airi-factorio est **déjà ~70 % FLE** (il en est clairement inspiré : surface `ops` fermée, primitives de
placement déterministes, vérification 2 niveaux, sandbox). La reproduction n'est **pas** une réécriture mais
un **comblement de 4-5 écarts précis** :

1. **P0 — Personnage auto-créé en RCON** (headless, plus de `waitForPlayer`) → débloque le benchmark automatisé façon FLE.
2. **P0 — Retours d'entités typés et riches** (recette/inventaire/statut/points de connexion par machine) → ce qui permet à l'exécuteur de *chaîner* les opérations.
3. **P1 — Compléter les primitives jusqu'à la fusée** (fluides/pétrole, chaînes d'assemblage, science/labos, rocket-silo, launch_rocket).
4. **P1 — `connect` enrichi** (résolveurs fluide/power/transport, retour d'objets « groupe »).
5. **P2 — Capture de sortie ligne-à-ligne** dans le sandbox + (option) injection Lua à chaud pour ajouter des outils sans rebuild du mod.

Et surtout : **on garde nos avantages sur FLE** (skill-library Voyager, précheck déterministe + critic, primitives haut-niveau opinionées).

---

## 1. Architecture FLE — les 5 piliers

### Pilier 1 — Surface d'outils typés, une convention « 1 dossier = 1 primitive »
`fle/env/tools/{agent,admin}/<tool>/` contient **`client.py`** (callable Python typé) + **`server.lua`** (code in-game) + **`agent.md`** (doc/exemples). ~29 outils *agent* (`place_entity`, `connect_entities`, `nearest`, `nearest_buildable`, `move_to`, `insert_item`, `craft_item`, `harvest_resource`, `get_entities`, `set_entity_recipe`, `rotate_entity`, `launch_rocket`…) + ~24 outils *admin* cachés derrière `_` (`request_path`/`get_path`, `reset`, `render`…). Découverte **par convention de fichiers** : `LuaScriptManager.setup_tools` (`fle/env/lua_manager.py:180-282`) walk le dossier, importe chaque `client.py`, `setattr(namespace, tool, wrapped)` (agent) ou `_tool` (admin). Ajouter une primitive = ajouter un dossier, zéro câblage.

### Pilier 2 — Système de types riche (le retour d'info qui fait chaîner l'agent)
- `Prototype` (`fle/env/game_types.py:83-302`) : enum dont chaque valeur est un **tuple `(nom_factorio, ClasseEntité)`** — déballé par chaque outil (`name, metaclass = entity.value`).
- ~60 sous-classes Pydantic d'`Entity` (`fle/env/entities.py:521-1043`) avec des champs **typés et spécifiques** : `TransportBelt.{input_position,output_position,inventory:{left,right}}`, `AssemblingMachine.{recipe, input/output/modules}`, `Inserter.{pickup_position,drop_position}`, `Boiler/OilRefinery/PumpJack.{connection_points, fluid_box}`, etc.
- `EntityStatus` : ~90 valeurs (`NO_POWER`, `ITEM_INGREDIENT_SHORTAGE`, `WAITING_FOR_SPACE_IN_DESTINATION`…) → l'agent **diagnostique pourquoi** une machine est inactive.
- Objets « groupe » : `BeltGroup`/`PipeGroup`/`ElectricityGroup` — un run connecté entier renvoyé comme un seul objet par `connect_entities`.

### Pilier 3 — Exécution « action-as-code » par interprète AST (pas un `exec` brut)
`FactorioNamespace.eval_with_timeout` (`fle/env/namespace.py:1052-1174`) `ast.parse` le programme et le parcourt **statement par statement** via `execute_node` (`:420`). Bénéfices : (a) `print`→`log` réécrit et **capture de sortie ligne par ligne**, (b) **variables persistées entre steps** (`persistent_vars`), (c) erreurs avec **« did you mean…? »** (difflib) et **rollback** à la dernière ligne saine, (d) noms d'outils gelés (`_freeze_protected_names`). Les outils sont injectés en construisant `eval_dict` depuis `dir(self)` (`:1085-1097`).

### Pilier 4 — Lua injecté à chaud en RCON (le mod n'est PAS baké)
Le `control.lua` du scénario fait **24 octets** (un stub). Les ~12 600 lignes de Lua (`storage.actions.*` / `storage.utils.*`) sont **streamées en RCON au démarrage** par `LuaScriptManager`, **checksum-cachées** (MD5) pour éviter les renvois. Un appel d'outil = **un aller-retour** `/silent-command a,b = pcall(storage.actions.<nom>, <args slpp>); rcon.print(dump({a=a,b=b}))` (`fle/env/tools/controller.py:173-257`). `pcall` rend les erreurs **récupérables** (string, pas crash). slpp encode Python→Lua et décode le retour.

### Pilier 5 — Headless : FLE crée son propre personnage
`create_agent_characters` (admin) détruit les personnages existants et fait `surface.create_entity{name="character",…}` ; `ensure_valid_character(player_index)` en recrée un au besoin (`fle/env/mods/utils.lua:155-192`). **Aucun client humain requis** — contraste direct avec notre `waitForPlayer` (`main.ts:158`).

> Note : FLE **n'a pas** de skill-library. C'est un REPL par step avec persistance de variables. Notre Voyager (skills embeddés persistés) est un **plus** que FLE n'a pas.

---

## 2. airi-factorio aujourd'hui (le miroir)

- **Boucle Voyager** (`packages/agent/src/learning/`) : curriculum (décideur) → `attemptObjective` (générer→run→vérifier→retry, `attempt.ts:74`) → critic → skill-library. Surface fermée `Ops` (`types.ts:174`, `runtime.ts:88`).
- **Surface `ops`** (≈ outils FLE) en 3 classes :
  - **Requêtes synchrones** (`autorio_tools`, 1 round-trip JSON) : `getState, scan, getRecipe, describeEntity, findNearest, craftPlan, techFor, usedIn, productionStats, renderMap, placementSpots`.
  - **Primitives de placement déterministes** (synchrones aussi) : `placeDrillOn, placeFurnaceAtDrill, placeBeltLine, placeInserterBetween, connect, placeNextTo, setRecipe, buildSteamPower` — la géométrie est calculée dans le Lua.
  - **Ops settlantes asynchrones** (`autorio_operations` + settle-bus) : `walkToEntity, walkTo, mineEntity, placeAt, moveItems, craftItem, researchTechnology, wait, attackNearestEnemy`.
  - **Composition** : `skill(name,…)`, `log`.
- **Exécution** : `node:vm` (`runtime.ts:415`), entry = dernière `async function` top-level (convention Voyager). Pas d'interprète AST.
- **Mod baké** (tstl → `control.lua`) ; rebuild ⇒ checksum ⇒ redémarrage + reconnexion.
- **Settle-bus** (`settle-bus.ts`) : corrélation **positionnelle** via le drain générique `[MOD] All operations completed` (sûr seulement en sériel) + `[RESULT]` stash-and-attach.
- **Vérif 2 niveaux** : `precheckVerdict` (déterministe) + `verify` (critic LLM), nourris par `scan_factory` (recensement force-wide) + delta des compteurs de production.

---

## 3. Comparatif FLE ↔ airi-factorio

| Dimension | FLE | airi-factorio | Verdict |
|---|---|---|---|
| Surface d'outils | ~29 typés, dossier/outil, auto-registrés | ~30 ops, interface TS codée main | **égalité** (airi parfois plus haut-niveau) |
| **Retours d'entités** | ~60 classes typées, statut ×90, objets groupe | JSON plus plat (`scan`/`OpResult`) | **FLE gagne** — l'agent inspecte + chaîne |
| **Exécution** | interprète AST (capture/ligne, persistance vars, did-you-mean, rollback) | `node:vm` blob | **FLE gagne** (feedback + erreurs) |
| Cadence | 1 programme/step, état re-rendu chaque step | multi-retry/objectif, diff d'état | différent (REPL vs retry-loop) |
| Livraison Lua | injectée en RCON, checksum-cachée | mod baké tstl | FLE itère plus vite ; airi = type-safe |
| **Personnage** | auto-créé en RCON (headless) | `waitForPlayer` (client requis) | **FLE gagne** — benchmark auto |
| `connect` | résolveurs fluide/power/transport, objets groupe | L-path simple | **FLE gagne** sur le routage complexe |
| Skill-library | ❌ aucune | ✅ Voyager embeddé | **airi gagne** |
| Vérification | scoring | précheck + critic | **airi gagne** |
| Modèle d'exécution | tout synchrone (pcall) | sync tools + async settle | FLE plus simple ; settle = fragilité positionnelle |

---

## 4. Écarts qui comptent (ce qui fait gagner FLE)

1. **Feedback d'entités pauvre** : `scan`/`getState` renvoient position/dir/statut, mais pas la recette posée, le contenu d'inventaire d'une machine, ses points de connexion fluide, les positions d'E/S d'un belt. L'exécuteur ne peut pas *diagnostiquer* finement ni chaîner « la sortie de X alimente Y ». **C'est probablement le plus gros levier.**
2. **Dépendance au client humain** : impossible de lancer un bench/curriculum 100 % headless comme FLE.
3. **Primitives manquantes vers la fusée** : pétrole/fluides (refinery/chemical-plant/pipe routing), chaînes d'assemblage multi-étages, science + labos, rocket-silo + `launch_rocket`. À auditer contre l'échelle d'automatisation complète.
4. **`connect` simpliste** : pas de conscience fluide/power, pas de retour « groupe » exploitable.
5. **Sandbox sans capture ligne-à-ligne** : l'agent ne voit pas ce qu'a renvoyé chaque appel (seulement ce qu'il a `log` explicitement).

---

## 5. Plan de reproduction (priorisé)

### P0.1 — Personnage headless (port du pilier 5)
- Ajouter au mod `autorio` deux fonctions Lua : `create_agent_character()` (détruit/recrée un `character` via `surface.create_entity`) et `ensure_valid_character()` (au début de chaque op/tool qui agit sur le perso).
- Exposer un tool `autorio_tools.ensure_character` + un flag `HEADLESS=true` qui, au lieu de `waitForPlayer` (`main.ts:158`), crée le perso.
- Gain : curriculum/bench 100 % headless ; reproductibilité façon FLE.
- Réf FLE : `fle/env/tools/admin/create_agent_characters/server.lua`, `fle/env/mods/utils.lua:155-192`.

### P0.2 — Retours d'entités riches (port du pilier 2)
- Étendre `scan_area` / `describe` / un nouveau `get_entity(name|pos)` côté mod pour renvoyer, par machine : `status` (déjà), **recette posée**, **contenus d'inventaire** (input/output/fuel), **points de connexion fluide**, **input/output_position** des belts, `drop/pickup_position` des inserters/drills.
- Côté agent : enrichir les types `ScanResult`/`EntityInfo` (`types.ts`) en miroir des sous-classes FLE (sans aller jusqu'à 60 classes — viser belt/inserter/drill/furnace/assembler/fluid-handler).
- Gain : l'exécuteur diagnostique (« pourquoi le four est idle ») et chaîne les machines — exactement ce qui a permis à glm-5.2 de bâtir l'usine électrique complète.
- Réf FLE : `fle/env/mods/serialize.lua:614+` (`serialize_entity`), `fle/env/entities.py:521-1043`.

### P1.1 — Compléter les primitives jusqu'à la fusée
- Audit : lister l'échelle d'automatisation (mine→fonte→ science rouge/verte→pétrole→chimie→modules→rocket) et mapper chaque maillon à une primitive existante ou manquante.
- Probables ajouts : `placeAssemblerChain`/`setRecipe` (existe) + alimentation auto, `connect(kind='pipe')` fluide robuste, `buildOilSetup` (pumpjack→refinery→chemical), `placeLab`+alimentation science, `placeRocketSilo`, `launchRocket` (cf. FLE `launch_rocket`).
- Réf FLE : la liste des 29 outils agent (section 1, pilier 1).

### P1.2 — `connect` enrichi
- Porter l'idée des **résolveurs** FLE (`fle/env/tools/agent/connect_entities/resolvers/`) : choisir points de connexion source/cible selon le type (fluide vs power vs transport), espacer les poteaux sous la portée de fil, renvoyer un objet « groupe » (belts/pipes/poles posés) exploitable par l'agent.

### P2.1 — Capture ligne-à-ligne dans le sandbox
- Dans `runSkill` (`runtime.ts:415`), instrumenter pour capturer la valeur de retour de chaque `await ops.*` top-level (façon `log` FLE), et la renvoyer dans le feedback d'échec — l'agent voit ce qu'a produit chaque appel, pas seulement ses `ops.log`.

### P2.2 — (option) Injection Lua à chaud
- Expérimenter un chemin « 1 dossier = 1 tool » à la FLE : charger des snippets Lua en RCON au démarrage plutôt que tout baker — pour ajouter des primitives sans rebuild/checksum/reconnexion. À évaluer vs la sécurité de type tstl (probablement P2/optionnel).

### À NE PAS copier (garder nos avantages)
- La **skill-library Voyager** (FLE ne l'a pas) — c'est notre mémoire d'apprentissage.
- La **vérif 2 niveaux** (précheck + critic) — plus riche que le scoring FLE.
- Les **primitives haut-niveau opinionées** (`placeDrillOn`, `buildSteamPower`) — souvent meilleures pour un LLM que le `place_entity` bas-niveau de FLE.

---

## 6. Ordre d'attaque recommandé
**P0.2 (retours riches) d'abord** — plus haut ratio impact/effort, c'est le levier direct du benchmark — puis **P0.1 (headless)** pour pouvoir mesurer comme FLE, puis **P1.1 (primitives manquantes)** vers la fusée. P1.2 et P2 ensuite.
