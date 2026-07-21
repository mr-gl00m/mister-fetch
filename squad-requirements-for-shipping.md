# Squad Requirements for Shipping

What Mister Fetch must expose so a finished Fetch runs as a subagent backend inside Squad Code. Written 2026-07-18 against Squad Code v1.9.0 source (`N:\proj_ai_squad_code`, branch `release/v1.9.0`) and FETCH.md in this repo. Every claim about Squad behavior below was read from the cited file, not recalled. If Squad's `src/providers/external-cli.ts`, `src/agents/spawn.ts`, or `src/prompts/subagent.ts` change, re-verify before trusting this.

The short version: Squad already speaks Fetch. The status taxonomy is FETCH §11 lifted verbatim (`src/agents/types.ts`), memory ephemerality is FETCH §8 (working messages are discarded, only the report crosses back), designations are FETCH §10 (two letters, one digit, unique among the living). What remains is a thin CLI contract on the Fetch side, listed as R1 to R8 below.

## How Squad runs an external agent

Squad's `Agent` tool spawns a subagent from a definition that names a provider and model. When that model resolves to a catalog row with `kind: "external-cli"`, Squad does not stream tokens. It shells out (`src/providers/external-cli.ts`):

- **One-shot.** The child runs its own loop with its own tools, prints a final result, and exits. Squad folds stdout into a single assistant turn. No tool calls flow back through Squad; token usage reports as zero.
- **Prompt delivery.** The prompt is either appended as the final argv element (`prompt_via: "arg"`, the default) or written to stdin then closed (`prompt_via: "stdin"`).
- **Prompt contents.** Squad concatenates the subagent system prompt and the task, joined by blank lines. The system portion includes Squad's trust boundary text, the hard scope lock (mirrors FETCH §3, instructs `SCOPE_REFUSED` in BLOCKERS), and the five-section report contract from `src/prompts/subagent-output-format.md`. So the child receives a full brief, not a bare task string.
- **stdout parsing.** `parse.mode: "raw"` takes trimmed stdout. `parse.mode: "json_path"` does `JSON.parse(stdout)` then walks a dot path (for example `"result"`) to a string. Malformed JSON falls back to raw.
- **Exit semantics.** Exit 0 means success. Nonzero exit, spawn failure, or timeout produces the canonical error `EXTERNAL_CLI_FAILED`, whose message carries the exit code and the first 500 characters of stderr. On that path **stdout is discarded**; whatever report the child printed never reaches the parent.
- **Timeout.** SIGTERM at `timeout_ms`, default 600 000 ms. A parent abort (Ctrl-C, kill picker) also SIGTERMs the child.
- **Environment.** The child env is sanitized. Only variables named in `pass_env` survive. Nothing is inherited by default.
- **Working directory.** When the agent definition requests `isolation: worktree`, Squad creates a fresh git worktree and sets the child's cwd to it (`src/agents/spawn.ts`). The parent diffs the worktree afterward to decide what to merge.

After the run, Squad parses the final text into a structured report and stamps a status (`src/agents/spawn.ts`, `src/prompts/subagent.ts`):

- `scope_refused` when a BLOCKERS bullet or any line of the raw output starts with `SCOPE_REFUSED` (case-insensitive, underscore or space).
- `failed_unfulfilled` when the run errored (nonzero exit, crash, timeout).
- `completed` otherwise.
- `user_killed` / `user_released` are stamped by Squad's kill paths and are not Fetch's concern.

## Requirements

**R1. Headless one-shot entry.** A non-interactive invocation that summons exactly one Fetch for one task and terminates: no TTY assumptions, no prompts, no lingering process. FETCH §2 already promises this lifecycle and §15 makes CLI-first the build order; this is that entry point, exposed as a stable argv command.

**R2. Prompt intake.** Accept the task as the final argv element, stdin, or both, and document which. The input is the full brief described above (Squad's system text plus the task), so the entry must treat everything it receives as the task brief rather than assuming a one-line query. The §9 interactive API (prefixes, `/complete`, `/roster`) can stay; Squad never uses it.

**R3. stdout discipline.** stdout carries the result payload and nothing else. All chatter, progress, and anguish theater goes to stderr (which is also where Squad reads error text from on failure, first 500 characters). In JSON mode stdout must be exactly one JSON document.

**R4. Payload shape.** Emit the FETCH §2 return payload as JSON on stdout:

```json
{ "status": "completed", "result": "...", "tool_calls": 7, "anguish_final": 0.12, "duration": 8.3, "fetch_id": "KT-4" }
```

with `result` containing the five-section markdown report Squad parses:

```markdown
### SUMMARY
One paragraph: what was fetched and the answer.

### EVIDENCE
- bullet per source or tool output that grounds the answer

### CHANGES
None.

### RISKS
None.

### BLOCKERS
None.
```

Section headings are matched as `### HEADING` case-insensitively; bullets are `- ` lines; a lone `None.` marks an intentionally empty section. The parser is tolerant (missing sections collapse the whole text into SUMMARY, and `raw` always survives), but emitting the sections properly is what makes the parent's report panel useful. Squad's catalog row then uses `parse: { "mode": "json_path", "json_path": "result" }`. Squad currently reads only `result`; see the deferred list for the rest of the payload.

**R5. Exit codes.** Exit 0 whenever a usable report was produced, which includes `scope_refused` and honest `failed_unfulfilled` / `anguish_terminal` runs that still wrote their report. Exit nonzero only when there is no usable report (crash, no output, internal timeout). This matters because of the stdout-discard rule above: a Fetch that exits 1 while printing a beautiful failure report has thrown that report away. Dying honestly (§4) means dying with exit 0 and the failure narrated in SUMMARY and BLOCKERS. Also finish comfortably inside the configured `timeout_ms`; a SIGTERM death is a lost report too.

**R6. Scope refusal marker.** On a §3 refusal, lead a BLOCKERS bullet with `SCOPE_REFUSED` and exit 0. That exact marker is what flips Squad's record to `scope_refused`.

**R7. Declared environment.** Document every environment variable the headless entry needs (API keys, index paths, config overrides). The child env is scrubbed, so each one must be listed in the catalog row's `pass_env` or the run fails in ways that look like Fetch bugs.

**R8. cwd confinement.** Resolve all file reads and writes relative to the process cwd. Under worktree isolation the cwd is the sandbox; absolute paths that escape it break the parent's diff-and-merge review and violate the isolation contract.

## Status mapping

| Fetch outcome (§11) | Exit code | Report | Squad record status |
|---|---|---|---|
| `completed` | 0 | sections, BLOCKERS `None.` | `completed` |
| `scope_refused` | 0 | `SCOPE_REFUSED` leads BLOCKERS | `scope_refused` |
| `failed_unfulfilled` | 0 | failure narrated in SUMMARY + BLOCKERS | `completed` (see note) |
| `anguish_terminal` | 0 | same, with the §4 honest-death report | `completed` (see note) |
| crash / no report | nonzero | discarded | `failed_unfulfilled` |

Note: Squad currently infers status only from exit code and the scope marker, so a reported-but-failed Fetch lands as `completed` at the record level with the failure visible in the report body the parent model reads. Closing that gap is Squad-side work (below), not a reason to start exiting nonzero on honest failures.

## Implementation status (2026-07-21)

R1 to R8 are implemented by `packages/fetch-cli/src/headless.ts` (built to `packages/fetch-cli/dist/headless.js`). Intake contract (R2): the task is argv joined; stdin is read to close only when argv carries no task, so a pipe left open can never hang an argv invocation. Both `prompt_via` modes therefore work. Headless state is a per-run temp directory wiped on exit; `MISTER_FETCH_STATE_DIR` is ignored so a headless run can never cross-contaminate an interactive session's Fetches. A Fetch that parks in purgatory is auto-released (headless has no BOSS to beg) and its parked reason and evidence feed the report. An internal deadline (`MISTER_FETCH_DEADLINE_MS`, default 480000) releases a stuck run and emits the failure report with exit 0, comfortably inside Squad's `timeout_ms`.

R7 environment variables the headless entry reads:

- `MISTER_FETCH_MODEL`: model id (default `hermes3:latest`; default `claude-opus-4-6` when `ANTHROPIC_API_KEY` is set)
- `MISTER_FETCH_OLLAMA_URL`: Ollama base URL (default `http://127.0.0.1:11434`); `OLLAMA_ALLOW_REMOTE=1` to permit a non-local URL
- `ANTHROPIC_API_KEY`: optional; switches the provider from Ollama to the Anthropic API
- `SEARXNG_URL`, `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY` (alias `BRAVE_API_KEY`): web-search providers; without one, search falls back to the brittle DuckDuckGo scraper
- `MISTER_FETCH_RG_PATH`, `MISTER_FETCH_RGA_PATH`, `MISTER_FETCH_ES_PATH`: explicit binary paths for ripgrep, ripgrep-all, and Everything's `es.exe`; without them the tools resolve via `PATH`
- `MISTER_FETCH_ALLOWED_ROOTS`, `MISTER_FETCH_ALLOW_WIDE_LOCAL`: local path policy for the local-search tools
- `MISTER_FETCH_DEADLINE_MS`: internal deadline described above

On Windows also pass `PATH` (binary resolution) and `SYSTEMROOT` (Node networking) through `pass_env`, since the child env is scrubbed.

## Wiring samples

Catalog row the user adds to `~/.squad/models.json` (schemas are strict; unknown keys are rejected; `base_url` is required by the schema and ignored for this kind):

```json
{
  "models": [
    {
      "id": "mister-fetch",
      "provider_id": "mister-fetch",
      "kind": "external-cli",
      "base_url": "http://localhost",
      "external_cli": {
        "command": ["node", "N:/proj_ai_mister_fetch/packages/fetch-cli/dist/headless.js"],
        "prompt_via": "stdin",
        "parse": { "mode": "json_path", "json_path": "result" },
        "timeout_ms": 900000,
        "pass_env": ["PATH", "SYSTEMROOT", "MISTER_FETCH_MODEL", "MISTER_FETCH_OLLAMA_URL", "SEARXNG_URL", "TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY", "MISTER_FETCH_RG_PATH", "MISTER_FETCH_RGA_PATH", "MISTER_FETCH_ES_PATH", "MISTER_FETCH_ALLOWED_ROOTS", "MISTER_FETCH_DEADLINE_MS"]
      }
    }
  ]
}
```

That command array is the whole coupling surface.

Agent definition at `.squad/agents/fetch.md` (project) or `~/.squad/agents/fetch.md` (user). Frontmatter keys are exactly `name`, `description`, `whenToUse`, `tools` (inline comma list or flow array only), `model`, `provider`, `isolation`; the body becomes the system prompt:

```markdown
---
name: fetch
description: Single-shot scope-locked retrieval via Mister Fetch
whenToUse: One concrete lookup or retrieval task with a definite answer
model: mister-fetch
provider: mister-fetch
---
You are a dispatcher for a Mister Fetch run. Pass the task through faithfully.
```

The `name` enters the Agent tool's `subagent_type` enum, so the parent model launches it with `subagent_type: "fetch"`. Add `isolation: worktree` to the frontmatter only for Fetches that write files.

## Verification checklist

1. Run the R1 entry by hand with the exact catalog argv, piping a task on stdin. Confirm: one JSON document on stdout, chatter on stderr, exit 0, process gone.
2. Feed it a brief that includes Squad's scope-lock text plus a task. Confirm the extra text does not derail parsing (R2).
3. Trigger a §3 refusal. Confirm exit 0 and `SCOPE_REFUSED` leading BLOCKERS in `result` (R6).
4. Add the catalog row and agent def, launch `squadcode`, and prompt the parent to fan the task to the `fetch` subagent. Confirm the panel card appears, the run terminates, and the parent transcript shows the five sections under the `[subagent KT-x (fetch) -> completed; model mister-fetch/mister-fetch]` header.
5. Kill the entry mid-run (nonzero exit). Confirm the parent sees `SUBAGENT_FAILED_UNFULFILLED` and the stderr excerpt.
6. With `isolation: worktree`, confirm all writes landed in the worktree and the parent checkout is untouched (R8).

Items 1 to 3 verified 2026-07-21 against the built entry: argv and stdin intake, one JSON document on stdout with chatter on stderr, exit 0 on completed, failed, purgatory-released, deadline-released, and scope-refused runs, `SCOPE_REFUSED` leading BLOCKERS on triage refusal, and no leftover temp state. Items 4 to 6 need a live `squadcode` session.

## Deferred, Squad-side, not Fetch's job

- Ingesting the payload's `status`, `anguish_final`, and `fetch_id` instead of inferring from exit code and markers. Until then the panel's anguish meter for external runs is time-based only, since no tool events flow back.
- The live multi-provider vetting smoke (three subagents on three API providers), still the open v1.3.0 follow-up on the Squad side.

Tracked in the Squad repo; nothing here blocks Fetch work.
