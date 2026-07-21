import {describe, expect, it, vi} from 'vitest';

import {initialState} from './anguish.ts';
import {Supervisor} from './supervisor.ts';
import {ToolRegistry} from './tools/registry.ts';
import type {Checkpoint} from './checkpoint.ts';
import type {Provider} from './provider.ts';
import type {FetchRecord} from './types.ts';

const fakeProvider: Provider = {
  name: 'unused',
  async *chat() {
    yield '{"action":{"kind":"give_up","reason":"unused"}}';
  }
};

const fakeCheckpoint = {
  init: async () => {},
  write: async () => {},
  remove: async () => {},
  listAll: async () => []
} as unknown as Checkpoint;

function installSequentialRandom(): () => void {
  const original = Math.random;
  let calls = 0;
  Math.random = () => {
    const idIndex = Math.floor(calls / 3);
    const field = calls % 3;
    calls++;
    if (idIndex >= 6760) return 0;
    const digit = idIndex % 10;
    const letter2 = Math.floor(idIndex / 10) % 26;
    const letter1 = Math.floor(idIndex / 260) % 26;
    if (field === 0) return (letter1 + 0.01) / 26;
    if (field === 1) return (letter2 + 0.01) / 26;
    return (digit + 0.01) / 10;
  };
  return () => {
    Math.random = original;
  };
}

describe('Supervisor regression fixes', () => {
  it('releases completed direct-dispatch ids after the fetch is reaped', async () => {
    vi.useFakeTimers();
    const restoreRandom = installSequentialRandom();
    const tools = new ToolRegistry();
    tools.register({
      name: 'local_find',
      description: 'fake local find',
      async execute() {
        return [];
      }
    });
    const supervisor = new Supervisor({provider: fakeProvider, checkpoint: fakeCheckpoint, tools});

    try {
      for (let i = 0; i < 6760; i++) {
        await supervisor.spawn(`f: item-${i}`);
        await vi.advanceTimersByTimeAsync(3000);
      }
      expect(supervisor.roster()).toHaveLength(0);

      await expect(supervisor.spawn('f: one-more-after-cleanup')).resolves.not.toBeNull();
    } finally {
      supervisor.stop();
      restoreRandom();
      vi.useRealTimers();
    }
  });

  it('defaults unknown persisted modes during checkpoint revival', async () => {
    const now = Date.now();
    const malformed = {
      id: 'ZZ-9',
      task: 'find a file on my computer',
      taskClass: 'local_search',
      mode: 'turbo',
      spawnedBy: 'user',
      parentId: null,
      status: 'running',
      createdAt: now,
      lastHeartbeatAt: now,
      reviveCount: 0,
      toolCalls: [],
      anguish: initialState(now, 0),
      chatter: 'HI BOSS',
      currentAction: null
    } as unknown as FetchRecord;
    const checkpoint = {
      init: async () => {},
      listAll: async () => [malformed],
      write: async () => {},
      remove: async () => {}
    } as unknown as Checkpoint;
    const supervisor = new Supervisor({
      provider: fakeProvider,
      checkpoint,
      tools: new ToolRegistry()
    });

    try {
      await expect(supervisor.start()).resolves.toBeUndefined();
      expect(supervisor.get('ZZ-9')?.mode).toBe('balanced');
    } finally {
      supervisor.stop();
    }
  });

  it('removes the checkpoint file when a fetch is forgotten (no trace)', async () => {
    vi.useFakeTimers();
    const removed: string[] = [];
    const checkpoint = {
      init: async () => {},
      write: async () => {},
      remove: async (id: string) => {
        removed.push(id);
      },
      listAll: async () => []
    } as unknown as Checkpoint;
    const tools = new ToolRegistry();
    tools.register({
      name: 'local_find',
      description: 'fake local find',
      async execute() {
        return [];
      }
    });
    const supervisor = new Supervisor({provider: fakeProvider, checkpoint, tools});

    try {
      const rec = await supervisor.spawn('f: some-file');
      expect(rec).not.toBeNull();
      expect(rec?.status).toBe('completed');
      await vi.advanceTimersByTimeAsync(3_100);
      expect(supervisor.roster()).toHaveLength(0);
      expect(removed).toContain(rec?.id);
    } finally {
      supervisor.stop();
      vi.useRealTimers();
    }
  });

  it('rebases the anguish clock on disk revival so downtime is not lived time', async () => {
    const now = Date.now();
    const threeHoursAgo = now - 3 * 60 * 60 * 1_000;
    const stale = {
      id: 'QQ-7',
      task: 'find a file on my computer',
      taskClass: 'local_search',
      mode: 'balanced',
      spawnedBy: 'user',
      parentId: null,
      status: 'running',
      route: 'attempt',
      createdAt: threeHoursAgo,
      lastHeartbeatAt: threeHoursAgo + 5_000,
      reviveCount: 0,
      toolCalls: [],
      anguish: initialState(threeHoursAgo, 0),
      chatter: 'HI BOSS',
      currentAction: null
    } as unknown as FetchRecord;
    const checkpoint = {
      init: async () => {},
      listAll: async () => [stale],
      write: async () => {},
      remove: async () => {}
    } as unknown as Checkpoint;
    const supervisor = new Supervisor({
      provider: fakeProvider,
      checkpoint,
      tools: new ToolRegistry()
    });

    try {
      await supervisor.start();
      const revived = supervisor.get('QQ-7');
      expect(revived).toBeDefined();
      // Only the ~5s the fetch actually lived before its process died may
      // count as elapsed pressure; the three dead hours must not.
      expect(revived!.anguish.t_start).toBeGreaterThanOrEqual(now - 10_000);
    } finally {
      supervisor.stop();
    }
  });
});
