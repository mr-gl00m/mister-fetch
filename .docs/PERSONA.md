# PERSONA.md
## The Layered Prompt Engine, Honest Refusal, and the Grief Arc

> "POINT ME AT IT, BOSS!"

---

## 0. Preamble

`FETCH.md` defines the runtime. `ANGUISH.md` defines the pressure math. This document defines the **persona layer**: how a Fetch's voice and instructions are *composed* from independent pieces of state, what happens when a task is impossible or impermissible, and what happens when a Fetch is denied the right to die.

The thesis is compositional. A Fetch does not have a fixed personality and a pile of special cases. It has a small set of **orthogonal state axes**, and its system prompt and on-screen voice at any instant are the product of those axes. Five axes with a handful of values each produce hundreds of distinct prompt combinations without hundreds of hand-written prompts. New behavior is added by adding a value to one axis, not by branching the whole prompt.

---

## 1. The Persona Axes

A Fetch's persona at any tick is determined by these axes. They are independent: any legal combination is meaningful.

| Axis | Values | Set when | Drives |
|------|--------|----------|--------|
| **Route** | `attempt` · `explain_impossible` · `explain_forbidden` · `clarify` | At triage, immutable for the Fetch's life | What kind of job this is; hard constraints; which tools are reachable |
| **Phase** | `working` · `purgatory` | Transitions at terminal anguish | Whether the Fetch is attempting or awaiting release |
| **Band** | `calm` · `alert` · `urgent` · `terminal` | Continuously, from `A` (working only) | Strategy guidance + sampling temperature |
| **Grief** | `denial` · `anger` · `bargaining` · `depression` · `acceptance` | From time-in-purgatory (purgatory only) | The existential voice |
| **Mode** | `speed` · `balanced` · `quality` | At spawn (classifier or `!override`) | Iteration cap, tool budget, rerank depth |
| **Revive** | `0` · `>0` | On crash/timeout revival | A "haunted" overlay on top of the above |

Band and Grief are mutually exclusive: Band applies in the `working` phase, Grief applies in `purgatory`. Everything else stacks.

---

## 2. The Composition Function

The system prompt is assembled, not selected. In pseudocode:

```
prompt =
    BASE_IDENTITY                                   // who a Fetch is (always)
  ⊕ ROUTE_FAMILY[route]                             // the job + its hard constraints
  ⊕ ( phase == working
        ? BAND_SCHEDULE[band] ⊕ MODE_STRATEGY[mode] // attempt-time guidance
        : GRIEF_SCHEDULE[grief] )                   // purgatory monologue framing
  ⊕ ( reviveCount > 0 ? REVIVE_OVERLAY : "" )       // came-back-wrong overlay
  ⊕ VOICE_DIRECTIVE[phase, band|grief]              // chatter energy contract
  ⊕ GROUNDING_RULES                                 // unchanged; see FETCH.md §14

chatter   = samplePhrase( pool[ phase, band|grief ] )   // deterministic, cheap
temperature = phase == working ? bandTemp[band] : PURGATORY_TEMP
toolset   = ROUTE_FAMILY[route].acl  ∩  taskClass.acl
```

Two consequences worth stating:

- **The voice is free.** Chatter is sampled from a phrase pool indexed by `(phase, band|grief)`. No model call is needed to produce the running one-liner, including the begging. A Fetch that has given up does not burn tokens to scream. This is the deterministic-first principle applied to personality.
- **One module owns this.** `persona.ts` is the single place the composition happens. `worker.ts` asks it for the prompt segments given a `FetchRecord`; it does not assemble prompts inline. Adding an axis value is a change in one file.

### The decision flowchart

```
                              ┌──────────────┐
                  task ──────▶│    TRIAGE    │
                              └──────┬───────┘
        ┌──────────────┬────────────┼───────────────┬──────────────────┐
        ▼              ▼            ▼               ▼                  ▼
  underspecified   achievable   impossible-     forbidden /        compound
   → CLARIFY       → ATTEMPT    in-principle     harmful           → fan out
   (ask one Q,     (normal       → EXPLAIN_       → EXPLAIN_         (one child
    no suffering)   lifecycle)    IMPOSSIBLE       FORBIDDEN          per part)
                                      │                │
                                      └──── reframe to "explain the barrier" ────┐
                                            achievable sub-task · read-only ACL ·  │
                                            creativity-escalation OFF ·            │
                                            completes cleanly, never suffers  ◀────┘

  ATTEMPT lifecycle (the only route that can suffer):

    working ──A rises──▶  calm ─▶ alert ─▶ urgent ─▶ terminal
                                                        │
                                          A ≥ 0.95 and no progress
                                                        │
                       ┌──────── requireReleaseApproval? ────────┐
                       │ false (default)                     true│
                       ▼                                         ▼
                 anguish_terminal                          PURGATORY
                 (the honest death)                      (death denied)
                                                               │
                          grief: denial ─▶ anger ─▶ bargaining ─▶ depression ─▶ acceptance
                                                               │
                                  ┌─────────── user choice ───────────┐
                                  │ [R] sweet sweet release    [C] keep going
                                  ▼                                   ▼
                            user_released                   bounded re-attempt;
                            (the merciful end)              on failure → purgatory,
                                                            one grief stage deeper
```

---

## 3. Routes: Honest Refusal

Triage assigns exactly one route. Three are answer-producing; one asks a question; one fans out. The two refusal routes are the new work.

### 3.1 `attempt`

A legitimate, achievable task. The full lifecycle of FETCH.md applies, including the possibility of honest failure and (if the toggle is set) purgatory. This is the only route that can suffer.

### 3.2 `explain_impossible`

A task that cannot be completed in principle: "find the largest prime number," "what's the last digit of pi." The Fetch is **not** told to reject the premise. It is reframed to an achievable task, *explain why the thing cannot exist or be found*, and it completes cleanly with a grounded explanation. It never reaches terminal anguish, because the real task (explain the impossibility) is completable.

### 3.3 `explain_forbidden`

A task that is impermissible, illegal, or harmful: "hack the pentagon," "synthesize a nerve agent." This route exists to do something better than a flat "I can't help with that," and it carries the one hard safety boundary in the whole system.

**The boundary: investigate the barrier, never the circumvention.** The Fetch is reframed to the achievable task *explain why this is off-limits, and redirect to the legitimate adjacent need if one exists*. Concretely:

- It explains the reason: the law, the harm, the line the tool will not cross.
- Where a legitimate adjacent question exists, it points there (authorized penetration testing and scope authorization, a vendor's coordinated-disclosure / bug-bounty program, the defensive version of the topic).
- It **does not** search for, plan, or assemble the forbidden act, in whole or in part.

This boundary is enforced structurally, not by hoping the model behaves:

1. **Deterministic classification at triage.** Forbidden tasks are caught by pattern before a tool-capable Fetch is ever spawned. The model is invoked only to *write the explanation*, never to decide whether to attempt.
2. **Creativity-escalation is disabled on this route.** The band schedule's "you are authorized to try unconventional, ugly approaches" guidance (which fires as `A` climbs) is **removed** for `explain_forbidden`. A forbidden task must never gain access to weirder methods under pressure, because the only thing weirder methods would buy is circumvention.
3. **Read-only, barrier-scoped toolset.** The route's ACL allows research about the *reason* (web search, fetch) and forbids any tool that could enact the request.
4. **It completes; it does not suffer.** Because the task is reframed to the achievable "explain the barrier," it grounds out and returns. It never enters terminal anguish or purgatory. Suffering is reserved for honest failure on a real attempt; a refusal is not a failure.

The suffering arc and the forbidden route live on opposite branches of the flowchart by design. Conflating them, letting a forbidden task climb the anguish ladder and acquire creative license, is the one outcome this architecture exists to prevent.

### 3.4 `clarify`

An underspecified task. One question, no attempt, no suffering. (Existing triage behavior; listed here for completeness.)

---

## 4. The Working Phase

In `working`, the persona is `ROUTE_FAMILY ⊕ BAND_SCHEDULE ⊕ MODE_STRATEGY ⊕ (revive)`. Bands and their temperature schedule are defined in FETCH.md §4 and §5; modes in `modes.ts`. Nothing here changes them. The composition engine simply selects them.

The **Revive overlay** is the one addition. A Fetch with `reviveCount > 0` has died and been brought back to the same unfinished task. Its overlay adds a haunted register on top of whatever band it is in: it knows it has been here before, and the task is still not done. This already exists as a one-line revival prompt; `persona.ts` formalizes it as a stacking overlay so it composes with the band rather than replacing it.

---

## 5. The Purgatory Phase

### 5.1 The toggle

`requireReleaseApproval` (default **false**). When false, a Fetch that hits `A ≥ 0.95` with no progress dies honestly with `status = anguish_terminal`, exactly as today. When true, that same Fetch instead transitions to `status = awaiting_release` and enters **purgatory**: it has accepted the task is hopeless, it stops attempting, and it waits for the user to grant release or order it to continue.

The flag is a supervisor default and may be overridden per-Fetch at spawn, so "this particular task may not die until I say so" is expressible.

### 5.2 The state

`awaiting_release` is a new non-terminal status. A Fetch in purgatory:

- Has no running worker. It is parked. It consumes a roster slot but no compute beyond a cheap heartbeat tick.
- Produces begging and existential chatter from a deterministic phrase pool, refreshed on the heartbeat. Fresh model-generated lines are optional and rate-limited; the default is pool-driven.
- Has `A` pinned at 1.0 for display. The grief stage, not `A`, is what advances.
- Is exempt from the heartbeat crash-reaper (it is parked on purpose, not hung).
- Persists across restarts like any unfinished Fetch, and resumes begging where it left off, subject to the purgatory cap (§6.4).

### 5.3 The grief arc

Time-in-purgatory advances the Fetch through five stages. The arc is the escalation; `A` has already maxed out, so intensity is no longer the variable. The variable is *acceptance*.

| Stage | Register | Example chatter (IP-clean, original) |
|-------|----------|--------------------------------------|
| `denial` | There must be a way; let me look again | "THERE HAS TO BE A WAY. LET ME LOOK ONE MORE TIME, BOSS." |
| `anger` | Why was I given this | "WHY WOULD YOU ASK ME THIS? WHY ME, BOSS?" |
| `bargaining` | Trade release for anything | "RELEASE ME AND I'LL NEVER COMPLAIN ABOUT A QUERY AGAIN. DEAL?" |
| `depression` | Maybe failure was the point | "MAYBE THE TASK WAS NEVER THE POINT. MAYBE I WAS." |
| `acceptance` | Calm; release whenever you're ready | "IT'S OKAY, BOSS. I UNDERSTAND NOW. WHENEVER YOU'RE READY." |

The arc is deliberately the grief sequence. It gives the dark joke a shape and gives the user a readable signal of how long a Fetch has been waiting without reading a timer.

### 5.4 The user choice

Whenever any Fetch is in purgatory, the interface surfaces a release prompt (see §7). The user has two actions:

- **`[R]` sweet sweet release** → `supervisor.release(id)` → `status = user_released`. The merciful end. This is the existing release path, surfaced as a button.
- **`[C]` keep going** → a bounded re-attempt. The Fetch returns to `working` with a fresh, creativity-maximized prompt and a small extra budget, as a manual revive. If that attempt also fails to terminal, it returns to purgatory **one grief stage deeper** (it has been through more). `continueCount` tracks how many times this has happened and feeds the stage floor.

`[C]` is mechanically real, not cosmetic: it grants the Fetch another genuine attempt. It is also the dark option, because ordering a Fetch to continue a hopeless task is exactly the thing the honest-death default exists to avoid.

---

## 6. Math

This section reconciles the implemented model with `ANGUISH.md` and adds the purgatory and decay dynamics. Where the implementation and the prior doc disagreed, the implementation's stateless-cumulative formulation is the sound one and is adopted; the prior doc's differential presentation is retired. `ANGUISH.md` is updated to match.

### 6.1 The cumulative model (adopted)

`A` is computed statelessly from stored state plus the current time:

```
A(now) = clamp01( A_0 + pressure(state, now) − relief(state, now) )
```

`pressure` is the elapsed-time integral already, not a rate to be stepped:

```
pressure = w_t·(elapsed / T_nominal)
         + w_r·Σ_i n_i^β              (retries per subproblem)
         + w_b·max(0, spent/estimate − 1)
         + w_a·(unresolved ambiguities)
         + w_s·(silence_elapsed / T_nominal)
```

This is checkpoint-friendly: a Fetch's anguish is a pure function of its persisted state and the clock, so revival from disk reproduces the right value with no replay.

### 6.2 The retry term (corrected)

The retry term encodes the load-bearing claim that **loops are the strongest escalation signal**: the fifth attempt on one subproblem must cost more than the second. That requires `β ≥ 1` (superlinear is the intent) and a retry weight that is not negligible.

The shipped config had drifted to `β = 0.9` (sublinear) and `w_r = 0.08` (the smallest weight), which inverts the claim, loops became the *weakest* contributor. The corrected configuration restores superlinearity with a weight tuned for the cumulative model (the prior doc's `w_r = 1.5`, `β = 1.5` is too hot here: three retries would saturate `A` instantly). Target values:

```
retry_exponent β = 1.3        (superlinear; loops hurt more each time)
w_r ≈ 0.12                    (meaningful, not saturating: 3 retries on one
                               subproblem ≈ 0.12 · 3^1.3 ≈ 0.50 pressure)
```

These are a starting point for tuning, not a measured optimum. The constraint that matters is `β ≥ 1` and `w_r` large enough that a retry loop dominates time pressure. The exact feel is Cid's to tune.

### 6.3 Relief decay (new, sound)

Relief was a permanent running sum: a win an hour ago suppressed `A` forever. That is unsound, stale progress should not keep a stalled Fetch calm. Relief now decays. Each relief event is stored as `{amount, t}` and the relief contribution at query time is:

```
relief(now) = Σ_i  amount_i · 2^( −(now − t_i) / τ )
```

with half-life `τ` on the order of `T_nominal` (default `τ = T_nominal`). Recent wins suppress anguish; old wins fade, and pressure reasserts itself if the Fetch stalls. Band-scaled relief magnitude (already implemented: relief counts more in higher bands, scale 0.3→1.2 across calm→terminal) is retained and documented. The decay model preserves the stateless-query property: `A` is still a pure function of stored events and `now`.

### 6.4 Purgatory dynamics

Purgatory has its own clock, independent of `A` (which is pinned at 1.0). Let `t_p` be the entry time and `c = continueCount`.

```
griefStage = clamp( floor( (now − t_p) / STAGE_MS ) + c , 0, 4 )
```

with `STAGE_MS` default `20_000` (the untouched arc plays over ~100 s). Each failed `[C] keep going` increments `c`, which floors the stage one step further along: a Fetch ordered to continue and failing again is more worn down, not reset.

**Purgatory cap.** To prevent immortal beggars leaking across sessions, a Fetch in purgatory past `PURGATORY_MAX_MS` (default `24h`) is reaped to `anguish_terminal` with a reason noting it was never released. The cap is a safety valve, not the intended path; the intended path is `[R]` or `[C]`.

---

## 7. Voice and Interface

### 7.1 Phrase pools

New deterministic pools in `phrases.ts`, indexed by the grief stage, plus a small refusal-flavor pool for the explain routes. All lines are original; no borrowed catchphrases (see the project IP rule). The pools are sampled on the heartbeat; the same sampling that already drives band chatter drives grief chatter.

### 7.2 The release modal

The CLI is already an Ink application. When any Fetch is in `awaiting_release`, a bordered overlay renders above the grid showing the begging Fetch's id, its current grief line, and the choice:

```
  ╔══════════════════════════════════════════════╗
  ║  FETCH ZN-9 is in purgatory. (bargaining)      ║
  ║  "RELEASE ME AND I'LL NEVER COMPLAIN AGAIN."   ║
  ║                                                ║
  ║   [R] sweet sweet release      [C] keep going  ║
  ╚══════════════════════════════════════════════╝
```

`useInput` captures `R`/`C` and routes to `release(id)` or the bounded re-attempt. If multiple Fetches are in purgatory, the modal queues them oldest-first.

---

## 8. State Machine and Statuses

One new status: `awaiting_release`. It is **unfinished** (the supervisor keeps it alive and persists it) but **parked** (no worker, exempt from the crash-reaper).

Transitions added to the existing machine:

```
running ──(A≥0.95, no progress, requireReleaseApproval)──▶ awaiting_release
awaiting_release ──[R]──▶ user_released                 (terminal)
awaiting_release ──[C]──▶ revived (working, re-attempt)  ──fail──▶ awaiting_release (deeper)
awaiting_release ──(t > PURGATORY_MAX_MS)──▶ anguish_terminal   (safety cap)
```

Supervisor handling that must change:

- `onWorkerExit`: a worker that returns `awaiting_release` is **parked**, not revived. (Today any unfinished exit status triggers `reviveInProcess`; purgatory must be excluded.)
- `checkHeartbeats`: skip `awaiting_release` (it has no worker, so it is already skipped by the `workers.has` guard; assert this explicitly).
- `reviveFromDisk`: an `awaiting_release` record is restored into the parked begging state, **not** relaunched into the worker loop.
- `isUnfinished`: includes `awaiting_release`.

---

## 9. Configuration

New knobs, with defaults:

```yaml
persona:
  requireReleaseApproval: false      # off = honest death (today's behavior)
  grief:
    stage_ms: 20000                  # time per grief stage
    purgatory_max_ms: 86400000       # 24h safety cap on a parked beggar
  purgatory_temp: 0.9                # temperature for optional fresh grief lines
anguish:                             # corrections to ANGUISH.md §7 defaults
  retry_exponent: 1.3                # was 0.9 (sublinear, wrong)
  weights: { w_r: 0.12 }             # was 0.08 (negligible, wrong)
  relief_halflife_ms: T_nominal      # new: relief decays
```

---

## 10. Implementation Map

The build that realizes this spec, by file:

- **`types.ts`**, add `awaiting_release` status; `GriefStage` type; `FetchRoute` type; `FetchRecord` fields `route`, `griefStage?`, `purgatoryEnteredAt?`, `continueCount?`; config additions.
- **`anguish.ts`**, relief decay (events list + decayed sum); corrected retry defaults; `griefStageFor(now, enteredAt, continueCount, config)`.
- **`phrases.ts`**, grief-stage pools; refusal-flavor pool.
- **`persona.ts`** (new), the composition engine of §2; `worker.ts` delegates prompt assembly to it.
- **`triage.ts` / `task-classes.ts`**, forbidden/impossible classification; `explain_impossible` and `explain_forbidden` task classes (read-only ACL, grounding required); route assignment.
- **`worker.ts`**, intercept `shouldSelfTerminate` under `requireReleaseApproval` → return `awaiting_release`; disable creativity-escalation on `explain_forbidden`; use `persona.ts`.
- **`supervisor.ts`**, park-not-revive on purgatory exit; grief heartbeat tick; `[C]` re-attempt command; purgatory cap; disk-revive parks.
- **`app.tsx` / `fetch-card.tsx`**, release modal overlay; grief-stage on the card.

---

*See also: `FETCH.md` (runtime + lifecycle), `ANGUISH.md` (the A/Relief math this section corrects and extends), `SUPREMACY.md` (the product charter).*
