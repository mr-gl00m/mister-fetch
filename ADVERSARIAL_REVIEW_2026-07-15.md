# Adversarial Review: Mister Fetch

Date: 2026-07-15
Reviewer: adversarial code audit (read-only)
Target: `N:\proj_ai_mister_fetch` (`@mister-fetch/core` + `@mister-fetch/cli`)
Scope: first-party source under `packages/`; `node_modules`, `dist`, `.archive` ignored.

## Summary

Mister Fetch is a local-first answer engine. Each query becomes a single-shot "Fetch": a deterministic-first agent that tries no-LLM fast paths (`f:`/`g:`/`w:`), then deterministic tools (web search, ripgrep, Everything, a headless browser), then a local LLM, then deletes itself. The code is careful and the security surface has clearly been through prior hardening (SSRF guard, path jail, secret redaction, an evidence-coverage validator, per-Fetch abort controllers, atomic checkpoints). Overall health is good for a pre-release: no shell injection, no TLS disabling, no obvious prototype-pollution merge, and the tool ACL / worker guards are real. The problems concentrate where they matter most for a fetcher: the SSRF guard, which is the single security boundary for pulling remote content, has two reachable holes (one deterministic, confirmed in a repro; one classic TOCTOU), and `web_fetch` buffers response bodies with no size cap. A handful of resource-leak and hardening issues sit below that.

## Coverage

Read in full (security- and correctness-load-bearing):

- `packages/fetch-core/src/tools/ssrf.ts`, `web-fetch.ts`, `browser.ts`, `web-search.ts`, `local-path-policy.ts`, `open-path.ts`, `local-find.ts`, `local-grep.ts`, `local-doc-grep.ts`, `registry.ts`
- `packages/fetch-core/src/worker.ts`, `supervisor.ts`, `checkpoint.ts`, `validator.ts`, `action-keywords.ts`, `rank-fusion.ts`, `rerank.ts`, `identity.ts`, `provider.ts`
- `packages/fetch-cli/src/main.tsx`, `ui/app.tsx`, `anthropic.ts`, `ollama.ts`, `preflight.ts`, `smoke.ts`
- `packages/fetch-core/src/tools/ssrf.test.ts` (to confirm the SSRF gap is untested)

Sampled / skimmed, not deeply audited: `anguish.ts` (control math), `triage.ts` + `classifier.ts` + `task-classes.ts` (routing/safety classification), `modes.ts`, `persona.ts`, `phrases.ts` (cosmetic strings), `fuzzy.ts`, `types.ts`, `ui/fetch-card.tsx`, and the `*.test.ts` suites.

Not reviewed: `_examples/` (vendored reference: Flow.Launcher, etc.), `.docs/`, `.red_team/`, `.bugs/` reports.

Honesty on the 72K LOC figure: first-party TypeScript under `packages/` is roughly 6.1K non-test LOC (core ~5.7K, cli ~0.9K counting the `.tsx` files). The rest of the 72K is `_examples/` and vendored material. I read essentially all of the first-party I/O and control surface; I did not line-audit the anguish math or the triage safety classifier.

Two findings below were confirmed with an out-of-band repro (H1 via a Node replica of the guard; the rest by reading the exact code path). One prior-simplification note: my repro's first pass flagged decimal `2130706433`, but the real `ipv4ToOctets` handles the one-part decimal form, so that is NOT a bug; the confirmed bypass is the IPv6-mapped hex form only.

---

## Findings

### HIGH

#### H1. IPv6-mapped IPv4 (hex-compressed form) bypasses the SSRF blocklist and reaches loopback / cloud metadata

- Where: `packages/fetch-core/src/tools/ssrf.ts:69-91` (`isPrivateIPv6`, `isBlockedHost`) and `ssrf.ts:113-114` (the `isLiteralIp` short-circuit).
- What is wrong: `isPrivateIPv6` recognizes the IPv4-mapped form only when it is written dotted-decimal (`/^::ffff:(\d+\.\d+\.\d+\.\d+)$/`). The hex-compressed spelling of the same address is not matched, so it falls through to `return false`. Because `isIP('::ffff:7f00:1') === 6`, `assertPublicUrl` sets `isLiteralIp = true` (`ssrf.ts:114`) and skips the DNS-resolution branch entirely, so nothing else validates it. Confirmed with a replica of the guard:
  - `::ffff:7f00:1` (= 127.0.0.1): `isIP=6`, `BLOCKED=false`
  - `::ffff:a9fe:a9fe` (= 169.254.169.254, the cloud-metadata IP): `isIP=6`, `BLOCKED=false`
  - `::ffff:127.0.0.1` (dotted): `BLOCKED=true` (this is the only mapped form the test at `ssrf.test.ts:30` covers)
- Failure scenario: a page the Fetch is reading (attacker-influenced, prompt-injection into the LLM is realistic since the model reads web bodies) steers a `web_fetch` or `browser navigate` at `http://[::ffff:a9fe:a9fe]/latest/meta-data/` or `http://[::ffff:7f00:1]:xxxx/`. On a dual-stack host (default Linux, `IPV6_V6ONLY=0`) the mapped address routes to the embedded IPv4, so the request hits loopback / link-local metadata that the guard exists to block. Both `web_fetch` (`web-fetch.ts:95`) and `browser` (`browser.ts:117,216`) share this guard, so both are affected.
- Fix: canonicalize before classifying. When `isIP(host) === 6`, detect any `::ffff:` mapped address (including the hex form) and any deprecated `::a.b.c.d` compat form, extract the embedded 32 bits, and run `isPrivateOctets` on them. Do not let `isLiteralIp` skip validation for mapped addresses. Add the hex form to `ssrf.test.ts`.

#### H2. DNS-rebinding TOCTOU: the guard resolves the name, then `fetch` resolves it again independently

- Where: `packages/fetch-core/src/tools/ssrf.ts:116-129` (resolve-and-check) versus `web-fetch.ts:96` and `browser.ts:117` (the actual request). No custom dispatcher exists (grep for `dispatcher|undici|setGlobalDispatcher|createConnection` returns nothing).
- What is wrong: `assertPublicUrl` resolves the hostname with `dns.lookup(..., { all: true })` and rejects if any returned address is private. It then hands the original hostname to the global `fetch`, which performs its own, second DNS resolution. The vetted IP is never pinned to the connection. An attacker who controls the domain and serves a low-TTL record can answer the guard's lookup with a public IP and the connection's lookup with `127.0.0.1` / `169.254.169.254` / a LAN host.
- Failure scenario: the LLM is induced to fetch `http://rebind.attacker.example/`. Guard resolves it to a public IP, passes. Milliseconds later `fetch` re-resolves and connects to the internal target. Redirect hops (`web-fetch.ts:92-111`) re-check every hop, which is good, but each re-check has the same gap.
- Fix: resolve once inside the guard, then force the connection to the vetted address. Either build an undici `Agent` with a custom `lookup` that returns the already-validated IP (and set the `Host` header from the original name for TLS/SNI), or connect by IP and carry the original host in `Host`. Share one hardened dispatcher between `web_fetch` and `browser` so both go through the same pinned path.

#### H3. `web_fetch` buffers the entire response body with no size cap (memory exhaustion)

- Where: `packages/fetch-core/src/tools/web-fetch.ts:61` (`const raw = await res.text();`). `HARD_MAX_CHARS` (line 36) and the `maxChars` slice (lines 71-72) are applied only after the whole body is in memory.
- What is wrong: there is no `Content-Length` check and no byte ceiling on the read. `res.text()` buffers the full body before truncation happens.
- Failure scenario: a URL the Fetch reads (again, attacker-influenceable) returns a multi-hundred-MB body, or `Transfer-Encoding: chunked` with an endless stream. The 12s `FETCH_TIMEOUT_MS` (line 34) caps duration, but a fast server pushes hundreds of MB inside that window; V8 also throws `Cannot create a string longer than ...` past roughly 512MB, but only after undici has already buffered the bytes, so the memory spike lands either way. Repeated across concurrent Fetches this OOMs the process.
- Fix: stream the body (`res.body.getReader()`), accumulate up to a hard byte budget (a few MB), and abort the reader once the cap is hit; optionally reject early on an oversized `Content-Length`. Apply the same ceiling to the `res.text()` reads in `web-search.ts` (see L5).

### MEDIUM

#### M1. Provider stream generators ignore the abort signal, leaking the HTTP request and keeping the local model busy after kill/revive

- Where: `packages/fetch-core/src/worker.ts:166-172` (consumes `deps.provider.chat(...)` and only checks `deps.abortSignal?.aborted` between chunks), `provider.ts:8-13` (`ProviderOptions` has no signal field), `cli/ollama.ts:65-102` (fetch called with no `signal`, `reader` never cancelled), `cli/anthropic.ts:69` (`client.messages.stream` gets no abort).
- What is wrong: the AbortController the supervisor creates per Fetch (`supervisor.ts:436-437`) is never threaded into the provider call. When a Fetch is killed, released, revived on crash, or force-revived on heartbeat timeout (`supervisor.ts:342,364,598,560`), the worker's `for await` loop returns, which calls the generator's `return()`; but the Ollama generator has no `try/finally`, so `reader.cancel()` never runs and the underlying `fetch` connection is not closed. The local model keeps generating to completion on an abandoned socket.
- Failure scenario: a user kills a slow quality-mode Fetch, or the 180s heartbeat timeout revives one mid-generation. The old request keeps Ollama pinned generating tokens nobody reads; the socket lingers until GC. Under repeated kills/revivals this stacks up and starves the single local model server.
- Fix: add `signal?: AbortSignal` to `ProviderOptions`, pass `deps.abortSignal` from the worker, forward it to `fetch(...)` in `ollama.ts` and to `client.messages.stream(params, { signal })` in `anthropic.ts`, and wrap the Ollama read loop in `try { ... } finally { reader.cancel().catch(() => {}); }`.

#### M2. `local_find` passes the query to `es.exe` without a `--` option terminator

- Where: `packages/fetch-core/src/tools/local-find.ts:146-150` (`buildEsArgs`). Compare `local-grep.ts:120` and `local-doc-grep.ts:113`, which both push `'--'` before the pattern.
- What is wrong: the user/LLM-supplied `query` is appended as the final argv token with no `--` guard. `rg`/`rga` terminate option parsing with `--`; `es.exe` does not get the same treatment, so a `query` that begins with `-` is parsed by Everything as a switch. Everything's CLI includes output-writing switches (the `-export-txt` / `-export-csv` family). This is argument injection, not shell injection (args are an array, `spawn` without a shell), and it is constrained: `query` is a single argv token, so smuggling a flag plus a separate filename token is awkward. Still, `rg`/`rga` were hardened and `es` was not, and `es` is the one of the three with side-effecting flags.
- Failure scenario: a prompt-injected Fetch calls `local_find` with a `query` starting `-` to coax `es.exe` into a non-search mode or an error that leaks environment detail. Low practical blast radius, but the guard is one line and its siblings already have it.
- Fix: insert `args.push('--')` before `args.push(query)` in `buildEsArgs`, or reject a `query` whose first non-space char is `-`. (Verify `es.exe` honors `--`; if not, use the reject approach.)

### LOW

#### L1. Local search tools accumulate child-process stdout unbounded before the parse cap

- Where: `local-find.ts:171-173`, `local-grep.ts:143`, `local-doc-grep.ts:136` (`stdout += chunk.toString('utf8')`). The match cap (`--max-count`) and the `limit` slice in the parsers stop at N results, but the process keeps streaming and the buffer keeps growing until `close`.
- What is wrong: `rga` running preprocessors over a huge archive, or `rg` over a file with enormous matched lines, can produce far more stdout than the eventual `limit` uses. Bounded by the per-tool timeout (5s / 15s / 45s), so it is a soft ceiling, not unbounded forever.
- Fix: track a byte budget in the `data` handler and `proc.kill()` once it is exceeded, or stop reading after `limit` match events are seen.

#### L2. Anthropic default model id is hardcoded and unvalidated

- Where: `cli/main.tsx:25,45` and `cli/anthropic.ts:16` default to `claude-opus-4-6`. Preflight for Anthropic only checks that the key is non-empty (`preflight.ts:24-29`), never that the model resolves.
- What is wrong: if that model id is not valid for the account, every Anthropic-backed Fetch fails at the first provider call, and the worker reports it as a generic provider error after `PROVIDER_ERROR_LIMIT` (`worker.ts:185-193`), masking the real cause (a bad default model name).
- Fix: require `MISTER_FETCH_MODEL` when `ANTHROPIC_API_KEY` is set, or have preflight do a cheap model-list / minimal call to confirm the id before the TUI renders.

#### L3. Checkpoint temp file is a fixed per-id name; unawaited writes can interleave

- Where: `checkpoint.ts:26-33` (`const tmp = final + '.tmp'`). The supervisor calls `void this.checkpoint.write(...)` without awaiting in many spots (`supervisor.ts:352,374,408,475,539,580,593,613,639,655`), and the worker's `onUpdate` also writes.
- What is wrong: the write is atomic against readers (write-tmp then rename), but two overlapping writes for the same id share one `.tmp` path. Because the calls are fire-and-forget, a later `writeFile` can truncate the tmp while an earlier `rename` is in flight. On Windows this can surface as an EPERM on rename or a torn tmp being renamed into place. The single-worker-per-id invariant makes this rare, but `release`/`kill`/`tickPurgatory`/`onWorkerExit` can each fire a write near the same instant.
- Fix: give the tmp a unique suffix (`.${process.pid}.${rand}.tmp`) and rename that, or serialize writes per id behind a small promise chain.

#### L4. `validator.walk` has no cycle guard

- Where: `validator.ts:253-264`. Unlike `appendCorpusValues` (`validator.ts:85-109`), which carries a `WeakSet` seen-set, `walk` recurses without one.
- What is wrong: a self-referential `resultPayload` would infinite-loop / stack-overflow the validator. In practice `resultPayload` comes from `JSON.parse` of model output or from plain tool-result data, neither of which produces cycles, so this is defensive only.
- Fix: pass the same `WeakSet<object>` pattern into `walk`.

#### L5. Search-provider bodies are read unbounded (same class as H3, lower reach)

- Where: `web-search.ts:389` (DDG `res.text()`), `web-search.ts:257` and `301` (`res.json()`), `preflight.ts:46`.
- What is wrong: no byte ceiling on these reads. The hosts are semi-trusted (DDG, the user's own SearXNG, Tavily/Brave), so the reach is lower than H3, but a compromised or MITM'd endpoint could balloon memory.
- Fix: apply the same streamed byte-cap read used for the H3 fix.

---

## Design-level concerns

- The SSRF guard is the entire security boundary for remote fetching, and it currently leans on OS dual-stack behavior plus a string-shaped blocklist. H1 and H2 are two independent holes in that one wall. The durable shape is: resolve the name once, canonicalize the address (mapped/compat IPv6 folded to IPv4, all numeric IPv4 forms folded to octets), classify the resolved IP, then pin that exact IP onto the outbound connection through a single shared undici dispatcher that both `web_fetch` and `browser` use. That closes rebinding and the address-notation gaps together, and it gives one place to test.

- Fail-open config switches. `MISTER_FETCH_ALLOW_WIDE_LOCAL=1` disables the local-path jail wholesale (`local-path-policy.ts:34`), and `OLLAMA_ALLOW_REMOTE=1` permits prompt/tool-log egress to a remote model (`ollama.ts:25`). Both are opt-in and documented in the error strings, which is the right posture, but they are the two switches that turn a local-only tool into something with real exfiltration surface. Worth a single "danger switches" note in the README so nobody sets them casually.

- Unbounded Fetch concurrency. `spawn` (`supervisor.ts:120`) has no ceiling on living Fetches; an orchestrator fan-out (`spawnOrchestrator`, bounded only by triage decomposition) or a user pasting several tasks can launch many concurrent workers, each potentially opening a browser context (`browser.ts:108`). Acceptable for a single-user local tool since Ollama serializes anyway, but a `maxLiving` cap would keep a runaway decomposition from spawning a browser-context pile-up.

- The worker correctly refuses `open_path` from the LLM loop (`worker.ts:236-244,290-298`); `open_path` is reachable only via the user-typed `open:` fast path (`action-keywords.ts:97-101`), and `open-path.ts:64` defaults `reveal` to true for files, so the default is reveal-in-Explorer rather than launch-the-default-handler. That is the safe default; the only way to make `open_path` execute a file is a user typing `open:` with an explicit `reveal:false`, which is user intent. No change needed, noted so the gating is on record.

- Secret redaction (`checkpoint.ts:92-142`) covers task, chatter, tool args, errors, and omits result payloads from disk entirely, and the providers never log the key. That part is solid; the gap is at the transport boundary (H2/H3), not the logging boundary.
