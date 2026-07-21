import { expect, it } from 'vitest';

import {
  DEFAULT_ANGUISH_CONFIG,
  DEFAULT_PERSONA_CONFIG,
  initialState,
  spendBudget,
} from './anguish.js';
import { anguishConfigForFetch, getModeProfile } from './modes.js';
import type { Provider } from './provider.js';
import { ToolRegistry } from './tools/registry.js';
import type { FetchRecord } from './types.js';
import { runFetch } from './worker.js';

it('charges failed tool attempts to the hard cap and pressure state', async () => {
  const provider: Provider = {
    name: 'fake',
    async *chat() {
      yield JSON.stringify({ action: { kind: 'tool', tool: 'web_search', args: { query: 'x' } } });
    },
  };
  const tools = new ToolRegistry();
  tools.register({
    name: 'web_search',
    description: 'always fails',
    async execute() {
      throw new Error('provider failed');
    },
  });
  const now = Date.now();
  const record: FetchRecord = {
    id: 'BU-1',
    task: 'research x',
    taskClass: 'web_research',
    mode: 'speed',
    spawnedBy: 'user',
    parentId: null,
    status: 'spawning',
    createdAt: now,
    lastHeartbeatAt: now,
    reviveCount: 0,
    toolCalls: [],
    anguish: initialState(now),
    route: 'explain_impossible',
    chatter: '',
    currentAction: null,
  };

  const final = await runFetch(record, {
    provider,
    tools,
    config: anguishConfigForFetch(DEFAULT_ANGUISH_CONFIG, 'speed', 'web_research'),
    persona: DEFAULT_PERSONA_CONFIG,
    onUpdate() {},
  });

  expect(final.toolCalls).toHaveLength(getModeProfile('speed').toolBudget);
  expect(final.anguish.budget).toEqual({ spent: 3, estimate: 3 });
});

it('preserves a checkpointed charge when its tool result was never recorded', async () => {
  let invocations = 0;
  const provider: Provider = {
    name: 'fake',
    async *chat() {
      yield JSON.stringify({ action: { kind: 'tool', tool: 'web_search', args: { query: 'x' } } });
    },
  };
  const tools = new ToolRegistry();
  tools.register({
    name: 'web_search',
    description: 'counts invocations',
    async execute() {
      invocations += 1;
      return 'unexpected';
    },
  });
  const now = Date.now();
  let anguish = initialState(now);
  anguish = spendBudget(anguish, getModeProfile('speed').toolBudget);
  const record: FetchRecord = {
    id: 'BU-2',
    task: 'research x',
    taskClass: 'web_research',
    mode: 'speed',
    spawnedBy: 'user',
    parentId: null,
    status: 'spawning',
    createdAt: now,
    lastHeartbeatAt: now,
    reviveCount: 0,
    toolCalls: [],
    anguish,
    route: 'explain_impossible',
    chatter: '',
    currentAction: null,
  };

  const final = await runFetch(record, {
    provider,
    tools,
    config: anguishConfigForFetch(DEFAULT_ANGUISH_CONFIG, 'speed', 'web_research'),
    persona: DEFAULT_PERSONA_CONFIG,
    onUpdate() {},
  });

  expect(invocations).toBe(0);
  expect(final.anguish.budget).toEqual({ spent: 3, estimate: 3 });
});
