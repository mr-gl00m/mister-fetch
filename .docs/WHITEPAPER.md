# Mister Fetch: Deterministic-First, Disposable Agents for Trustworthy Local Search
## A Technical Position Paper

**Author:** Cid / 司渊, Independent Researcher
**Corresponding:** via `github.com/mr-gl00m` *(swap in a contact address before publishing)*
**Version:** 1.2 (2026-07-13)

**Preregistration:** Not applicable. This is an architecture paper, not an experimental study; it pre-declares no statistical analysis.
**Code:** `github.com/mr-gl00m/mister-fetch` (pre-release; no tagged commit at time of writing)
**Data:** None. No dataset is collected or distributed.
**Software:** Node.js 22, TypeScript 5.6, Playwright 1.61, Ink 5, React 18, Anthropic SDK 0.110; LLM providers: Ollama (default model `hermes3`) or Anthropic.
**Hardware (development):** Starforge Voyager, Intel i7-14700KF, NVIDIA RTX 5070 Ti, 32 GB DDR5.
**Random seed:** Not applicable; no seeded experiments are reported.
**OS:** Windows 11.

**Keywords:** local-first AI, agent architecture, deterministic routing, retrieval-augmented generation, hallucination mitigation, grounding, reciprocal rank fusion, disposable agents, observable agent state

---

## Abstract

**Background.** Cloud "answer engines" built on large language models share a set of structural problems: they are funded by attention rather than by task completion, they present an opaque progress indicator that hides what the system is doing, and they can emit fluent text unsupported by any retrieved source. I am interested in the opposite design point for the narrow class of query shaped as *"I cannot find X, go get it."*

**Architecture.** I describe Mister Fetch, a local-first search and task engine in which every query becomes a single-shot, scope-locked, memory-ephemeral agent (a *Fetch*). A Fetch climbs a cheapest-first escalation ladder: a no-LLM action-keyword fast path, then deterministic tools (web search with reciprocal-rank fusion, a local file index, content grep), and only then a light local language model. Three mechanisms define the runtime: an *Anguish meter*, a bounded task-pressure control score with explicit pressure and relief dynamics; an *evidence-coverage validator* that checks normalized terms and numbers against successful tool output; and *memory ephemerality*, the destruction of a Fetch's working context on completion.

**Contributions.** I report no benchmark results. This paper contributes a design and an argument, not measured effect sizes. I state four positions, specify the mechanisms that implement them in a working TypeScript runtime, and define the evaluation that would test each one. I am explicit throughout about which components are implemented, which are stubbed, and which are unmeasured.

**Conclusions.** A last-resort model layer, an observable control signal, a lexical evidence gate, and disposable context are compatible in one runtime. Product benefit, calibration quality, and validator error rates remain empirical questions.

---

## 1. Introduction

### 1.1 Background

A large fraction of everyday search is not a research task. It is a lookup: where a file lives on this machine, what a single number is, which URL to open, a short ranked list. The dominant tools for these lookups are general web search engines and, more recently, LLM-backed answer engines. Both carry overhead that the lookup does not need. Web search renders an advertising and consent shell around the result. Answer engines add a model inference pass to every query regardless of whether the query needs reasoning, present a spinner that conveys nothing about progress, and inherit the well-documented tendency of language models to produce unsupported statements [4].

The components needed to do better already exist and are mostly free. Local language models run on consumer hardware. Metasearch aggregators expose clean result APIs. Filesystem indexers answer "where is this file" in milliseconds. Reciprocal rank fusion [3] merges ranked lists from multiple providers without training. The gap is not capability. The gap is an architecture that uses the cheap deterministic components by default and reserves the expensive probabilistic component for the cases that actually require it.

### 1.2 Motivation

I built Mister Fetch to occupy that design point for a single, narrow query shape: *"I cannot find X, go get it."* One-off, concrete, answer-or-file-location as the payload, seconds to at most a minute of work, then done. The constraint that every Fetch exists to finish and stop, rather than to retain a user, removes the incentive that produces engagement layers. It also creates a natural place to be honest about effort: if the unit of work is disposable and short-lived, its internal state can be shown to the user without overwhelming them, and its failure can be reported cleanly instead of hidden behind a confident summary.

### 1.3 Position Statement

This is an argument-driven paper. It advances four positions rather than testing numbered hypotheses. Each is a claim about design, and each has an associated empirical test that I have not yet run (§6).

- **P1, Deterministic-first routing.** For the target query class, most queries can be answered without invoking a language model at all. The model should be the last tier of an escalation ladder, not the first.
- **P2, Observable agent state.** Exposing an agent's task pressure as a live, labeled signal is more useful and more honest than an opaque progress indicator, and the same signal can drive the agent's own behavior.
- **P3, Lexical evidence coverage.** Checking meaningful terms and normalized numbers against successful tool output is a tractable runtime gate for absent-evidence errors. It does not establish semantic entailment.
- **P4, Disposable context.** Destroying a unit of work's memory on completion prevents situational state from one query contaminating another, at an acceptable cost.

### 1.4 Scope and Contributions

I contribute:

1. A runtime design in which a query becomes a disposable agent over a tiered, deterministic-first toolchain (§2.1, §2.2).
2. A formal task-pressure signal, the Anguish meter, with explicit pressure and relief dynamics, behavioral bands, temperature scheduling, and spawn-tree propagation rules (§2.3, §2.4).
3. An evidence-coverage validator that gates completion on normalized lexical support (§2.5).
4. A working open-source implementation (TypeScript, Node 22) split into a provider-agnostic engine and a terminal interface (§2.7).
5. A pre-declared evaluation plan for routing, validation, calibration, and user-facing behavior (§6).

### 1.5 Scope and Limitations

I make no performance claim. I have run no representative latency benchmark, validator corpus evaluation, calibration study, or user study. The local-search adapters are Windows-first. Automated suites cover pure Anguish invariants, validator boundaries, budget accounting, rank fusion, security boundaries, and supervisor lifecycle behavior. Two Quality-mode components, the result picker and deep body extraction pipeline, remain stubbed. The system targets a narrow query class outside general web portals, conversational assistants, and persistent automation agents. Mechanism claims in this paper are limited to properties covered by code and tests unless a measurement is cited.

---

## 2. Architecture

### 2.1 The Fetch primitive

A Fetch is a single-shot, scope-locked, memory-ephemeral agent created to complete exactly one task and then terminate. On spawn it receives a minimal system prompt, the task string, a toolset scoped to its task class, and an empty context window. It inherits no prior conversation. It returns a single structured payload, status, result, tool-call log, final Anguish value, duration, and identifier, and its working context is then discarded.

Two properties follow from the primitive. First, scope is locked: a Fetch must refuse instructions that materially expand its original task, and surfaces a "summon another Fetch" suggestion instead. Scope creep is the mechanism by which a disposable unit becomes a persistent one, so it is forbidden at the prompt level. Second, identity is cheap and traceable: each Fetch carries a two-letter, one-digit designation (for example, `FETCH KT-4`) that appears in logs and failure reports, so blame attaches to a named unit rather than to an undifferentiated "the agent."

### 2.2 The escalation ladder

Within a Fetch, work climbs four tiers, cheapest first:

1. **Action-keyword fast path.** A task prefixed `f:`, `g:`, `dg:`, `open:`, or `w:` dispatches a single tool directly, with no language model, no triage, and no Anguish accounting. In the implementation this resolves on the same tick the query is entered.
2. **Deterministic tool execution.** Web search, web fetch, local filename index, content grep, and rich-document grep run as ordinary tools whose output is structured data, not model output.
3. **Light local language model.** When deterministic tools do not resolve the query, the worker reasoning loop runs: the model proposes a tool call, a parallel set of calls, a completion, or a give-up, and the loop executes and feeds back results.
4. **Heavier mode.** An explicit, opt-in tier (quality mode) raises the iteration and tool budget and, when complete, will add an LLM result-picker and deep body extraction.

The same deterministic-first discipline applies recursively inside tier 3: a Fetch is expected to try a cached answer, then a deterministic API, then a known-selector scrape, before it leans on the model to synthesize. P1 is the claim that, for the target query class, tiers 1 and 2 absorb most traffic.

The product charter [internal: `SUPREMACY.md`] frames the deterministic tiers as three pillars: a deterministic web layer that fans queries across providers and merges them with reciprocal rank fusion [3]; a deterministic local layer over an Everything-class filename index, ripgrep for content, and ripgrep-all for documents; and an LLM synthesis layer reached only on escalation.

### 2.3 The Anguish meter

Every Fetch tracks a scalar A ∈ [0,1] representing task pressure. A is initialized at spawn (0 for fresh work, or inherited; see below) and evolves as the difference between continuous pressure and discrete relief.

Instantaneous pressure is a weighted sum:

```
pressure(t) = w_t·P_time + w_r·P_retry + w_b·P_budget + w_a·P_ambig + w_s·P_silence
```

with the terms defined as:

| Term | Definition | Meaning |
|---|---|---|
| `P_time` | `(t - t_start) / T_nominal` | Linear in elapsed time, normalized by the nominal duration estimate. |
| `P_retry` | `Σ_i n_i^β`, `β > 1` | Convex in retries per subproblem. Successive same-key retry increments grow. |
| `P_budget` | `clamp(spent/estimate, 0, 1)` | Bounded fraction of the tool budget consumed. Every attempted tool call increments `spent`; the term reaches 1 at the hard cap. |
| `P_ambig` | `count(unresolved ambiguities)` | One increment per unresolved ambiguity. |
| `P_silence` | `(t - t_requested) / T_nominal` when input was requested, else 0 | Active only while a question to the user sits unanswered. |

Relief is discrete, event-driven, band-scaled, and time-decaying according to a configured half-life. A completed subgoal applies `−δ_sg`; a clean tool return applies `−δ_ts`; a user confirmation applies `−δ_uc`; a measurable decrease in distance-to-goal applies `−δ_pr`. The score at query time is:

```
A(now) = clamp( A_0 + pressure(state, now) − relief(state, now), 0, 1 )
```

A can fall after relief and rise again as relief decays. The retry term grows superlinearly in attempts per subproblem (exponent β > 1), so a Fetch repeating one key accumulates pressure faster than one distributing the same retry count across independent keys.

`A` is a dimensionless control score. It carries no probability, confidence, remaining-work, or utility interpretation. The shipped weights are design parameters with structural invariant tests and no workload calibration. Calibration requires a versioned task corpus and reported sensitivity of completion, terminal, latency, and intervention rates to parameter changes.

Four behavioral bands partition the range: **calm** (A < 0.30), **alert** (0.30 ≤ A < 0.60), **urgent** (0.60 ≤ A < 0.85), and **terminal** (A ≥ 0.85). A Fetch that reaches A ≥ 0.95 without progress must do one of three things: request explicit scope reduction, escalate the decision to the user, or self-terminate with an honest failure status. Silent degradation past that threshold is defined as a runtime bug, not a behavior.

Anguish propagates down a spawn tree and never up. A child spawned by a parent at `A_parent` inherits `A_0 = γ·A_parent` (default `γ = 0.5`), so a stressed parent produces pre-stressed children, which is correct because the situation is stressed. A child's pressure is never read by its parent. This asymmetry is deliberate: the alternative is a feedback loop in which stressed children stress their spawner.

P2 is the claim that this signal is dual-purpose. It regulates the agent (via band-dependent behavior and the scheduling in §2.4) and it informs the user (via the live display in §2.6). The naming is part of the design: an internal signal called "Anguish" is treated as a state to regulate and to resolve cleanly, where a signal called "urgency budget" invites being hoarded and spent.

### 2.4 Prompt and temperature scheduling

The model-facing system prompt and the sampling temperature are functions of the current band. Low-A prompts emphasize correctness and verification; high-A prompts explicitly authorize unconventional, ugly-but-viable approaches and, in the terminal band, instruct the Fetch to return any defensible result or fail cleanly. The implementation maps bands to temperatures of 0.2 (calm), 0.5 (alert), 0.8 (urgent), and 1.1 (terminal). This is temperature scheduling driven by a principled pressure signal rather than by a fixed configuration value.

### 2.5 The evidence-coverage validator

The validator is the mechanism behind P3. It operates at three points.

First, during the run, numeric text in user-visible chatter is checked against task context and successful tool results. This permits the Fetch to repeat a number from the question while blocking invented values.

Second, on a give-up, the stated reason is scrubbed: any unsupported numeric span is redacted before the user sees it.

Third, on completion, the final payload is checked against successful tool output only. Object and array values are flattened without treating property names as evidence. Surrounding punctuation is discarded from words. Numeric forms normalize signs, currency symbols, grouping separators, percentages, leading zeros, and trailing decimal zeros. Every meaningful term and normalized number must occur in the evidence corpus. Task text cannot ground a final answer.

The gate establishes lexical coverage. It catches absent evidence terms and unsupported numeric values. It cannot prove that a sentence follows from the evidence, detect every relation reversal, or validate a citation's interpretation. False acceptance and false rejection rates require a labeled corpus (§6).

### 2.6 Modes and the observable interface

Three modes scale the depth of a Fetch. **Speed** caps iterations at 4 and tool calls at 3 with a 45-second horizon ceiling and no reranking. **Balanced** allows 10 iterations and 7 tool calls with a 60-second ceiling and reranks search hits to the top 5 above a relevance floor. **Quality** allows 22 iterations and 14 tool calls with a 180-second ceiling, reranks to the top 3, and is the tier where the currently stubbed result picker and deep body extraction will operate. Each task class also declares a horizon; runtime uses the tighter task-class and mode value. A zero-LLM heuristic classifier selects the mode from the query, and an explicit `!speed`/`!balanced`/`!quality` prefix overrides it.

The interface renders each living Fetch as a card showing its identifier and mode, an elapsed timer, a 16-cell Anguish bar with the numeric value, the current action, and the in-character chatter line. The bar's color tracks the band. UI, smoke output, and worker behavior derive the effective horizon from one shared mode-and-task-class function. Purgatory displays `A=1.0` by contract.

### 2.7 Implementation

The runtime is two packages. `@mister-fetch/core` is the provider-agnostic, interface-agnostic engine: Anguish mathematics, triage, worker loop, supervisor, evidence validator, and tool registry. `@mister-fetch/cli` contains the Ink terminal interface plus Ollama and Anthropic provider adapters. The provider interface is a streaming-text contract with JSON-in-text parsing, which keeps the engine compatible with small local models that lack native structured tool calls.

---

## 3. Design Claims and Rationale

I report no measurements in this section. I argue why each position is plausible given the construction, and I mark the boundary of each argument.

**On P1 (deterministic-first).** The target query class is dominated by lookups whose answers are deterministic: a file's location is an index query, a definition is an API hit, a ranked list of sources is a fused metasearch result. For these, a model pass adds latency and a hallucination surface without adding capability. The action-keyword fast path and the deterministic tool tier exist so that these queries never reach the model. The strength of P1 is therefore a function of how much real traffic falls into the deterministic tiers, which is exactly the quantity §6 proposes to measure. I claim the architecture makes deterministic answering the default; I do not yet claim a hit rate.

**On P2 (observable state).** An opaque spinner conveys one bit: working or not. The Anguish bar conveys elapsed effort, proximity to giving up, and the behavioral regime the agent has entered, and it does so with a signal the agent is already computing for its own control. The marginal cost of showing it is low because it is not instrumentation added for display; it is the control variable itself. The open question is whether users find the signal legible and reassuring rather than alarming, which is a user-study question.

**On P3 (lexical evidence coverage).** Deterministic term and number checks are cheap relative to model inference and create a hard gate for absent-evidence output. The gate has known semantic limits and can reject supported paraphrases. Quality mode will widen the evidence corpus with cleaned page bodies. False acceptance and false rejection rates are unmeasured.

**On P4 (disposable context).** Destroying working context on completion means a transient condition observed during one query, for example a flaky API, cannot persist into the world model used by the next. The cost is the inability to reuse within-session learning across Fetches. The architecture accepts that cost for the target class because the unit of work is a one-off lookup, and it recovers the useful residue separately: per-task-class and per-tool success statistics are logged for tool reputation while the Fetch's inner context is discarded.

---

## 4. Discussion

### 4.1 Implications

If P1 holds in measurement, the common case carries no inference cost or latency, and model budget concentrates on queries that need synthesis. P3 provides deterministic lexical evidence coverage with measurable error rates. P2 remains a user-experience question even though display and control now share one calculation.

### 4.2 Relationship to prior work

The reasoning-and-acting loop in tier 3 is a ReAct-style interleaving of thought, tool action, and observation [1]. Retrieval supplies the lexical evidence corpus [2]. The deterministic web layer implements reciprocal rank fusion [3] with `k=60`, equal provider weights, and provider-local URL deduplication. Source weights require evaluation before adoption.

Three existing systems shaped the design and are neither dependencies nor forks. SearXNG [5] is the reference for metasearch result merging and is callable as a sidecar service rather than vendored. Perplexica [6] is the reference for treating mode as pipeline depth (speed, balanced, quality differing by iteration budget, reranking, and model choice) rather than as a prompt toggle. Flow Launcher [7] is the reference for action-keyword routing and fuzzy matching. The relationship in each case is reading the solved problem and writing an independent implementation, because a wrapper inherits the upstream's bugs and architectural ceiling along with its code. The hallucination failure mode that P3 targets is surveyed in [4].

### 4.3 Claim boundaries

The current evidence supports architectural and invariant claims. Comparative speed, accuracy, usefulness, deterministic hit rate, validator error rates, Anguish calibration, and user preference remain unmeasured. The evidence gate checks lexical coverage without proving entailment. The product scope excludes general web portals, conversational assistants, and persistent automation.

---

## 5. Conclusions

I have described an architecture for the *"I cannot find X, go get it"* query class. The language model is the last tier of a deterministic-first ladder. A bounded control score regulates the agent and drives the visible meter. A lexical validator gates final payloads on successful tool evidence. Each unit of work discards its context on completion. Structural invariants are tested; product benefit and calibration remain empirical questions.

## 6. Future Work

The following evaluation would convert the positions of §1.3 into tested claims.

1. **Deterministic hit rate (tests P1).** Instrument a representative query workload and measure the fraction resolved at tiers 1-2 with no model invocation, broken down by query type.
2. **Latency distribution (supports P1).** Measure end-to-end latency per mode, separating the deterministic path from the model path, and report the full distribution rather than a point estimate.
3. **Evidence-gate error rates (tests P3).** Construct a labeled set of supported, unsupported, paraphrased, numerically transformed, negated, and relation-reversed answers. Report false acceptance and false rejection before and after body-corpus widening.
4. **Anguish legibility (tests P2).** Run a small user study comparing the visible meter against a conventional spinner on perceived transparency and trust.
5. **Anguish calibration.** Run a versioned workload across all modes. Report completion rate, terminal rate, user intervention, time-to-band distributions, and sensitivity to each weight.
6. **Engineering work.** Implement the Quality-mode result picker and deep body extraction; port local adapters beyond Windows; and add the speculative `turbo` tier only after the measured baseline is stable.

---

## Data and Code Availability

The implementation will be released under the MIT license at `github.com/mr-gl00m/mister-fetch`; no `LICENSE` file is committed at the time of writing. No dataset is collected, distributed, or required to run the system. This manuscript is released under CC BY 4.0. The system calls external services (a configured search provider and a language-model provider) at runtime; it ships no third-party source.

## Author Contributions (CRediT)

Cid: Conceptualization, Methodology, Software, Writing, original draft, Writing, review and editing, Visualization.

## Competing Interests

None declared.

## Funding

Independent research, self-funded.

## Acknowledgments

I thank the maintainers of SearXNG, Perplexica, and Flow Launcher, whose published work clarified the metasearch, mode-tiering, and launcher problems respectively, and whom I read rather than copied.

## References

1. Yao S, Zhao J, Yu D, Du N, Shafran I, Narasimhan K, Cao Y. "ReAct: Synergizing Reasoning and Acting in Language Models." International Conference on Learning Representations (ICLR), 2023. arXiv:2210.03629.
2. Lewis P, Perez E, Piktus A, et al. "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks." Advances in Neural Information Processing Systems (NeurIPS) 33, 2020. arXiv:2005.11401.
3. Cormack GV, Clarke CLA, Büttcher S. "Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods." Proceedings of SIGIR 2009, pp. 758-759. doi:10.1145/1571941.1572114.
4. Ji Z, Lee N, Frieske R, et al. "Survey of Hallucination in Natural Language Generation." ACM Computing Surveys 55(12), 2023, pp. 1-38. doi:10.1145/3571730.
5. SearXNG contributors. "SearXNG" (software). https://github.com/searxng/searxng (no DOI available).
6. ItzCrazyKns. "Perplexica" (software). https://github.com/ItzCrazyKns/Perplexica (no DOI available).
7. Flow Launcher contributors. "Flow Launcher" (software). https://github.com/Flow-Launcher/Flow.Launcher (no DOI available).

---

## Revision History

- **v1.0 (2026-05-29):** Initial release. Architecture position paper; no empirical results.
- **v1.1 (2026-05-29):** Corrected the Anguish description to match the implementation: the state update uses the stateless-cumulative form rather than a differential step, relief is band-scaled and time-decaying, and the retry term is described as superlinear without pinning specific weights. No claims changed.
- **v1.2 (2026-07-13):** Corrected pressure definitions, documented Anguish as an uncalibrated control score, replaced semantic grounding claims with lexical evidence-coverage claims, aligned mode horizons and software versions with code, and recorded the invariant-test baseline.
