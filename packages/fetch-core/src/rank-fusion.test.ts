import { describe, expect, it } from 'vitest';

import { fuseRankings, type FusionHit } from './rank-fusion.js';

const hit = (url: string): FusionHit => ({ title: url, url, snippet: '' });

describe('reciprocal-rank fusion', () => {
  it('counts one normalized URL once per provider', () => {
    const lateConsensus = [
      ...Array.from({ length: 9 }, (_, i) => hit(`https://noise.example/${i}`)),
      hit('https://consensus.example/result'),
    ];
    const fused = fuseRankings([
      {
        provider: 'duplicate-source',
        hits: [
          hit('https://duplicate.example/result?utm_source=one'),
          hit('https://duplicate.example/result?utm_source=two'),
        ],
      },
      { provider: 'first-consensus-source', hits: [hit('https://consensus.example/result')] },
      { provider: 'second-consensus-source', hits: lateConsensus },
    ], { limit: 1 });

    expect(fused[0]?.url).toBe('https://consensus.example/result');
  });

  it('removes duplicate rows before assigning provider-local ranks', () => {
    const lateConsensus = [
      ...Array.from({ length: 9 }, (_, i) => hit(`https://noise.example/${i}`)),
      hit('https://consensus.example/result'),
    ];
    const fused = fuseRankings([
      {
        provider: 'duplicate-source',
        hits: [
          hit('https://first.example/?utm_source=one'),
          hit('https://first.example/?utm_source=two'),
          hit('https://consensus.example/result'),
        ],
      },
      { provider: 'late-consensus-source', hits: lateConsensus },
      { provider: 'competing-source', hits: [hit('https://competitor.example/result')], weight: 1.85 },
    ], { limit: 1 });

    expect(fused[0]?.url).toBe('https://consensus.example/result');
  });

  it('rejects parameters outside the RRF domain', () => {
    expect(() => fuseRankings([], { k: -1 })).toThrow(/RRF k/);
    expect(() => fuseRankings([], { limit: 1.5 })).toThrow(/RRF limit/);
    expect(() => fuseRankings([
      { provider: 'bad', hits: [hit('https://example.com')], weight: Number.NaN },
    ])).toThrow(/RRF weight/);
  });
});
