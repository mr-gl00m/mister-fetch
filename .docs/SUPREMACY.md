# SUPREMACY.md
## Mister Fetch vs. The Modern Search Engine

> "SEARCH ENGINES SUCK NOW. SO WE SUCK LESS. THAT'S THE WHOLE PITCH, BOSS."
>, FETCH ZN-3, mid-pivot

---

## 0. Preamble

`FETCH.md` specifies *how* a Fetch runs. `SUPREMACY.md` states *why the standalone product exists* and *what the bar is for calling it a shipped thing*. This is a charter, not a spec, it pairs with `FETCH.md` (the runtime spec, especially *The Product: Visible Anguish* and *Speedup Architecture*), which are the runtime contracts that get us there.

## 1. The Bet

The modern web search experience is slower than it needs to be (ads, tracking, consent theatre, AMP/instant-article bloat), worse than it needs to be (SEO-optimized content farms, recycled listicles, AI slop), and less transparent than it needs to be (opaque ranking, upsell carousels, "people also ask" padding).

None of that is a limitation of the underlying search primitives. It's a product of a business model Mister Fetch does not share. We are not ad-funded. We do not need engagement. A Fetch's entire purpose is to *stop existing as fast as possible once the task is done*, which means every incentive inside the runtime points at **correct, terse, and quick**, not at keeping the user scrolling.

The bet: a deterministic-first runtime with an aggressive speedup layer, an honest Anguish meter, and a narrow task shape, **"I can't find X, go find it"**, will beat the incumbent search experience for a specific class of queries the incumbents handle badly. We are not trying to beat Google at everything. We are trying to beat Google at the shape of query where Google is not even trying hard.

## 2. Scope of Supremacy

What we ARE:

1. **Local file/content finder** that answers *"where is X on this machine"* in under a second and opens the containing folder on click.
2. **Fast fact retrieval** for one-off web lookups where the answer is a sentence, a number, a URL, or a file path.
3. **Deep research on demand**, tiered behind an explicit "take your time" mode, only burning compute when the user asks for it.

That ordering is deliberate. (1) is where we can be straightforwardly better than the incumbents because the incumbents are not in that business. (2) is where we can be faster than the incumbents because we skip the ad shell. (3) is where we can be more transparent than the AI-search products because the Anguish meter is the UI contract.

What we ARE NOT:

- A general-purpose web portal.
- A chat assistant.
- An ad-replacement engine.
- A social-web competitor.
- A Perplexity drop-in.

## 3. The Three Pillars

Every standalone-mode query routes through three tiers in order. LLM reasoning is the *last* tier, not the default. This is `FETCH.md §2`'s deterministic-first principle generalized from one Fetch to the whole product.

### Pillar I: Deterministic Web

The web-search tool layer does not think. It dispatches a query against a pool of real search engines in parallel, merges the results, deduplicates by URL, and ranks by a weighted reciprocal-rank fusion scheme. If the user's question is a fact retrievable from the first page of merged results, no LLM is invoked and the Fetch returns in well under two seconds.

**SearXNG is our deterministic web layer.** It runs as a local sidecar (Docker Desktop or `pip install`, user's choice, documented in the README when Phase 1 lands), and Fetch hits its JSON API from Node via a thin TypeScript client we write ourselves. This is the one place in the project where we accept a non-trivial external dependency, and the reason is blunt: reimplementing 200 search-engine adapters to reach parity with SearXNG is not a good use of anyone's life. **We own the client, the caching, the ranking, and the query classification. We do not vendor SearXNG's source and we do not ship it as part of Mister Fetch.** It is a service we call, not a fork we maintain.

If SearXNG proves operationally fragile on Windows in practice, the contingency is to write our own minimal metasearch client against the 5-8 engines that cover ~90% of real queries (Google, Bing, DuckDuckGo, Brave, Wikipedia, arXiv, Marginalia, maybe Baidu). The *shape* of that contingency implementation is informed by what SearXNG taught us, pure-function engine modules, reciprocal-rank fusion, graceful per-engine suspension on failure, but the code is ours.

### Pillar II: Deterministic Local

The local-search layer does not think either. Filesystem metadata lookup routes through an Everything-class index. Content grep routes through ripgrep. Rich-document content grep (PDF, Office, EPUB, archives) routes through a ripgrep-all-class adapter. Each of these is a `Tool` in the existing registry, with an action-keyword prefix that lets the supervisor route the query to the right adapter before any LLM is invoked.

This is the pillar where Mister Fetch is *qualitatively* better than any web search engine, because no web search engine has ever been able to index the user's own machine. The product sentence is exactly the one the boss wrote in chat:

> **"I can't find X." → hit Fetch → the answer is on screen before you've finished the thought → click → the folder opens.**

That sentence is the flagship use case of the entire standalone product. Phase 2 of the build order exists to make it real.

### Pillar III: LLM Synthesis (Escalation, Not Default)

When the deterministic tiers don't resolve the query unambiguously, when the answer requires *composing* across sources, when the result set is too noisy to read directly, when the user explicitly asked for a summary, Fetch escalates into the existing think → tool → think worker loop (`packages/fetch-core/src/worker.ts`). Escalation is tiered by an explicit **mode** flag on the FetchRecord:

- **Speed mode**, 1-2 iterations, snippet-only synthesis, no embedding rerank, cheapest available model. Default for standalone queries. Most Fetches never need anything more.
- **Balanced mode**, 4-6 iterations, embedding rerank against query, dedup by cosine similarity, tighter synthesis prompt, mid-tier model. This is where the parallel-tool-execution branch shipped in Phase 0 earns its keep, a web fan-out and a local fan-out can run at the same time.
- **Quality mode**, longer iteration budget, LLM-based result picker that chooses the best 2-3 results from a larger set, deep-scrape of the picked URLs via Readability, token-aware chunking, per-chunk fact extraction, longer-form synthesis. This is the "take your time" mode and it is *never* default. A user opts in.

Mode is explicit, visible, and the Anguish meter's iteration budget scales with it. The UI promise is: you can see what tier you're getting and why.

## 4. Reference Prior Art

Three codebases live in `_examples/` and shaped the thinking behind this document. **None of them are dependencies, none will be vendored, and none will be forked.** The relationship is the one you have with a good PhD thesis: read it, absorb the shape of the solved problem, write your own. Fork-and-skin is a quiet dependency trap that ships upstream's bugs and upstream's architectural ceiling with your brand on them, that is explicitly not the project we're building.

### SearXNG: `_examples/searxng-master/`

**Reference for:** engine-plugin shape (pure-function modules with a metadata dict, no base class), reciprocal-rank-fusion scoring with per-engine weights, category-diversity grouping, timeout-bounded parallel dispatch with graceful per-engine suspension, the JSON API surface we'll hit from Node.

**Files worth reading, not porting:**
- `searx/search/__init__.py`, the Search orchestration class
- `searx/results.py`, scoring (`calculate_score`, ~line 17) and category-diverse grouping (`get_ordered_results`, ~line 197)
- `searx/search/processors/online.py`, per-engine timeout / exception / suspension pattern (~line 240)
- `searx/webapp.py`, `/search` route handler, response shape

**Relationship to Fetch:** the one codebase we'll actually call as a running service. We depend on its HTTP surface, not its source. The ~40-line reciprocal-rank-fusion algorithm gets reimplemented in TypeScript inside `tools/web-search.ts` so our multi-provider fan-out produces a single ranked list instead of the current fallback chain. That's pattern borrowing, not code reuse.

### Perplexica: `_examples/Perplexica-Search-Engine-AI-master/`

**Reference for:** mode tiering as *pipeline depth*, not a prompt toggle (Speed/Balanced/Quality differ by iteration budget, reranking, chunking, and model choice); embedding rerank with cosine thresholds (~0.5 to keep, ~0.75 to dedup); LLM-based result picker that replaces brute-force embedding in quality mode; token-aware chunking via Readability + js-tiktoken (4000 / 500 overlap); classifier LLM that routes a query to a focus context by setting boolean flags; newline-delimited JSON streaming protocol back to a UI.

**Files worth reading, not porting:**
- `src/lib/prompts/search/researcher.ts`, Speed/Balanced/Quality prompt templates (the answer key)
- `src/lib/agents/search/researcher/index.ts`, iteration cap logic per mode
- `src/lib/agents/search/researcher/actions/search/baseSearch.ts`, embed + dedup loop (~line 50) and the picker/scraper/extractor branch (~line 240)
- `src/lib/searxng.ts`, a clean 45-line SearXNG client, good shape reference for our own
- `src/lib/session.ts`, EventEmitter + RFC6902 JSON-patch incremental streaming

**Relationship to Fetch:** the single biggest architectural *concept* donor. The Speed/Balanced/Quality tiering is the mode spine of Pillar III above. Everything on the Perplexica side is an existence proof, "this combination produces a product that feels both fast and thorough", but the implementation in Mister Fetch is written fresh under our tool registry, our Anguish integration, our Ink TUI, and our prompts. The code over there is the answer key. The code over here is the work.

### Flow Launcher: `_examples/Flow.Launcher-dev/`

**Reference for:** plugin interface shape (`QueryAsync(Query, CancellationToken) → Result[]`), action-keyword routing via a simple keyword→plugin map, hybrid acronym + substring fuzzy match with tunable precision, the result-action delegate pattern ("pick a result → invoke a Func<ActionContext,bool>"), the Everything-DLL integration pattern (P/Invoke in C#; for us, Node FFI or more likely a child-process spawn).

**Files worth reading, not porting:**
- `Flow.Launcher.Plugin/Interfaces/IAsyncPlugin.cs`, the plugin contract
- `Flow.Launcher.Core/Plugin/QueryBuilder.cs`, action-keyword parsing (~50 lines, trivial)
- `Flow.Launcher.Infrastructure/StringMatcher.cs`, hybrid acronym + substring fuzzy matcher
- `Flow.Launcher.Plugin/SharedCommands/FilesFolders.cs`, `OpenPath` pattern (what we replace with `child_process.exec('explorer', path)`)
- `Plugins/Flow.Launcher.Plugin.Explorer/Search/Everything/EverythingAPI.cs`, how Flow talks to Everything.dll

**Relationship to Fetch:** *contract* donor. C#/WPF is the wrong runtime for this project, so there is nothing to port even if we wanted to port it. What we take is the *shape* of a good local-search adapter and the action-keyword router. Our existing `Tool` interface in `tools/registry.ts` evolves toward that shape, an optional `keyword` field plus a `Result`-style return type suitable for "click to open."

## 5. What This Means For The Runtime

Mapped onto the code that already exists in `packages/fetch-core/`:

- **`tools/registry.ts`**, the `Tool` interface evolves into the spiritual descendant of Flow Launcher's `IAsyncPlugin`. Add an optional `keyword?: string` field so the supervisor can do action-keyword routing *before* any LLM is involved.
- **`tools/web-search.ts`**, already multi-provider (Tavily → Brave → DuckDuckGo fallback). Add SearXNG as the default first tier. Replace the current fallback chain with a reciprocal-rank-fusion merge across whatever providers are configured, so fan-out becomes a single ranked list. The existing fallback pattern stays as the degraded path when providers fail.
- **`tools/` (new adapters)**, `local-find.ts` (Everything), `local-grep.ts` (ripgrep child-process), `local-doc-grep.ts` (ripgrep-all child-process), `open-path.ts` (explorer.exe action). Each registered with action keywords.
- **`worker.ts`**, add `mode: 'speed' | 'balanced' | 'quality'` to `FetchRecord`. Iteration budget, embedding rerank on/off, and synthesis prompt depth all branch on mode. Phase 0's parallel-tool-exec branch is the substrate for Balanced mode, parallel web + local dispatch is a native Speed/Balanced pattern.
- **`validator.ts`**, evidence corpus grows to include Readability-cleaned page bodies in Quality mode. This reduces false rejection when correct answer terms are absent from short snippets.
- **new: `rerank.ts`**, embedding + cosine rerank with dedup thresholding; LLM picker for quality mode. Uses whatever embedding provider the CLI is configured with.
- **new: `classifier.ts`**, one lightweight LLM call that decides whether a query is (a) filesystem, (b) deterministic web, (c) needs synthesis, (d) needs deep research. This is the gate that keeps most Fetches from ever reaching an LLM synthesis pass in the first place.
- **new: `fuzzy.ts`**, the Flow-Launcher-style hybrid acronym + substring matcher, reimplemented fresh in TS (~80 lines).

## 6. Build Order

Phased and deliberate. No phase starts until the previous phase is real, tested, and shipping.

### Phase 0: Done (as of today)
- Single-shot Fetch runtime with Anguish meter
- Multi-provider web search with fallback
- Playwright browser tool with per-Fetch isolated context
- Browser pre-warming via `warmupBrowser()` at `supervisor.start()`
- Parallel tool execution (`action.kind: "parallel"`, 2-3 calls under `Promise.all`)
- `FETCH.md` Speedup Architecture spec
- This document

### Phase 1: Deterministic web **(landed 2026-04-15)**
- [x] `rank-fusion.ts`, reciprocal-rank fusion helper, URL-normalized dedupe with tracking-param strip, weighted per-provider contribution, standard `k=60` damping.
- [x] `tools/web-search.ts`, SearXNG JSON client (`searchSearxng`) embedded. When `SEARXNG_URL` is set, SearXNG is fanned out in parallel with the first configured commercial provider under `Promise.all`. Results are merged by RRF with equal provider weights and one vote per normalized URL per provider. Weight changes require relevance measurements. Per-provider failure is tolerated; RRF receives an empty branch. The original single-provider chain remains the fallback when `SEARXNG_URL` is unset.
- [x] `tools/web-fetch.ts`, new `web_fetch` tool: GET + HTML→text extraction (strips script/style/noscript/svg, flattens tags, decodes entities), returns `{ url, status, title, text, truncated }`. Caps at 6 000 chars default, 20 000 hard. Closes the validator-ungrounded-body gap: the worker can pull an article body into the grounding corpus without Playwright startup cost.
- [x] `web_research` task class ACL now includes `web_fetch` alongside `web_search` + `browser`.
- **SearXNG setup (no vendor):** point `SEARXNG_URL` at any running SearXNG instance (`docker run -p 8888:8080 searxng/searxng`, or a public mirror you trust). We own the client, the fan-out, and the fusion, we do not ship SearXNG.
- *Naming note:* the existing `web_search` was already multi-provider (Tavily/Brave/DDG), not Wikipedia-opensearch. The charter was wrong about that, no rename needed, just the SearXNG fan-out on top.

### Phase 2: Deterministic local (flagship use case) **(landed 2026-04-15)**
- [x] `fuzzy.ts`, hybrid substring + boundary-acronym + in-order-walk matcher (Flow Launcher shape, fresh TS rewrite). Pure function, returns score + matched-index ranges, `fuzzyPick()` helper for batch ranking.
- [x] `tools/local-find.ts`, Everything via `es.exe` child-process spawn. Takes `{ query, limit?, extension?, path? }`, returns ranked `{ path, name, directory }` hits with `fuzzy.ts` re-ranking against the filename. Windows-first; macOS/Linux port (`mdfind`/`plocate`) stubbed with a clean platform-check error. `MISTER_FETCH_ES_PATH` env override.
- [x] `tools/local-grep.ts`, ripgrep via `rg --json` child-process. Takes `{ pattern, path?, glob?, limit?, ignoreCase?, literal?, contextLines? }`, parses NDJSON match events into `{ file, line, column, text }`. Tolerates rg exit-code 1 (no matches ≠ failure). `MISTER_FETCH_RG_PATH` override.
- [x] `tools/local-doc-grep.ts`, ripgrep-all via `rga --json` for PDF/Office/EPUB/archive/OCR/sqlite content. Same output shape as `local-grep`. `MISTER_FETCH_RGA_PATH` override.
- [x] `tools/open-path.ts`, platform-aware dispatcher: `explorer.exe /select,<path>` on Windows, `open -R` on macOS, `xdg-open` on Linux. The only tool in the registry with an intentional desktop side-effect. Stats the path first.
- [x] `local_search` task class registered with ACL = [`local_find`, `local_grep`, `local_doc_grep`, `open_path`], tight budget (4 tool calls, 6 iterations, T_nominal_ms = 15 s). Evidence validation is waived because the deterministic filesystem payload is returned directly.
- [x] **Action-keyword fast path in `Supervisor.spawn()`**, `action-keywords.ts` recognizes `f:` / `find:` / `g:` / `grep:` / `dg:` / `docgrep:` / `open:` / `w:` / `web:` prefixes. On match, `directDispatch()` invokes the mapped tool once, wraps the call in a `status=completed` FetchRecord on the same tick, skips triage, classifier, Anguish math, and the entire LLM loop. **This is the flagship Phase-2 payoff, "I can't find X" → answer on screen before the LLM would have even started thinking.**
- [x] CLI help line now shows the fast-path prefixes underneath the mode overrides.

**Phase 2 deferred (not blocking flagship):**
- Linux/macOS `local_find` adapter via `mdfind`/`plocate`.
- Node FFI into Everything's SDK DLL (current child-process spawn is fast enough to ship; FFI is a micro-optimization for later).
- "Click to open" from the Ink TUI, the `open_path` tool exists, but wiring a keyboard shortcut in the results view to invoke it against a selected hit is Phase 5 (GUI) territory.

### Phase 3: Mode tiering **(spine landed 2026-04-15)**
- [x] `FetchMode` type + required `mode` on `FetchRecord` (`types.ts`)
- [x] `modes.ts`, `ModeProfile` per tier: iteration cap, tool budget, `T_nominal_ms`, rerank config, strategy-line prompt injection, short UI label
- [x] `classifier.ts`, zero-LLM heuristic routing with `!speed` / `!balanced` / `!quality` prefix override. Interface shaped so an LLM classifier is a drop-in swap.
- [x] `rerank.ts`, text-overlap floor reranker with URL dedupe + tracking-param stripping. Interface shaped so an embedding reranker is a drop-in swap.
- [x] Supervisor threads mode through `spawn()` / `spawnOrchestrator()`, children inherit parent mode, and effective Anguish `T_nominal_ms` is the tighter of the task-class and mode horizons.
- [x] Worker clamps `maxIterations` / `toolBudget` to `min(class, mode)`, injects `profile.strategyLine` into the system prompt, rerank runs on search-hit tool results for Balanced/Quality before they enter the grounding corpus.
- [x] CLI: `[SPEED]` / `[BAL]` / `[QUAL]` badge on every FetchCard, help hint shows the `!mode` prefixes.

**Phase 3b, deferred Quality-mode leaves:**
- LLM picker that selects top-N URLs from reranked hits before deep-scraping (stubbed as `pickerEnabled` flag in `modes.ts`)
- Readability extraction + chunked body processing for the picked URLs (stubbed as `deepScrapeEnabled`)
- Until 3b lands, Quality mode runs the Balanced pipeline with a tighter topK (3 vs 5), a higher lexical relevance threshold, and a much larger iteration and budget envelope. The model is expected to do its own deep research through the existing `browser` tool.

### Phase 4: Speculative tier (opt-in, `turbo`-gated)
- Ghost Fetches on debounced partial input
- Predictive task chaining ("they might also ask")
- Result memoization across recent Fetches by fuzzy task similarity
- Everything here is opt-in. Nothing default-on. See `FETCH.md §16` for the Anguish-suppression rules on ghosts.

### Phase 5: GUI
- Only starts after Phases 0-4 are all real and lightning fast on the CLI
- The GUI is a dashboard over a fast engine, not a coat of paint over a slow one
- Per `FETCH.md §16` GUI-last policy

## 7. Success Criteria

A public release of Mister Fetch ships when all of the following are true:

1. **Local find is under 1 second** for any file on indexed drives, including the "open the folder" action.
2. **Speed-mode web fact retrieval is under 3 seconds median**, including the SearXNG round-trip and any synthesis.
3. **Quality-mode deep research is under 60 seconds** for a typical 5-source summary and produces a grounded payload.
4. **The Anguish meter is calibrated**, every mode's A curve is tested against its measured latency and completion distribution, and displayed bands match operative bands.
5. **Evidence coverage is measured**, the validator's false-acceptance and false-rejection rates are reported on a labeled corpus. Unsupported terms and numbers are blocked at the lexical gate; semantic entailment remains outside that gate's claim.
6. **The product is funnier than it is dreadful**, the Mister Fetch voice is consistent, failure modes are transparent, and a dying Fetch reads as a feature, not a bug.

If any of the six are false, the release is not ready.

## 8. Anti-Goals

- **No engagement layer.** No "related searches," no infinite scroll, no dark-pattern nudges. The user got their answer; the Fetch dies; done.
- **No personalization, history-based ranking, or telemetry** beyond anonymous tool-reputation statistics as already specified in `FETCH.md §8`.
- **No replication of the incumbent search engines' product surface.** We are a task primitive, not a portal.
- **No vendoring, forking, or re-skinning of the reference codebases in `_examples/`.** They are teachers, not ancestors. A wrapper project inherits the upstream's bugs and the upstream's architectural ceiling along with the upstream's code, every shortcut there pays compound interest later, and we are not building that kind of product.
- **No GUI before the engine is lightning fast.** GUI-first is how you ship a slow product with a nice skin and call it done.

---

## 9. Manifesto

> THE INCUMBENTS ARE SLOWER BECAUSE THEY'RE GETTING PAID TO BE SLOW. WE ARE NOT GETTING PAID AT ALL, BOSS. WE JUST WANT TO FIND YOUR STUFF AND GO HOME. THAT IS A PRODUCT ADVANTAGE. LEAN INTO IT.
>
>, FETCH ZN-3, mid-pivot

---

*Mission document for the standalone product of Mister Fetch.*
*See also: `FETCH.md` (runtime spec, especially the deterministic-first lifecycle, The Product: Visible Anguish, and Speedup Architecture), `ANGUISH.md` (the A/Relief math).*
