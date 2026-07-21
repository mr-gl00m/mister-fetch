import {describe, expect, it} from 'vitest';

import {matchActionKeyword} from './action-keywords.js';

describe('action-keyword routing', () => {
  it('routes f: to local_find with the whole rest as query', () => {
    const m = matchActionKeyword('f: invoice 2024');
    expect(m?.tool).toBe('local_find');
    expect(m?.args).toEqual({ query: 'invoice 2024', limit: 25 });
  });

  it('splits a trailing path token off g: (the documented "g: TODO packages/" shape)', () => {
    const m = matchActionKeyword('g: TODO packages/');
    expect(m?.tool).toBe('local_grep');
    expect(m?.args).toEqual({ pattern: 'TODO', path: 'packages/', limit: 30 });
  });

  it('splits backslash and dot-relative paths too', () => {
    expect(matchActionKeyword('g: anguish packages\\fetch-core\\src')?.args).toEqual({
      pattern: 'anguish',
      path: 'packages\\fetch-core\\src',
      limit: 30,
    });
    expect(matchActionKeyword('g: fixme ..')?.args).toEqual({
      pattern: 'fixme',
      path: '..',
      limit: 30,
    });
  });

  it('keeps a single token with a slash as the pattern, not a path', () => {
    const m = matchActionKeyword('g: foo/bar');
    expect(m?.args).toEqual({ pattern: 'foo/bar', limit: 30 });
  });

  it('leaves a bare trailing word in the pattern', () => {
    const m = matchActionKeyword('g: error rate spike');
    expect(m?.args).toEqual({ pattern: 'error rate spike', limit: 30 });
  });

  it('applies the same split to dg: with its own limit', () => {
    const m = matchActionKeyword('dg: invoice total .docs/');
    expect(m?.tool).toBe('local_doc_grep');
    expect(m?.args).toEqual({ pattern: 'invoice total', path: '.docs/', limit: 20 });
  });

  it('returns null for non-keyword input and empty rests', () => {
    expect(matchActionKeyword('find me the top ten email services')).toBeNull();
    expect(matchActionKeyword('g:')).toBeNull();
    expect(matchActionKeyword('zz: whatever')).toBeNull();
  });
});
