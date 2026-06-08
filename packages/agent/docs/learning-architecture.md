# Learning Architecture (Voyager-inspired) — Design

Transform the autonomous Factorio agent from a single-objective reactive loop into a
**lifelong-learning** agent that builds entire factories by composing learned skills.
Inspired by MineDojo/Voyager (automatic curriculum + skill library + self-verification).

## Decision taken: skills are GENERATED CODE (Voyager-faithful)

A learned skill is an **LLM-generated async JS function** `async function f(state, ops) { ... }`,
stored as source text. It runs **inside the agent (Node) in a sandbox**, and drives the game only
through `ops` — a closed capability object that maps 1:1 to the `autorio` primitives + perception.
This gives real logic (loops, conditionals, parameters) and **composition** (`await ops.skill('...')`),
exactly like Voyager's Mineflayer code — without executing anything arbitrary inside Factorio.

> The code never runs *in* Factorio. It runs in the agent and emits `remote.call('autorio_operations', …)`
> via `ops`. Closed vocabulary (`ops.*`), open composition (the LLM assembles functions that call functions).

## Foundation we already have (reuse / re-home)

- **Closed primitive vocabulary**: `remote.call('autorio_operations', <op>, …)` — walk_to_entity, mine_entity,
  place_entity (snaps drill→ore, furnace→drill output), move_items, craft_item, research_technology, attack, wait.
- **Loop + settle**: `src/autonomous.ts` awaits the in-game completion signal (`[MOD] All operations completed` /
  `[ERROR] …`). This execute+settle logic is **re-homed into the `ops` runtime** (one op at a time, awaited).
- **Perception**: `getInventoryItems` / `getPlayerStatus` (RCON). Vision (gemma4) becomes **auxiliary** (optional
  screenshot for the critic), no longer needed for code generation.
- **Configurable LLM** (kimi writes code well) + race-safe settle.

## Target lifelong loop (orchestration in `autonomous.ts`)

```
while running:
  objective, ctx = curriculum.next(state, library.summary(), history)        # LLM (curriculum)
  before = captureState()
  prevCode, lastError = null, null
  for attempt in 1..4:                                                        # Voyager iterative prompting
    skills = library.retrieve(objective + ctx, k=5)                          # embeddings → skill SOURCE
    code   = action.generateCode(objective, ctx, before, skills, prevCode, lastError)   # LLM → async fn source
    result = runtime.run(code, ops)                                          # sandbox: ops.* drive game live
    after  = captureState()
    verdict = critic.verify(objective, before, after, result.logs)           # LLM → {success, critique}
    if verdict.success: break
    prevCode, lastError = code, (result.error ?? verdict.critique)           # fed into next attempt
  if verdict.success:
    desc = describe(code)                                                    # cheap LLM, 1 line
    library.add({ name, description: desc, code, objective })                # embed(desc) via qwen3, persist
    history.completed += objective
  else:
    history.failed += objective
```

## Components

### 1. State snapshot — `src/learning/state.ts`
- `captureState(): Promise<GameState>` — one RCON Lua call → compact JSON: `inventory` (item→count), `position`,
  `health`, built-entity counts+statuses (drills/furnaces/labs/belts), `researched` techs, `currentResearch`.
- `diffState(before, after): string` — human-readable delta (items gained/lost, entities built) for the critic.

### 2. Skill runtime — `src/learning/runtime.ts`  ← foundational (must exist before code can run)
- Exposes the **`ops`** capability object (the closed vocabulary). Each action method sends **one** operation via RCON,
  awaits the in-game settle, and resolves `{ ok, error? }` — re-homing the current execute+settle logic.
  ```ts
  interface Ops {
    getState(): Promise<GameState>                       // fresh perception mid-skill
    walkToEntity(name, opts?): Promise<OpResult>
    mineEntity(name, count?): Promise<OpResult>
    placeEntity(name, opts?): Promise<OpResult>          // mod snaps drill→ore, furnace→drill output
    moveItems(opts): Promise<OpResult>
    craftItem(recipe, count): Promise<OpResult>
    researchTechnology(name): Promise<OpResult>
    wait(ticks): Promise<OpResult>
    skill(name, ...args): Promise<OpResult>              // invoke another learned skill (composition)
    log(msg: string): void                               // progress trace, fed to critic on failure
  }
  ```
- `run(source, ops): Promise<{ ok, error?, logs }>` — compiles the function in a **sandbox** and calls it with a
  frozen `state` + `ops`. Because `ops.*` resolves on settle, a skill with a loop placing N drills does N awaited steps
  and can branch on `ok/error` (in-skill reactivity, like Voyager).

### 3. Action (code generation) — `src/learning/action.ts` (+ extend the existing decide path)
- Prompt: objective + `ctx` + state + retrieved **skill source** + the `ops` API doc + (on retry) previous code & error.
- LLM output sections **Explain / Plan / Code** (Voyager style); extract the **last async function** named `(state, ops)`.
- The function may call retrieved skills via `await ops.skill('name', …)`.

### 4. Critic (self-verification) — `src/learning/critic.ts`
- `verify(objective, before, after, logs): Promise<{ success, critique }>`. One LLM call (cheap model); state diff +
  skill logs → strict JSON `{reasoning, success, critique}`; parse-retry ≤5. The success oracle (replaces naive
  "All operations completed"). **Only verified successes become skills.**

### 5. Skill Library — `src/learning/skill-library.ts`
- `Skill = { name, description, code /* source */, objective, uses, createdAt }`.
- Storage: `skills/<name>.js` (source) + `skills.json` (manifest) + `skill-vectors.json` (name → embedding of the
  **description**). Loaded at boot; persisted on add.
- `embed(text)` — Ollama `POST /v1/embeddings` model **`qwen3-embedding:8b`** (local, already pulled).
- `retrieve(query, k)` — `embed(query)` then cosine vs all → top-k; returns skill **source** (injected into the prompt
  AND made callable via `ops.skill`).
- `add(skill)` — dedupe by name; persist. `summary()` → `{name, description}[]` for the curriculum.

### 6. Curriculum — `src/learning/curriculum.ts`
- `next(state, librarySummary, history): Promise<{ objective, context }>`. One LLM call: ultimate goal (launch a rocket)
  + state + known skills + completed/failed → next concrete objective + how-to `context`. First objective bootstrapped.

### 7. Orchestration — `autonomous.ts` (extended)
- New `AUTONOMOUS_LEARNING=true` mode wrapping the loop above (the current batch-commands path stays for non-learning mode).

## Sandbox safety (`runtime.ts`)
- Run the function via **`node:vm`** in a context containing **only** `{ ops, state, console:{log:ops.log}, JSON, Math, … }`
  — **no** `require`, `process`, `global`, `fs`, `fetch`. The skill's only authority is `ops`.
- Bound runaways: overall **wall-clock timeout** (`Promise.race`, e.g. 120 s), a **cap on total `ops` calls** per skill
  (e.g. 200), and `vm`'s synchronous `timeout` for tight loops.
- **Threat model**: code comes from *the user's own LLM on their own single-player machine* (same as Voyager running JS
  in a Node subprocess). `node:vm` guards **accidents/runaways**, not a determined adversary. Hardening upgrade path if
  ever needed: `isolated-vm` or a `worker_thread`.

## Prompts (`src/llm/`)
`prompt-action-code.md` (with the `ops` API reference + Explain/Plan/Code format + "reuse skills"), `prompt-critic.md`,
`prompt-curriculum.md`, `prompt-skill-description.md`.

## Embeddings
`qwen3-embedding:8b` via Ollama `/v1/embeddings` (OpenAI-compatible). Local, free, already pulled.

## Key decisions & risks
- **Granularity**: `ops` awaits per action (one op at a time) instead of one batched `/c` — a few more RCON round-trips,
  but enables in-skill branching on `ok/error`.
- **Sandbox** is `node:vm` (accident/runaway guard, not adversary-proof) — acceptable for own-machine/own-LLM.
- **Vision** is auxiliary now (optional screenshot to the critic), not used for code-gen.
- **Model**: code generation needs a capable model (kimi-k2.6 is fine; small local models often aren't). Use cheap
  models for critic/curriculum/describe; pace with `tickDelay`.

## Implementation order
1. **State snapshot + Critic** — verify by diff; biggest reliability gain; buildable offline, testable on reconnect. ✅ done
2. **Skill runtime (`ops` API + sandbox)** — foundational; re-homes execute/settle into awaited primitives; test `ops.*` live. ✅ done
3. **Action-as-code** — LLM generates a function; parse; run via runtime; iterative retry with feedback. ✅ done
4. **Skill Library** — store/retrieve CODE; embed descriptions (qwen3); inject source; enable `ops.skill()` composition.
5. **Curriculum** — auto objectives toward the rocket.
6. **Full orchestration + tuning** (retries, pacing, model choices).

## Status & review follow-ups (steps 1-2 — 2026-06-08)

Steps 1-2 implemented in `src/learning/` (`types`, `json`, `settle-bus`, `state`, `llm`, `critic`, `runtime`) +
`src/llm/prompt-critic.md` + `learningConfig`. 52 unit tests pass; typecheck + lint clean. A 4-reviewer
adversarial pass (27 findings) was run; outcome:

**Applied (agent-side):** top-level-only entry extraction (skip nested async helpers); `luaArg` escapes `\n`/`\r`;
timed-out skills are cancelled so the orphaned vm stops issuing real ops (`cancellers` WeakMap); `getState` counts
against the op cap; `criticModel===''` falls back to `OPENAI_MODEL`; world snapshot excludes the `character` entity.

**Applied (mod-side — also fixes the existing autonomous mode):** every silent-failure path in `control.ts`
(mining no-entity, move 0, place: no-inventory / invalid name / not-in-inventory / no-valid-position / create-failed)
now emits `[AUTORIO] [ERROR] …` so the agent sees a real failure instead of a phantom "All operations completed";
`research_technology` add-research failure now returns `[false, …]`. **Mod rebuilt → checksum changes → cold server
restart + client reconnect required.**

**Deferred (documented, not blocking a single-op serial smoke test):**
- **#2 op-id correlation** — the mod's "All operations completed" is a generic queue-drain print, not a per-op signal.
  With strictly-serial ops + the `[ERROR]` fixes + orphan cancellation this is sound for the serial loop, but for
  batch/composed runs we should thread an `op_id` through `remote.call` and have the mod echo it on its terminal line
  (do before step 6 / `ops.skill`).
- **#8 freeze the `ops` contract** before step 3 (the LLM prompt's API doc must match `Ops` byte-for-byte; decide
  `placeEntity` position/direction opts before persisting skills as source).
- **#10 craft watchdog** (a stalled `begin_crafting` never settles → ~3-min timeout; add a tick guard before relying on
  craft in the loop). **#11 shared deadline** across composed skills. **#12 step 3-4 config** (`actionModel`, `skillsDir`,
  embedding base URL). **#7** per-op failure handlers using `cancel_all_tasks` (fine in serial mode).
