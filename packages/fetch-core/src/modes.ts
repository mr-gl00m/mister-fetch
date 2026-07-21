import type { AnguishConfig, FetchMode } from './types.js';
import { getTaskClass } from './task-classes.js';

/**
 * Per-mode runtime profile. Each Fetch is assigned a mode at spawn time
 * (defaulting to DEFAULT_MODE) and the worker loop reads this profile to
 * set iteration caps, tool-call budget, nominal time horizon, and which
 * post-processing leaves (rerank, picker, deep-scrape) are active.
 *
 * Phase 3 ships the rerank leaf. The picker and deep-scrape leaves are
 * wired as flags here but their pipelines are deferred to Phase 3b —
 * Quality mode currently runs the Balanced pipeline with a tighter topK
 * and a deeper iteration budget.
 */
export interface ModeProfile {
  readonly mode: FetchMode;
  readonly maxIterations: number;
  readonly toolBudget: number;
  readonly T_nominal_ms: number;
  readonly rerank: {
    readonly enabled: boolean;
    /** After reranking search hits, keep at most this many. */
    readonly topK: number;
    /** Drop any hit scoring below this threshold after normalization. */
    readonly threshold: number;
  };
  /** Quality-only: whether to use an LLM picker before deep-scraping. Stubbed in Phase 3. */
  readonly pickerEnabled: boolean;
  /** Quality-only: whether to deep-scrape picked URLs with Readability. Stubbed in Phase 3. */
  readonly deepScrapeEnabled: boolean;
  /** Short human label for the UI. */
  readonly label: string;
  /** Mode-specific strategy guidance injected into the system prompt. */
  readonly strategyLine: string;
}

export const DEFAULT_MODE: FetchMode = 'balanced';

const SPEED: ModeProfile = {
  mode: 'speed',
  maxIterations: 4,
  toolBudget: 3,
  // 20s nominal put terminal anguish (1.9·T_nominal) at ~38s wall-clock — a
  // single cold local-model call blows past that before any tool runs, so the
  // fast lane died instead of answering. 45s keeps it the tightest mode (still
  // 4 iters / 3 calls) while leaving room for a local turn or two. Local-first.
  T_nominal_ms: 45_000,
  rerank: { enabled: false, topK: 10, threshold: 0 },
  pickerEnabled: false,
  deepScrapeEnabled: false,
  label: 'SPEED',
  strategyLine:
    'MODE: SPEED. You have a tight iteration budget. Answer from the first good tool result. Do not chain searches unless the first one clearly missed. Return a complete payload as soon as you have a defensible answer, even if it is brief.',
};

const BALANCED: ModeProfile = {
  mode: 'balanced',
  maxIterations: 10,
  toolBudget: 7,
  T_nominal_ms: 60_000,
  rerank: { enabled: true, topK: 5, threshold: 0.15 },
  pickerEnabled: false,
  deepScrapeEnabled: false,
  label: 'BAL',
  strategyLine:
    'MODE: BALANCED. Take enough tool calls to cross-check, but not so many that you wander. Your search hits are pre-filtered by relevance — trust the top ones. Parallel tool calls are encouraged when you need both web and browser work at the same time.',
};

const QUALITY: ModeProfile = {
  mode: 'quality',
  maxIterations: 22,
  toolBudget: 14,
  T_nominal_ms: 180_000,
  rerank: { enabled: true, topK: 3, threshold: 0.2 },
  pickerEnabled: true,
  deepScrapeEnabled: true,
  label: 'QUAL',
  strategyLine:
    'MODE: QUALITY. You have a generous iteration budget. Your search hits are pre-filtered to the best 3 — deep-dive them with the browser tool, read the body text, and compose a grounded synthesis in the final payload. Cite every claim with a url that appears in a successful tool result.',
};

const PROFILES: Record<FetchMode, ModeProfile> = {
  speed: SPEED,
  balanced: BALANCED,
  quality: QUALITY,
};

export function getModeProfile(mode: FetchMode): ModeProfile {
  return PROFILES[mode];
}

/** Return the exact Anguish configuration used by every mode-aware surface. */
export function anguishConfigForMode(
  base: AnguishConfig,
  mode: FetchMode,
): AnguishConfig {
  return { ...base, T_nominal_ms: getModeProfile(mode).T_nominal_ms };
}

/** Apply both runtime ceilings to the horizon used by a concrete Fetch. */
export function anguishConfigForFetch(
  base: AnguishConfig,
  mode: FetchMode,
  taskClassName: string,
): AnguishConfig {
  const modeConfig = anguishConfigForMode(base, mode);
  const taskHorizon = getTaskClass(taskClassName)?.T_nominal_ms;
  return {
    ...modeConfig,
    T_nominal_ms: taskHorizon === undefined
      ? modeConfig.T_nominal_ms
      : Math.min(modeConfig.T_nominal_ms, taskHorizon),
  };
}

export function allModes(): readonly FetchMode[] {
  return ['speed', 'balanced', 'quality'];
}
