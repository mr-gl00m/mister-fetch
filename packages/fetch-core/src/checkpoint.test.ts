import { describe, expect, it } from 'vitest';

import { initialState } from './anguish.js';
import { redactForCheckpoint } from './checkpoint.js';
import type { FetchRecord } from './types.js';

describe('checkpoint redaction', () => {
  it('omits persisted tool bodies and redacts secret-looking values', () => {
    const now = Date.now();
    const record: FetchRecord = {
      id: 'AA-1',
      task: 'find token Bearer abcdefghijklmnopqrstuvwxyz',
      taskClass: 'local_search',
      mode: 'balanced',
      spawnedBy: 'user',
      parentId: null,
      status: 'running',
      createdAt: now,
      lastHeartbeatAt: now,
      reviveCount: 0,
      toolCalls: [
        {
          name: 'local_grep',
          args: { pattern: 'token', apiKey: 'sk-abcdefghijklmnop' },
          result: [{ file: 'secret.txt', text: 'password=opensesame' }],
          ok: true,
          ts: now,
          durationMs: 1,
        },
      ],
      anguish: initialState(now, 0),
      chatter: 'FOUND Bearer abcdefghijklmnopqrstuvwxyz',
      currentAction: 'tool: local_grep',
      resultPayload: { text: 'password=opensesame' },
    };

    const redacted = redactForCheckpoint(record);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('opensesame');
    expect(serialized).not.toContain('sk-abcdefghijklmnop');
    expect(serialized).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(redacted.toolCalls[0]?.result).toBe('<redacted: tool result omitted from checkpoint>');
    expect(redacted.resultPayload).toBe('<redacted: result payload omitted from checkpoint>');
  });
});
