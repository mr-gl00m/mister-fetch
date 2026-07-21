import type { FetchId } from './types.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';

export function generateFetchId(inUse: ReadonlySet<FetchId>): FetchId {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const l1 = LETTERS.charAt(Math.floor(Math.random() * 26));
    const l2 = LETTERS.charAt(Math.floor(Math.random() * 26));
    const d = DIGITS.charAt(Math.floor(Math.random() * 10));
    const id: FetchId = `${l1}${l2}-${d}`;
    if (!inUse.has(id)) return id;
  }
  throw new Error('Fetch ID space exhausted — 6760 concurrent Fetches? Calm down.');
}

export function isValidFetchId(s: string): boolean {
  return /^[A-Z]{2}-[0-9]$/.test(s);
}
