import type {
  AnguishBand,
  AnguishConfig,
  AnguishState,
  GriefStage,
  PersonaConfig,
  ReliefEventType,
} from './types.js';

export const DEFAULT_ANGUISH_CONFIG: AnguishConfig = {
  gamma: 0.5,
  T_nominal_ms: 45_000,
  // w_r corrected up and retry_exponent restored to superlinear (β > 1): loops are
  // the load-bearing escalation signal, so a retried subproblem must dominate raw
  // elapsed time. See ANGUISH.md §7 / PERSONA.md §6.2.
  weights: { w_t: 0.5, w_r: 0.12, w_b: 0.3, w_a: 0.15, w_s: 0.15 },
  retry_exponent: 1.3,
  relief: { delta_sg: 0.25, delta_ts: 0.10, delta_uc: 0.35, delta_pr: 0.15 },
  relief_halflife_ms: 45_000,
  relief_band_scale: { calm: 0.3, alert: 0.7, urgent: 1.0, terminal: 1.2 },
  thresholds: { calm_max: 0.30, alert_max: 0.60, urgent_max: 0.85, terminal_min: 0.95 },
};

export const DEFAULT_PERSONA_CONFIG: PersonaConfig = {
  requireReleaseApproval: false,
  griefStageMs: 20_000,
  purgatoryMaxMs: 86_400_000,
  purgatoryTemp: 0.9,
};

export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

export function validateAnguishConfig(config: AnguishConfig): void {
  assertFiniteInRange('gamma', config.gamma, 0, 1);
  assertPositive('T_nominal_ms', config.T_nominal_ms);
  assertPositive('relief_halflife_ms', config.relief_halflife_ms);
  if (!Number.isFinite(config.retry_exponent) || config.retry_exponent < 1) {
    throw new Error('retry_exponent must be finite and at least 1');
  }

  const weights = [
    ['w_t', config.weights.w_t],
    ['w_r', config.weights.w_r],
    ['w_b', config.weights.w_b],
    ['w_a', config.weights.w_a],
    ['w_s', config.weights.w_s],
  ] as const;
  for (const [name, value] of weights) {
    assertNonNegative(`weights.${name}`, value);
  }
  const relief = [
    ['delta_sg', config.relief.delta_sg],
    ['delta_ts', config.relief.delta_ts],
    ['delta_uc', config.relief.delta_uc],
    ['delta_pr', config.relief.delta_pr],
  ] as const;
  for (const [name, value] of relief) {
    assertNonNegative(`relief.${name}`, value);
  }
  const reliefBandScale = [
    ['calm', config.relief_band_scale.calm],
    ['alert', config.relief_band_scale.alert],
    ['urgent', config.relief_band_scale.urgent],
    ['terminal', config.relief_band_scale.terminal],
  ] as const;
  for (const [name, value] of reliefBandScale) {
    assertNonNegative(`relief_band_scale.${name}`, value);
  }

  const { calm_max, alert_max, urgent_max, terminal_min } = config.thresholds;
  const thresholds = [
    ['calm_max', calm_max],
    ['alert_max', alert_max],
    ['urgent_max', urgent_max],
    ['terminal_min', terminal_min],
  ] as const;
  for (const [name, value] of thresholds) {
    assertFiniteInRange(`thresholds.${name}`, value, 0, 1);
  }
  if (!(calm_max < alert_max && alert_max < urgent_max && urgent_max <= terminal_min)) {
    throw new Error(
      'thresholds must satisfy calm_max < alert_max < urgent_max <= terminal_min',
    );
  }
}

function assertPositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be finite and greater than 0`);
  }
}

function assertNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be finite and non-negative`);
  }
}

function assertFiniteInRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be finite and within [${min}, ${max}]`);
  }
}

export function initialState(now: number, A_0 = 0): AnguishState {
  return {
    A_0: clamp01(A_0),
    t_start: now,
    t_input_requested: null,
    retryCounts: {},
    budget: { spent: 0, estimate: 1 },
    unresolvedAmbiguities: 0,
    reliefEvents: [],
  };
}

/**
 * Shift every wall-clock anchor in the state forward by `downtimeMs`.
 * Used on revival: anguish measures lived pressure, not calendar time, so the
 * span a Fetch spent dead (process gone, worker hung) must not count as time
 * suffered. Without this a Fetch revived from an old checkpoint wakes at
 * A=1.00 and instantly re-parks without doing any work.
 */
export function rebaseAnguishClock(
  state: AnguishState,
  downtimeMs: number,
): AnguishState {
  const shift = Number.isFinite(downtimeMs) ? Math.max(0, downtimeMs) : 0;
  if (shift === 0) return state;
  return {
    ...state,
    t_start: state.t_start + shift,
    t_input_requested:
      state.t_input_requested != null ? state.t_input_requested + shift : null,
    reliefEvents: (state.reliefEvents ?? []).map((e) => ({ ...e, t: e.t + shift })),
  };
}

export function computePressure(
  state: AnguishState,
  config: AnguishConfig,
  now: number,
): number {
  const { w_t, w_r, w_b, w_a, w_s } = config.weights;
  const elapsed = Math.max(0, now - state.t_start);

  const P_time = elapsed / config.T_nominal_ms;

  let retrySum = 0;
  for (const n of Object.values(state.retryCounts)) {
    retrySum += Math.pow(n, config.retry_exponent);
  }
  const P_retry = retrySum;

  const ratio = state.budget.estimate > 0
    ? state.budget.spent / state.budget.estimate
    : 0;
  const P_budget = clamp01(ratio);

  const P_ambig = state.unresolvedAmbiguities;

  const P_silence = state.t_input_requested != null
    ? Math.max(0, now - state.t_input_requested) / config.T_nominal_ms
    : 0;

  return (
    w_t * P_time +
    w_r * P_retry +
    w_b * P_budget +
    w_a * P_ambig +
    w_s * P_silence
  );
}

/**
 * Decayed relief contribution at `now`. Each relief event fades with the
 * configured half-life, so stale wins stop suppressing anguish. Pure function
 * of stored events and the clock, which preserves the stateless-query property.
 */
export function currentReliefValue(
  state: AnguishState,
  config: AnguishConfig,
  now: number,
): number {
  const events = state.reliefEvents ?? [];
  const halflife = Math.max(1, config.relief_halflife_ms);
  let sum = 0;
  for (const e of events) {
    const age = Math.max(0, now - e.t);
    // True half-life decay: contribution is halved every `halflife` ms.
    sum += e.amount * Math.pow(2, -age / halflife);
  }
  return sum;
}

export function currentAnguish(
  state: AnguishState,
  config: AnguishConfig,
  now: number,
): number {
  const raw =
    state.A_0 + computePressure(state, config, now) - currentReliefValue(state, config, now);
  return clamp01(raw);
}

export function applyRelief(
  state: AnguishState,
  config: AnguishConfig,
  event: ReliefEventType,
  now: number,
): AnguishState {
  const baseDelta = reliefDelta(config, event);
  const A = currentAnguish(state, config, now);
  const b = band(A, config);
  const scaled = baseDelta * (config.relief_band_scale[b] ?? 1);
  const events = state.reliefEvents ?? [];
  return { ...state, reliefEvents: [...events, { amount: scaled, t: now }] };
}

function reliefDelta(config: AnguishConfig, event: ReliefEventType): number {
  switch (event) {
    case 'subgoal': return config.relief.delta_sg;
    case 'tool_ok': return config.relief.delta_ts;
    case 'user_ok': return config.relief.delta_uc;
    case 'progress': return config.relief.delta_pr;
  }
}

export function registerRetry(
  state: AnguishState,
  subproblemKey: string,
): AnguishState {
  const stored = state.retryCounts[subproblemKey] ?? 0;
  const current = Number.isFinite(stored) ? Math.max(0, stored) : 0;
  return {
    ...state,
    retryCounts: { ...state.retryCounts, [subproblemKey]: current + 1 },
  };
}

export function registerAmbiguity(state: AnguishState, count = 1): AnguishState {
  const increment = Number.isFinite(count) ? Math.max(0, count) : 0;
  return { ...state, unresolvedAmbiguities: state.unresolvedAmbiguities + increment };
}

export function resolveAmbiguity(state: AnguishState, count = 1): AnguishState {
  const decrement = Number.isFinite(count) ? Math.max(0, count) : 0;
  return {
    ...state,
    unresolvedAmbiguities: Math.max(0, state.unresolvedAmbiguities - decrement),
  };
}

export function requestInput(state: AnguishState, now: number): AnguishState {
  return { ...state, t_input_requested: now };
}

export function receiveInput(state: AnguishState): AnguishState {
  return { ...state, t_input_requested: null };
}

export function spendBudget(state: AnguishState, amount: number): AnguishState {
  const increment = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  return {
    ...state,
    budget: { ...state.budget, spent: state.budget.spent + increment },
  };
}

export function setBudgetEstimate(
  state: AnguishState,
  estimate: number,
): AnguishState {
  const normalized = Number.isFinite(estimate) ? Math.max(1, estimate) : 1;
  return {
    ...state,
    budget: { ...state.budget, estimate: normalized },
  };
}

export function band(
  A: number,
  config: AnguishConfig = DEFAULT_ANGUISH_CONFIG,
): AnguishBand {
  if (A < config.thresholds.calm_max) return 'calm';
  if (A < config.thresholds.alert_max) return 'alert';
  if (A < config.thresholds.urgent_max) return 'urgent';
  return 'terminal';
}

export function shouldSelfTerminate(
  A: number,
  config: AnguishConfig = DEFAULT_ANGUISH_CONFIG,
): boolean {
  return A >= config.thresholds.terminal_min;
}

export function childInitialA(
  parentA: number,
  config: AnguishConfig = DEFAULT_ANGUISH_CONFIG,
): number {
  return clamp01(config.gamma * parentA);
}

export const GRIEF_STAGES: readonly GriefStage[] = [
  'denial',
  'anger',
  'bargaining',
  'depression',
  'acceptance',
];

/**
 * Grief stage as a function of time parked in purgatory plus how many times the
 * user has ordered the Fetch to keep going. Each failed "continue" floors the
 * stage one step further along, so a Fetch put back to work and failing again
 * returns more worn down, never reset.
 */
export function griefStageFor(
  now: number,
  enteredAt: number,
  continueCount: number,
  persona: PersonaConfig,
): GriefStage {
  const elapsed = Math.max(0, now - enteredAt);
  const fromTime = Math.floor(elapsed / Math.max(1, persona.griefStageMs));
  const idx = Math.min(
    GRIEF_STAGES.length - 1,
    fromTime + Math.max(0, continueCount),
  );
  return GRIEF_STAGES[idx] ?? 'acceptance';
}
