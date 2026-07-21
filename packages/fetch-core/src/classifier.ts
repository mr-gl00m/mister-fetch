import type { FetchMode } from './types.js';
import { DEFAULT_MODE } from './modes.js';

/**
 * Lightweight, zero-LLM query classifier. Picks a FetchMode from the task
 * string using deterministic heuristics. The shape is intentionally simple
 * so an LLM-backed classifier can be swapped in later without changing
 * callers — just replace the body of classifyMode() with an async call
 * and await it in the supervisor.
 *
 * Rules of thumb:
 *   • Short factual lookups → speed
 *   • Compose / synthesize / deep-research verbs → quality
 *   • Everything else → balanced (DEFAULT_MODE)
 *
 * Explicit user overrides (via !speed / !balanced / !quality prefix on the
 * task string, or an explicit `override` argument) always win.
 */

const QUALITY_VERBS = [
  /\bdeep(?:[- ]dive)?\b/i,
  /\bcomprehensive\b/i,
  /\bthorough(?:ly)?\b/i,
  /\bin[- ]depth\b/i,
  /\bsynthes(?:ize|is)\b/i,
  /\bresearch\b/i,
  /\banalyze\b/i,
  /\banalysis\b/i,
  /\bcompare (?:and contrast|across)\b/i,
  /\bwrite (?:up|a report|a summary|an essay)\b/i,
  /\bcite\b/i,
  /\bcitations?\b/i,
  /\bmulti[- ]source\b/i,
  /\btake your time\b/i,
];

const SPEED_VERBS = [
  /^(?:what|when|where|who|how many|how much)\b/i,
  /^(?:find|look ?up|get me|give me)\b.{0,60}$/i,
  /\bquick(?:ly)?\b/i,
  /\bone[- ]?liner\b/i,
  /\bjust the (?:url|link|number|name|address|phone|hours)\b/i,
  /^(?:url for|link to|phone for|hours of|address of)\b/i,
];

const OVERRIDE_RE = /^\s*!(speed|balanced|quality)\b\s*/i;

/**
 * Strips a leading `!mode` override from a task string if present.
 * Returns { mode: FetchMode | null, task: string }.
 */
export function extractModeOverride(raw: string): { mode: FetchMode | null; task: string } {
  const match = OVERRIDE_RE.exec(raw);
  if (!match) return { mode: null, task: raw };
  const mode = match[1]?.toLowerCase() as FetchMode | undefined;
  if (mode !== 'speed' && mode !== 'balanced' && mode !== 'quality') {
    return { mode: null, task: raw };
  }
  return { mode, task: raw.slice(match[0].length) };
}

/**
 * Classify a task string into a FetchMode. If an explicit override is
 * passed it wins unconditionally; otherwise the heuristic runs.
 */
export function classifyMode(task: string, override?: FetchMode | null): FetchMode {
  if (override) return override;

  const trimmed = task.trim();
  if (!trimmed) return DEFAULT_MODE;

  for (const re of QUALITY_VERBS) {
    if (re.test(trimmed)) return 'quality';
  }

  // Short + factual pattern → speed
  if (trimmed.length <= 80) {
    for (const re of SPEED_VERBS) {
      if (re.test(trimmed)) return 'speed';
    }
  }

  return DEFAULT_MODE;
}

/**
 * Convenience: extract any !mode override AND run the heuristic in one call.
 * Returns both the cleaned task string and the chosen mode.
 */
export function classifyTask(raw: string): { task: string; mode: FetchMode } {
  const { mode: override, task } = extractModeOverride(raw);
  return { task, mode: classifyMode(task, override) };
}
