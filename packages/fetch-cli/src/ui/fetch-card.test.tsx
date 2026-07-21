import { expect, it } from 'vitest';

import {
  anguishConfigForFetch,
  currentAnguish,
  DEFAULT_ANGUISH_CONFIG,
  initialState,
  type FetchRecord,
} from '@mister-fetch/core';
import { fetchCardAnguish } from './fetch-card.js';

it('displays the same effective Anguish value used by a Quality worker', () => {
  const startedAt = 1_000_000;
  const now = startedAt + 90_000;
  const record: FetchRecord = {
    id: 'UI-1',
    task: 'research Saturn',
    taskClass: 'web_research',
    mode: 'quality',
    spawnedBy: 'user',
    parentId: null,
    status: 'working',
    createdAt: startedAt,
    lastHeartbeatAt: startedAt,
    reviveCount: 0,
    toolCalls: [],
    anguish: initialState(startedAt),
    chatter: '',
    currentAction: null,
  };
  const workerConfig = anguishConfigForFetch(
    DEFAULT_ANGUISH_CONFIG,
    record.mode,
    record.taskClass,
  );
  const workerA = currentAnguish(record.anguish, workerConfig, now);

  expect(fetchCardAnguish(record, DEFAULT_ANGUISH_CONFIG, now).A).toBe(workerA);
  expect(workerA).toBeCloseTo(0.375);
});
