import { describe, expect, it } from 'vitest';

import {
  applyRelief,
  band,
  childInitialA,
  clamp01,
  computePressure,
  currentAnguish,
  currentReliefValue,
  DEFAULT_ANGUISH_CONFIG,
  initialState,
  rebaseAnguishClock,
  registerRetry,
  setBudgetEstimate,
  shouldSelfTerminate,
  spendBudget,
  validateAnguishConfig,
} from './anguish.js';
import { anguishConfigForFetch, anguishConfigForMode, getModeProfile } from './modes.js';

describe('Anguish invariants', () => {
  it('keeps the scalar within its declared range', () => {
    expect(clamp01(-Infinity)).toBe(0);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Infinity)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });

  it('produces linear time pressure on the nominal horizon', () => {
    const state = initialState(1_000);
    const atHorizon = currentAnguish(
      state,
      DEFAULT_ANGUISH_CONFIG,
      1_000 + DEFAULT_ANGUISH_CONFIG.T_nominal_ms,
    );
    expect(atHorizon).toBeCloseTo(DEFAULT_ANGUISH_CONFIG.weights.w_t);
  });

  it('makes same-key retry increments strictly increase', () => {
    const increments: number[] = [];
    let state = initialState(0);
    let previous = computePressure(state, DEFAULT_ANGUISH_CONFIG, 0);
    for (let i = 0; i < 4; i++) {
      state = registerRetry(state, 'same-subproblem');
      const next = computePressure(state, DEFAULT_ANGUISH_CONFIG, 0);
      increments.push(next - previous);
      previous = next;
    }
    expect(increments[1]).toBeGreaterThan(increments[0] ?? 0);
    expect(increments[2]).toBeGreaterThan(increments[1] ?? 0);
    expect(increments[3]).toBeGreaterThan(increments[2] ?? 0);
  });

  it('halves relief after one configured half-life', () => {
    const now = 10_000;
    const state = applyRelief(
      initialState(now, 0.5),
      DEFAULT_ANGUISH_CONFIG,
      'tool_ok',
      now,
    );
    const initialRelief = currentReliefValue(state, DEFAULT_ANGUISH_CONFIG, now);
    const laterRelief = currentReliefValue(
      state,
      DEFAULT_ANGUISH_CONFIG,
      now + DEFAULT_ANGUISH_CONFIG.relief_halflife_ms,
    );
    expect(laterRelief).toBeCloseTo(initialRelief / 2);
  });

  it('raises bounded budget pressure monotonically from zero to the cap', () => {
    let state = setBudgetEstimate(initialState(0), 3);
    expect(computePressure(state, DEFAULT_ANGUISH_CONFIG, 0)).toBe(0);
    state = spendBudget(state, 1);
    const afterOne = computePressure(state, DEFAULT_ANGUISH_CONFIG, 0);
    expect(afterOne).toBeCloseTo(0.1);
    state = spendBudget(state, 1);
    const afterTwo = computePressure(state, DEFAULT_ANGUISH_CONFIG, 0);
    expect(afterTwo).toBeCloseTo(0.2);
    expect(afterTwo).toBeGreaterThan(afterOne);
    state = spendBudget(state, 1);
    expect(computePressure(state, DEFAULT_ANGUISH_CONFIG, 0)).toBeCloseTo(0.3);
    state = spendBudget(state, 3);
    expect(computePressure(state, DEFAULT_ANGUISH_CONFIG, 0)).toBeCloseTo(0.3);
  });

  it('uses ordered bands and a distinct self-termination threshold', () => {
    expect(band(0.29)).toBe('calm');
    expect(band(0.30)).toBe('alert');
    expect(band(0.60)).toBe('urgent');
    expect(band(0.85)).toBe('terminal');
    expect(shouldSelfTerminate(0.94)).toBe(false);
    expect(shouldSelfTerminate(0.95)).toBe(true);
  });

  it('applies the configured child inheritance factor', () => {
    expect(childInitialA(0.8)).toBeCloseTo(0.4);
  });

  it('derives every mode horizon from one shared function', () => {
    for (const mode of ['speed', 'balanced', 'quality'] as const) {
      const effective = anguishConfigForMode(DEFAULT_ANGUISH_CONFIG, mode);
      expect(effective.T_nominal_ms).toBe(getModeProfile(mode).T_nominal_ms);
    }
    expect(DEFAULT_ANGUISH_CONFIG.T_nominal_ms).toBe(45_000);
  });

  it('uses the tighter task-class and mode horizon for a concrete Fetch', () => {
    expect(anguishConfigForFetch(
      DEFAULT_ANGUISH_CONFIG,
      'quality',
      'web_research',
    ).T_nominal_ms).toBe(120_000);
    expect(anguishConfigForFetch(
      DEFAULT_ANGUISH_CONFIG,
      'quality',
      'local_search',
    ).T_nominal_ms).toBe(15_000);
    expect(anguishConfigForFetch(
      DEFAULT_ANGUISH_CONFIG,
      'speed',
      'web_research',
    ).T_nominal_ms).toBe(45_000);
  });

  it('rejects invalid mathematical configurations at the runtime boundary', () => {
    expect(() => validateAnguishConfig(DEFAULT_ANGUISH_CONFIG)).not.toThrow();
    expect(() => validateAnguishConfig({
      ...DEFAULT_ANGUISH_CONFIG,
      retry_exponent: 0.9,
    })).toThrow(/retry_exponent/);
    expect(() => validateAnguishConfig({
      ...DEFAULT_ANGUISH_CONFIG,
      weights: { ...DEFAULT_ANGUISH_CONFIG.weights, w_t: Number.NaN },
    })).toThrow(/weights\.w_t/);
    expect(() => validateAnguishConfig({
      ...DEFAULT_ANGUISH_CONFIG,
      thresholds: { ...DEFAULT_ANGUISH_CONFIG.thresholds, alert_max: 0.2 },
    })).toThrow(/thresholds/);
  });
});

describe('revival clock rebase', () => {
  it('preserves anguish across downtime instead of charging it as lived time', () => {
    const born = 1_000;
    let state = initialState(born);
    state = applyRelief(state, DEFAULT_ANGUISH_CONFIG, 'tool_ok', born + 10_000);
    const crashAt = born + 20_000;
    const beforeCrash = currentAnguish(state, DEFAULT_ANGUISH_CONFIG, crashAt);

    const downtime = 3 * 60 * 60 * 1_000;
    const revivedAt = crashAt + downtime;
    const rebased = rebaseAnguishClock(state, downtime);
    const afterRevival = currentAnguish(rebased, DEFAULT_ANGUISH_CONFIG, revivedAt);

    expect(afterRevival).toBeCloseTo(beforeCrash, 10);
  });

  it('is the identity for zero, negative, and non-finite downtime', () => {
    const state = initialState(1_000);
    expect(rebaseAnguishClock(state, 0)).toBe(state);
    expect(rebaseAnguishClock(state, -500).t_start).toBe(1_000);
    expect(rebaseAnguishClock(state, Number.NaN).t_start).toBe(1_000);
  });

  it('shifts the silence clock with the rest of the state', () => {
    const state = { ...initialState(1_000), t_input_requested: 2_000 };
    const rebased = rebaseAnguishClock(state, 5_000);
    expect(rebased.t_start).toBe(6_000);
    expect(rebased.t_input_requested).toBe(7_000);
  });
});
