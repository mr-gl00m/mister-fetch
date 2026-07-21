import {describe, expect, it} from 'vitest';

import {isValidFetchId} from './identity.js';

describe('fetch identity', () => {
  it('accepts only two uppercase letters, a dash, and one digit', () => {
    expect(isValidFetchId('KT-4')).toBe(true);
    expect(isValidFetchId('kt-4')).toBe(false);
    expect(isValidFetchId('KT-42')).toBe(false);
    expect(isValidFetchId('K-4')).toBe(false);
  });
});
