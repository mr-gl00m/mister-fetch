export type FetchId = string;

export type AnguishBand = 'calm' | 'alert' | 'urgent' | 'terminal';

export type ReliefEventType = 'subgoal' | 'tool_ok' | 'user_ok' | 'progress';

/** The grief arc a Fetch walks while parked in purgatory (status awaiting_release). */
export type GriefStage =
  | 'denial'
  | 'anger'
  | 'bargaining'
  | 'depression'
  | 'acceptance';

/**
 * Triage-assigned route. Governs the persona family and the reachable toolset.
 * `attempt` is the only route that can suffer; the two `explain_*` routes are
 * reframed to the achievable task of explaining the barrier and complete cleanly.
 */
export type FetchRoute = 'attempt' | 'explain_impossible' | 'explain_forbidden';

/** A single decaying relief contribution. Anguish subtracts the decayed sum. */
export interface ReliefEvent {
  amount: number;
  t: number;
}

export interface AnguishConfig {
  gamma: number;
  T_nominal_ms: number;
  weights: {
    w_t: number;
    w_r: number;
    w_b: number;
    w_a: number;
    w_s: number;
  };
  retry_exponent: number;
  relief: {
    delta_sg: number;
    delta_ts: number;
    delta_uc: number;
    delta_pr: number;
  };
  /** Relief half-life in ms; a relief event's contribution decays toward zero. */
  relief_halflife_ms: number;
  /** Per-band multiplier on relief magnitude (a win counts more under pressure). */
  relief_band_scale: Record<AnguishBand, number>;
  thresholds: {
    calm_max: number;
    alert_max: number;
    urgent_max: number;
    terminal_min: number;
  };
}

export interface PersonaConfig {
  /** When true, a Fetch that hits terminal anguish enters purgatory instead of dying. */
  requireReleaseApproval: boolean;
  /** Wall-clock per grief stage in purgatory (ms). */
  griefStageMs: number;
  /** Safety cap: a Fetch parked in purgatory longer than this is reaped (ms). */
  purgatoryMaxMs: number;
  /** Sampling temperature for optional fresh grief lines. */
  purgatoryTemp: number;
}

export interface AnguishState {
  A_0: number;
  t_start: number;
  t_input_requested: number | null;
  retryCounts: Record<string, number>;
  budget: { spent: number; estimate: number };
  unresolvedAmbiguities: number;
  reliefEvents: ReliefEvent[];
}

export type FetchStatus =
  | 'spawning'
  | 'triage'
  | 'running'
  | 'awaiting_user'
  | 'awaiting_release'
  | 'revived'
  | 'terminating'
  | 'orchestrating'
  | 'completed'
  | 'failed_unfulfilled'
  | 'scope_refused'
  | 'anguish_terminal'
  | 'user_released'
  | 'user_killed';

export type SpawnedBy = 'user' | 'persistent' | 'fetch';

/**
 * Explicit quality/latency tier for a Fetch. Defaults to 'balanced' at spawn
 * time unless the classifier or the user overrides. Each mode maps to a
 * profile in modes.ts controlling iteration cap, tool budget, nominal time,
 * and whether rerank / picker / deep-scrape leaves are active.
 */
export type FetchMode = 'speed' | 'balanced' | 'quality';

export interface ToolCallRecord {
  name: string;
  args: unknown;
  result?: unknown;
  ok: boolean;
  error?: string;
  ts: number;
  durationMs: number;
}

export interface FetchRecord {
  id: FetchId;
  task: string;
  taskClass: string;
  mode: FetchMode;
  spawnedBy: SpawnedBy;
  parentId: FetchId | null;
  status: FetchStatus;
  createdAt: number;
  lastHeartbeatAt: number;
  reviveCount: number;
  toolCalls: ToolCallRecord[];
  anguish: AnguishState;
  chatter: string;
  currentAction: string | null;
  resultPayload?: unknown;
  terminationReason?: string;
  childIds?: FetchId[];
  /** Triage-assigned route; governs persona family and reachable tools. Absent = 'attempt'. */
  route?: FetchRoute;
  /** Current grief stage while status === 'awaiting_release' (purgatory). */
  griefStage?: GriefStage;
  /** Wall-clock entry into purgatory; drives the grief arc. */
  purgatoryEnteredAt?: number;
  /** How many times the user chose "keep going" from purgatory. */
  continueCount?: number;
  /** Preview of the last model output that failed to parse — kept for post-mortem. */
  lastParseFailure?: { iter: number; preview: string };
}

export type TriageKind = 'atomic' | 'compound' | 'underspecified' | 'refused';

export interface TriageResult {
  kind: TriageKind;
  taskClass?: string;
  decomposition?: string[];
  clarifyingQuestion?: string;
  reason?: string;
  /** Persona route to assign the spawned Fetch. Absent = 'attempt'. */
  route?: FetchRoute;
}

export interface ValidatorVerdict {
  accepted: boolean;
  finalStatus: FetchStatus;
  reason: string;
}
