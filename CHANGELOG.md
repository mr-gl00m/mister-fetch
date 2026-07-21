# Changelog

All notable changes to this project will be documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-21

First public release.

### Highlights
- Every query spawns a single-shot, scope-locked, memory-ephemeral agent (a Fetch) that tries deterministic tools first, reaches for a local LLM only when they fall short, and deletes itself on completion or release: context destroyed, checkpoint removed, no trace.
- The Anguish meter is the spine: visible task pressure that drives behavior, prompt scheduling, and sampling temperature. A Fetch that cannot close its task parks in purgatory and begs for release instead of degrading silently.
- Headless one-shot entry for embedding in other agent systems (built against the Squad Code external-cli contract): task in via argv or stdin, one JSON payload on stdout, all chatter on stderr, exit 0 whenever a usable report exists.

### Added
- No-LLM fast paths (`f:` find, `g:` grep, `dg:` doc-grep, `open:`, `w:` web) that dispatch a tool directly and answer instantly.
- Deterministic tool belt: web search (SearXNG, Tavily, or Brave, with a DuckDuckGo fallback), page fetch with HTML-to-text extraction, a pre-warmed Playwright browser, and Windows-first local search adapters over Everything, ripgrep, and ripgrep-all.
- Three modes (`speed` / `balanced` / `quality`) scaling iteration budget, tool budget, time horizon, and rerank depth, with an automatic mode classifier and `!mode` overrides.
- Evidence-coverage validator: meaningful terms and normalized numbers in a final payload must occur in successful tool output, or the completion is rejected and the Fetch keeps working.
- Live Ink TUI with per-Fetch anguish cards, purgatory panel with release and continue controls, and serial-numbered designations for load-bearing blame.
- Crash revival with a rebased anguish clock, so downtime is not counted as suffering, plus heartbeat monitoring and a crash-loop backstop.
- Ollama as the default provider with an optional Anthropic API provider; provider streams abort when a Fetch is killed or released.
- Hardened boundaries: SSRF host guard on web fetch and browser, local path policy for disk search, and secret redaction in on-disk checkpoints.

[0.1.0]: https://github.com/mr-gl00m/mister-fetch/releases/tag/v0.1.0
[Unreleased]: https://github.com/mr-gl00m/mister-fetch/compare/v0.1.0...HEAD
