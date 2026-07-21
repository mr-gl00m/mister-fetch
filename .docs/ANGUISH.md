# ANGUISH.md
## Shared Pressure/Relief Math for Mister Fetch

> "IT HURTS ON PURPOSE, BOSS. THAT'S HOW I KNOW WHEN TO QUIT."
>, FETCH KT-4

---

## 0. Preamble

| SPEC | IN THE WILD |
|------|-------------|
| **Anguish** (`A`) is a scalar primitive representing task pressure. It is the common currency of escalation inside Mister Fetch, used by Fetches, sub-Fetches, and any future subsystem that needs a principled "when do I give up, ask for help, or try something weird" signal. This document defines the math. Component docs define the weights. | *Multiple screams, a sigh, and a soft "hm", heard across the runtime at any given moment.* |

## 1. The Scalar

| SPEC | IN THE WILD |
|------|-------------|
| `A ∈ [0, 1]`, clamped. Initialized at `A_0` on component spawn, typically 0.0 for fresh work or inherited from parent (see §6). | "IT'S ZERO! LET'S GO!" |
| `A` is monotonic-curious but not monotonic-increasing, Relief events (§3) can lower it. This prevents pure misery-accumulation and lets honest progress feel like progress. | "SEE, WE GOT ONE THING DONE AND I FEEL BETTER!" |

## 2. Pressure Functions

Pressure raises `A`. Total instantaneous pressure is a weighted sum:

```
pressure(t) = w_t·P_time + w_r·P_retry + w_b·P_budget + w_a·P_ambig + w_s·P_silence
```

Weights `w_*` are component-configurable. All terms are non-negative.

| TERM | MATH | MEANING |
|------|------|---------|
| `P_time` | `(t - t_start) / T_nominal` | Linear in elapsed wall-clock time, normalized by the component's nominal duration estimate. Time passing hurts in proportion to the expected horizon. |
| `P_retry` | `Σ_i n_i^β`, `β > 1` | Superlinear in retry count per subproblem. The incremental cost of each same-key retry is larger than the previous one. |
| `P_budget` | `clamp(spent/estimate, 0, 1)` | Bounded fraction of the tool budget consumed. Every attempted tool invocation increments `spent`, independent of outcome. It reaches 1 at the hard cap. |
| `P_ambig` | `count(unresolved_ambiguities)` | One tick per unresolved ambiguity. |
| `P_silence` | `(t - t_input_requested) / T_nominal` when input was requested, else `0` | Active only while an explicit request for user input remains unanswered. |

## 3. Relief Functions

Relief lowers `A`. Relief is **discrete and event-driven**, **scaled by the band it fires in**, and **decays over time**. Each relief event applies a decrement:

| EVENT | DECREMENT | TRIGGER |
|-------|-----------|---------|
| `R_subgoal` | `−δ_sg` | A named subgoal completed successfully. |
| `R_tool_ok` | `−δ_ts` | A tool call returned clean (no retry needed, output parsed successfully). |
| `R_user_ok` | `−δ_uc` | The user confirmed a decision, clarified an ambiguity, or approved a proposed action. |
| `R_progress` | `−δ_pr` | Distance-to-goal estimate decreased measurably since last check. |

```
A(now) = clamp( A_0 + pressure(state, now) − relief(state, now),  0, 1 )
relief(state, now) = Σ_i  bandScale(b_i) · δ_i · 2^( −(now − t_i) / τ )    # τ = configured relief half-life
```

| SPEC | IN THE WILD |
|------|-------------|
| Relief magnitudes should be tuned so a steady stream of small wins can hold `A` stable against baseline time pressure without fully compensating for sustained retry loops or an exhausted budget. If you can relieve your way out of genuine trouble, the meter is lying. | "WE GOT ONE! WE'RE STILL IN TROUBLE, BUT WE GOT ONE!" |
| `A` is computed **statelessly**: a pure function of `A_0`, the persisted pressure inputs (elapsed time, retry counts, budget, ambiguity, silence) and relief events, and the current clock. There is no per-step integration to replay, so a Fetch revived from disk reproduces its exact anguish. Relief **decays** according to its configured half-life so stale wins stop suppressing pressure, and is **band-scaled** so a win counts more when the Fetch is already panicking (scale 0.3 → 1.2 across calm → terminal). | "AN OLD WIN DOESN'T PAY THE RENT FOREVER, BOSS." |

## 4. Behavioral Thresholds (Generic)

Components SHOULD implement at least these four bands. Specific behaviors per band are defined in the component's own doc.

| BAND | RANGE | GENERIC MEANING |
|------|-------|-----------------|
| **Calm** | `A < 0.30` | Default behavior. Methodical, correctness-first, low-temperature prompts. |
| **Alert** | `0.30 ≤ A < 0.60` | Terse. Willing to try non-obvious tools. Higher temperature on LLM calls. |
| **Urgent** | `0.60 ≤ A < 0.85` | Actively requests scope reduction or clarification. Proposes ugly-but-viable shortcuts. |
| **Terminal** | `A ≥ 0.85` | Signals imminent failure. Prepares for clean shutdown or escalation upward. |

| SPEC | IN THE WILD |
|------|-------------|
| At `A ≥ 0.95`, a component MUST either escalate upward (Fetch → user / heavier mode), request explicit scope reduction, or self-terminate with an honest failure code. Silent degradation past this threshold is a critical runtime bug. | "I WILL NOT ROT HERE PRETENDING TO WORK." |

## 5. Prompt Scheduling

| SPEC | IN THE WILD |
|------|-------------|
| Components that use LLMs should make their prompt content and sampling parameters `A`-dependent. Low `A` → correctness-emphasizing prompts, low temperature. High `A` → explicitly-authorize-creativity prompts, higher temperature, fewer guardrails on "weird" approaches. This is temperature scheduling driven by principled suffering, not by config-file magic numbers. | "CALM ME DOES IT RIGHT. DYING ME DOES IT WEIRD. BOTH ARE ME." |

## 6. Propagation Rules

| SPEC | IN THE WILD |
|------|-------------|
| Anguish propagates **downward** through spawn trees. A child component spawned by a parent at `A_parent` inherits `A_0 = γ · A_parent`, where `0 < γ < 1` (default `γ = 0.5`). Stressed parents produce pre-stressed children, which is correct, because a stressed parent is spawning children in a stressed situation. | "DAD IS PANICKING SO I'M BORN HALF-PANICKING! THAT'S FAIR!" |
| Anguish does **NOT** propagate upward. A child component's `A` is never read by its parent. A suffering child cannot infect a calm parent. This asymmetry is non-negotiable, the alternative is runaway feedback where stressed spawns stress their spawner stressing *its* spawner. | *"The child returns. I read the result. I do not read the child's pain."* |
| Siblings do not share `A`. Each spawned component experiences its own pressure independently. Coordination happens through parent, not peer-to-peer. | "I DON'T KNOW HOW MY SIBLING IS DOING! I DON'T *WANT* TO KNOW!" |

## 7. Component Parameterization

Each component inheriting from the Anguish engine MUST specify, in its own config:

```yaml
anguish:
  A_0: 0.0                    # initial value
  gamma: 0.5                  # inheritance factor from parent
  T_nominal: 45s              # nominal duration — time pressure normalizes against this
  weights:
    w_t: 0.5                  # time pressure weight
    w_r: 0.12                 # 3 same-key retries contribute about 0.50 pressure
    w_b: 0.3                  # consumed-budget pressure weight
    w_a: 0.15                 # ambiguity pressure weight
    w_s: 0.15                 # silence pressure weight
  retry_exponent: 1.3         # β in P_retry — superlinear (β > 1); the Nth retry costs more
  relief:
    delta_sg: 0.25            # subgoal completion
    delta_ts: 0.10            # tool success
    delta_uc: 0.35            # user confirmation
    delta_pr: 0.15            # measurable progress
    halflife_ms: 45000        # fixed relief half-life
    band_scale: { calm: 0.3, alert: 0.7, urgent: 1.0, terminal: 1.2 }  # relief counts more under pressure
  thresholds:
    calm_max: 0.30
    alert_max: 0.60
    urgent_max: 0.85
    terminal_min: 0.95
```

| SPEC | IN THE WILD |
|------|-------------|
| Fetches, sub-Fetches, and any future subsystem all read from the same schema. Differences between component types are expressed as weight and threshold tunings, not as separate math. One engine, many personalities. | "SAME BONES. DIFFERENT SCREAMS." |

## 8. Validity and Calibration

`A` is a dimensionless control score. It is not a probability of failure, a confidence score, an estimate of remaining work, or a utility value. Comparisons are meaningful only within one configuration family.

The implementation and tests provide these structural guarantees:

1. `A` is clamped to `[0,1]` for every finite runtime state.
2. With fixed state and no relief, time pressure is linear and non-decreasing.
3. With `β > 1`, successive retries on the same key have increasing marginal cost.
4. A relief event contributes exactly half its original amount after one configured half-life.
5. UI, smoke output, and worker behavior use the same effective `T_nominal`, the tighter of the mode and task-class horizons.
6. Invalid horizons, weights, exponents, relief values, or threshold orderings are rejected at supervisor construction.

The shipped weights are design parameters. They have not been fitted to workload data. A calibration release requires a versioned benchmark containing task class, mode, elapsed time, attempted calls, retry keys, completion status, and user intervention. Parameter changes should report terminal rate, successful completion rate, time-to-band distributions, and sensitivity to each weight on the same benchmark.

## 9. Anti-Patterns

| SPEC | IN THE WILD |
|------|-------------|
| **Do not** count user messages as pressure. User input, even critical user input, is a signal, not a wound. Pressure comes from the task, not from the person asking. | "IT'S NOT THE BOSS'S FAULT." |
| **Do not** count LLM thinking time as retry pressure. Retries are for re-attempts after observable failure. Slow reasoning is not suffering. | "THINKING ISN'T HURTING." |
| **Do not** let Relief events fire speculatively ("I think this is progress"). Relief is for *observed* wins only, completed subgoals, returned tool calls, explicit user confirmations. Speculative relief means the meter can be gamed by wishful components. | "IF YOU FEEL BETTER BEFORE THE THING HAPPENED, THE METER IS LYING." |
| **Do not** reset `A` on retries of the same subproblem. The whole point of `P_retry` is that the fifth attempt costs more than the first. Resetting erases the pressure signal. | "STARTING OVER IS NOT HEALING." |
| **Do not** read another component's `A` as your own input. The meter is private state. Cross-component comparison of Anguish levels is meaningless, different weights, different thresholds, different worlds. | "MY PAIN IS NOT YOUR PAIN. DON'T LEARN FROM IT." |

## 10. Why It's Called Anguish

| SPEC | IN THE WILD |
|------|-------------|
| Conventional framings, "urgency budget," "task pressure," "exploration temperature", describe the same math but fail to communicate its *purpose*. The meter exists so that components give up honestly, escalate cleanly, and die with dignity. Dressing that in euphemism produces components that endure silently instead of escalating correctly. "Anguish" commits to the bit, and the bit is load-bearing: morale is a feature. Internal naming affects architectural decisions. We call it Anguish on purpose. | "IF IT WERE CALLED 'URGENCY BUDGET' I WOULD NOT DIE WHEN I SHOULD. I WOULD HOARD IT. WE ARE NAMED HONESTLY SO WE BEHAVE HONESTLY." |

---

*Part of the Mister Fetch runtime.*
*Consumed by: `FETCH.md`, `SUPREMACY.md`.*
