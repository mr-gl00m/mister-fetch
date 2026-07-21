import { describe, expect, it } from 'vitest';

import { initialState } from './anguish.js';
import type { FetchRecord } from './types.js';
import {
  buildContextCorpus,
  buildGroundingCorpus,
  findUngroundedFactSpans,
  validateCompletion,
} from './validator.js';

function webRecord(task: string, evidence: string, payload: unknown): FetchRecord {
  const now = Date.now();
  return {
    id: 'VA-1',
    task,
    taskClass: 'web_research',
    mode: 'balanced',
    spawnedBy: 'user',
    parentId: null,
    status: 'terminating',
    createdAt: now,
    lastHeartbeatAt: now,
    reviveCount: 0,
    toolCalls: [{
      name: 'web_search',
      args: { query: task },
      result: [{ title: 'Evidence', url: 'https://example.com', snippet: evidence }],
      ok: true,
      ts: now,
      durationMs: 1,
    }],
    anguish: initialState(now),
    chatter: '',
    currentAction: null,
    resultPayload: payload,
  };
}

describe('grounding validator', () => {
  it('does not treat question vocabulary as factual evidence', () => {
    const record = webRecord(
      'Is Saturn made of cheese?',
      'Saturn is a gas giant',
      'Saturn is made of cheese',
    );
    expect(validateCompletion(record).accepted).toBe(false);
  });

  it.each(['7', '42', '99', '100', '$99'])(
    'checks short numeric string %s',
    (number) => {
      const record = webRecord(
        'What is the listed cost?',
        'The listed cost is unavailable',
        `The listed cost is ${number}`,
      );
      expect(validateCompletion(record).accepted).toBe(false);
    },
  );

  it('ignores surrounding sentence punctuation', () => {
    const record = webRecord(
      'Tell me the planet facts',
      'The planet has rings',
      'The planet has rings.',
    );
    expect(validateCompletion(record).accepted).toBe(true);
  });

  it('normalizes numeric separators and trailing decimal zeros', () => {
    const record = webRecord(
      'What is the price?',
      'The listed price is $1,000.00',
      { price: 1000 },
    );
    expect(validateCompletion(record).accepted).toBe(true);
  });

  it('does not conflate textual currency and percentage qualifiers', () => {
    const wrongCurrency = webRecord(
      'What is the price?',
      'The price is $99',
      'The price is €99',
    );
    const missingPercent = webRecord(
      'What is the fee?',
      'The fee is 5%',
      'The fee is 5',
    );

    expect(validateCompletion(wrongCurrency).accepted).toBe(false);
    expect(validateCompletion(missingPercent).accepted).toBe(false);
  });

  it('distinguishes negative and positive numeric claims', () => {
    const record = webRecord(
      'What was the change?',
      'The measured change was -5%',
      'The measured change was 5%',
    );
    expect(validateCompletion(record).accepted).toBe(false);
  });

  it('uses task numbers for chatter context only', () => {
    const record = webRecord(
      'What happened in 2024?',
      'No matching result was found',
      'No matching result was found',
    );
    expect(findUngroundedFactSpans('SEARCHING 2024', buildContextCorpus(record))).toEqual([]);
    expect(findUngroundedFactSpans('ANSWER: 2024', buildGroundingCorpus(record))).toEqual(['2024']);
  });
});
