/**
 * Action-keyword routing — the deterministic fast path for Phase 2.
 *
 * A user query like `f: report.pdf` or `g: TODO` is recognized at
 * supervisor-spawn time, BEFORE triage and BEFORE any LLM is invoked.
 * The matched keyword maps to a single tool + an args-builder, the
 * tool is called directly, and a completed FetchRecord is returned on
 * the same tick. The LLM loop is bypassed entirely.
 *
 * Shape donor: Flow Launcher's action-keyword → plugin map
 * (`_examples/Flow.Launcher-dev/Flow.Launcher.Core/Plugin/QueryBuilder.cs`).
 * Implementation is a fresh ~60-line TS rewrite under our tool-registry
 * interface.
 */

export interface ActionKeywordRoute {
  tool: string;
  args: Record<string, unknown>;
  description: string;
}

export interface ActionKeywordMatch {
  /** The tool name to invoke. */
  tool: string;
  /** The fully-built args object to pass to the tool. */
  args: Record<string, unknown>;
  /** Short human label used in the FetchRecord.currentAction field. */
  description: string;
  /** The rest of the task string after the prefix + separator was stripped. */
  rest: string;
}

/**
 * Recognized prefixes. Keys are the leading tokens (case-insensitive).
 * Aliases use the same builder. Each builder receives the REST of the
 * query (everything after the prefix + separator) and returns the
 * tool name, args, and a one-line description.
 *
 * Prefix syntax: `<keyword>:` — trailing colon is required so plain
 * English phrases like "find me a..." don't accidentally match.
 */
/**
 * Split a trailing path token off a grep-style rest string, so
 * `TODO packages/` becomes pattern `TODO` scoped to `packages/`.
 * The last whitespace-separated token counts as a path only when it
 * carries an unambiguous path shape: a separator, a bare drive letter,
 * or `.`/`..`. A bare word like `packages` stays part of the pattern;
 * write `packages/` to scope. Single-token rests are always the
 * pattern, so `g: foo/bar` still greps for `foo/bar` in cwd.
 */
function splitTrailingPath(rest: string): { pattern: string; path: string | null } {
  const m = /^(.*\S)\s+(\S+)$/s.exec(rest);
  if (!m) return { pattern: rest, path: null };
  const head = m[1] ?? '';
  const last = m[2] ?? '';
  const looksLikePath =
    /[\\/]/.test(last) || /^[A-Za-z]:$/.test(last) || last === '.' || last === '..';
  return looksLikePath ? { pattern: head, path: last } : { pattern: rest, path: null };
}

function grepArgs(rest: string, limit: number): Record<string, unknown> {
  const { pattern, path } = splitTrailingPath(rest);
  return path ? { pattern, path, limit } : { pattern, limit };
}

const ROUTES: Record<string, (rest: string) => ActionKeywordRoute> = {
  f: (rest) => ({
    tool: 'local_find',
    args: { query: rest, limit: 25 },
    description: `local_find: ${rest}`,
  }),
  find: (rest) => ({
    tool: 'local_find',
    args: { query: rest, limit: 25 },
    description: `local_find: ${rest}`,
  }),
  g: (rest) => ({
    tool: 'local_grep',
    args: grepArgs(rest, 30),
    description: `local_grep: ${rest}`,
  }),
  grep: (rest) => ({
    tool: 'local_grep',
    args: grepArgs(rest, 30),
    description: `local_grep: ${rest}`,
  }),
  dg: (rest) => ({
    tool: 'local_doc_grep',
    args: grepArgs(rest, 20),
    description: `local_doc_grep: ${rest}`,
  }),
  docgrep: (rest) => ({
    tool: 'local_doc_grep',
    args: grepArgs(rest, 20),
    description: `local_doc_grep: ${rest}`,
  }),
  open: (rest) => ({
    tool: 'open_path',
    args: { path: rest },
    description: `open_path: ${rest}`,
  }),
  w: (rest) => ({
    tool: 'web_search',
    args: { query: rest, count: 5 },
    description: `web_search: ${rest}`,
  }),
  web: (rest) => ({
    tool: 'web_search',
    args: { query: rest, count: 5 },
    description: `web_search: ${rest}`,
  }),
};

const PREFIX_RE = /^\s*([a-zA-Z]+)\s*:\s*(.+)$/s;

/**
 * Parse a raw task string. If it matches a known action-keyword prefix,
 * return the routing match. Otherwise return null — the caller should
 * fall through to normal triage + LLM-loop spawn.
 */
export function matchActionKeyword(raw: string): ActionKeywordMatch | null {
  const m = PREFIX_RE.exec(raw);
  if (!m) return null;
  const key = (m[1] ?? '').toLowerCase();
  const rest = (m[2] ?? '').trim();
  if (!rest) return null;
  const builder = ROUTES[key];
  if (!builder) return null;
  const route = builder(rest);
  return {
    tool: route.tool,
    args: route.args,
    description: route.description,
    rest,
  };
}

/**
 * Enumerate the live action-keyword prefixes for help text / UI hint.
 */
export function listActionKeywords(): readonly string[] {
  return Object.keys(ROUTES);
}
