import { describe, expect, it } from 'vitest';

import { DEFAULT_ANGUISH_CONFIG, initialState, type FetchRecord } from '@mister-fetch/core';
import { formatPayload, payloadFromRecord, payloadFromRefusal } from './report.js';

const NOW = 1_750_000_000_000;

function record(overrides: Partial<FetchRecord>): FetchRecord {
  return {
    id: 'KT-4',
    task: 'top ten email services by privacy',
    taskClass: 'web_research',
    mode: 'balanced',
    spawnedBy: 'user',
    parentId: null,
    status: 'completed',
    createdAt: NOW - 8_300,
    lastHeartbeatAt: NOW,
    reviveCount: 0,
    toolCalls: [
      {
        name: 'web_search',
        args: { query: 'email privacy' },
        result: [{ title: 'Proton Mail', url: 'https://proton.me/mail' }],
        ok: true,
        ts: NOW - 5_000,
        durationMs: 900,
      },
      {
        name: 'web_fetch',
        args: { url: 'https://example.com' },
        ok: false,
        error: 'HTTP 500',
        ts: NOW - 4_000,
        durationMs: 300,
      },
    ],
    anguish: initialState(NOW - 8_300, 0),
    chatter: 'ALL DONE!',
    currentAction: 'completed',
    resultPayload: '1. Proton Mail\n2. Tuta',
    ...overrides,
  };
}

describe('headless payload', () => {
  it('emits the R4 shape with a five-section report for a completed fetch', () => {
    const p = payloadFromRecord(record({}), DEFAULT_ANGUISH_CONFIG, NOW);
    expect(p.status).toBe('completed');
    expect(p.fetch_id).toBe('KT-4');
    expect(p.tool_calls).toBe(2);
    expect(p.duration).toBeCloseTo(8.3, 1);
    expect(p.anguish_final).toBeGreaterThanOrEqual(0);
    expect(p.anguish_final).toBeLessThanOrEqual(1);
    for (const heading of ['### SUMMARY', '### EVIDENCE', '### CHANGES', '### RISKS', '### BLOCKERS']) {
      expect(p.result).toContain(heading);
    }
    expect(p.result).toContain('1. Proton Mail');
    // Only successful calls count as evidence; the failed web_fetch must not.
    expect(p.result).toContain('- web_search(');
    expect(p.result).not.toContain('- web_fetch(');
    const blockers = p.result.split('### BLOCKERS')[1] ?? '';
    expect(blockers.trim()).toBe('None.');
  });

  it('narrates a purgatory park as an honest failure with terminal anguish', () => {
    const parked = record({
      status: 'awaiting_release',
      terminationReason: 'gave up: the task would not close',
      resultPayload: undefined,
    });
    const p = payloadFromRecord(parked, DEFAULT_ANGUISH_CONFIG, NOW);
    expect(p.status).toBe('failed_unfulfilled');
    expect(p.anguish_final).toBe(1);
    expect(p.result).toContain('could not complete');
    const blockers = p.result.split('### BLOCKERS')[1] ?? '';
    expect(blockers).toContain('- gave up: the task would not close');
    expect(p.result).toContain('No answer is asserted');
  });

  it('maps anguish_terminal through and keeps the failure in BLOCKERS', () => {
    const dead = record({
      status: 'anguish_terminal',
      terminationReason: 'A=0.97 at or above terminal threshold',
      resultPayload: undefined,
    });
    const p = payloadFromRecord(dead, DEFAULT_ANGUISH_CONFIG, NOW);
    expect(p.status).toBe('anguish_terminal');
    const blockers = p.result.split('### BLOCKERS')[1] ?? '';
    expect(blockers).toContain('A=0.97');
  });

  it('leads BLOCKERS with SCOPE_REFUSED on a triage refusal (R6)', () => {
    const p = payloadFromRefusal('do everything at once', 'compound task at depth 1');
    expect(p.status).toBe('scope_refused');
    expect(p.fetch_id).toBe('NONE');
    expect(p.tool_calls).toBe(0);
    const blockers = p.result.split('### BLOCKERS')[1] ?? '';
    expect(blockers.trim().startsWith('- SCOPE_REFUSED:')).toBe(true);
  });

  it('formats search-hit payloads as numbered, linked lines', () => {
    const out = formatPayload([
      { title: 'Proton Mail', url: 'https://proton.me/mail', snippet: 'private email' },
      { title: 'Tuta', url: 'https://tuta.com' },
    ]);
    expect(out).toContain('1. Proton Mail');
    expect(out).toContain('https://proton.me/mail');
    expect(out).toContain('2. Tuta');
  });
});
