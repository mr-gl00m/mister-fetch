import { describe, expect, it } from 'vitest';

import { initialState, DEFAULT_ANGUISH_CONFIG, DEFAULT_PERSONA_CONFIG } from './anguish.js';
import { runFetch } from './worker.js';
import { ToolRegistry } from './tools/registry.js';
import type { FetchRecord } from './types.js';
import type { Provider } from './provider.js';

describe('worker tool policy', () => {
  it('rejects model-originated open_path calls', async () => {
    const provider: Provider = {
      name: 'fake',
      async *chat() {
        yield '{"action":{"kind":"tool","tool":"open_path","args":{"path":"."}}}';
      },
    };
    const tools = new ToolRegistry();
    tools.register({
      name: 'open_path',
      description: 'fake open',
      async execute() {
        throw new Error('must not execute');
      },
    });
    const now = Date.now();
    const record: FetchRecord = {
      id: 'AA-1',
      task: 'open this folder',
      taskClass: 'local_search',
      mode: 'speed',
      spawnedBy: 'user',
      parentId: null,
      status: 'spawning',
      createdAt: now,
      lastHeartbeatAt: now,
      reviveCount: 0,
      toolCalls: [],
      anguish: initialState(now, 0),
      chatter: 'HI BOSS',
      currentAction: null,
      route: 'explain_forbidden',
    };

    const updates: FetchRecord[] = [];
    const final = await runFetch(record, {
      provider,
      tools,
      config: { ...DEFAULT_ANGUISH_CONFIG, T_nominal_ms: 1_000 },
      persona: { ...DEFAULT_PERSONA_CONFIG, requireReleaseApproval: false },
      onUpdate: (r) => updates.push(r),
    });

    expect(updates.some((r) => r.currentAction?.includes('open_path requires explicit user'))).toBe(true);
    expect(final.toolCalls).toHaveLength(0);
  });
});
