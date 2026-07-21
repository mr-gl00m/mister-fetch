/**
 * Hybrid acronym + substring fuzzy matcher.
 *
 * Reimplemented fresh in TS from the *shape* of Flow Launcher's
 * `StringMatcher` (`_examples/Flow.Launcher-dev/Flow.Launcher.Infrastructure/StringMatcher.cs`),
 * not copied from it. The idea: a file/command matcher that rewards
 *
 *   - exact substring match (most trusted)
 *   - camelCase / separator-boundary acronym match ("GNR" → "GetNextResult")
 *   - in-order character walk (fallback fuzzy)
 *
 * and returns a single normalized score. Used by the `local-find` tool
 * to rank Everything results against the user query text, and usable
 * stand-alone for any "pick the closest match" UI operation.
 *
 * Scoring is bounded roughly in [0, 1.0] but callers should sort by
 * score rather than interpret the absolute value.
 */

export interface FuzzyMatch {
  /** The original candidate string, unchanged. */
  candidate: string;
  /** Match score — higher is better. Non-matches return 0. */
  score: number;
  /** Indices in `candidate` that contributed to the match, in order. */
  matchedIndices: number[];
}

export interface FuzzyOptions {
  /** Force case-sensitive matching (default: case-insensitive). */
  caseSensitive?: boolean;
}

/**
 * Score a single candidate against a query. Returns { score: 0 } when
 * the query's characters can't be walked in order through the candidate.
 */
export function fuzzyScore(
  query: string,
  candidate: string,
  opts: FuzzyOptions = {},
): FuzzyMatch {
  const q = opts.caseSensitive ? query : query.toLowerCase();
  const c = opts.caseSensitive ? candidate : candidate.toLowerCase();
  if (!q) return { candidate, score: 0, matchedIndices: [] };
  if (!c) return { candidate, score: 0, matchedIndices: [] };

  // Exact substring — best possible match. Score rewards matches near
  // the start of the candidate (prefix > middle > suffix).
  const substrIdx = c.indexOf(q);
  if (substrIdx !== -1) {
    const positionBonus = 1 - substrIdx / Math.max(1, c.length);
    const lengthBonus = q.length / Math.max(1, c.length);
    const score = 0.7 + 0.2 * positionBonus + 0.1 * lengthBonus;
    const matchedIndices: number[] = [];
    for (let i = 0; i < q.length; i++) matchedIndices.push(substrIdx + i);
    return { candidate, score, matchedIndices };
  }

  // Acronym match — every query char must land on a word-boundary char
  // in the candidate. Word boundaries are the first char, any char after
  // a separator (space/dash/underscore/dot/slash), and the lowercase→
  // uppercase camel transitions.
  const boundaryAcronym = acronymWalk(q, candidate, c);
  if (boundaryAcronym) {
    return {
      candidate,
      score: 0.55 + 0.1 * (q.length / Math.max(1, candidate.length)),
      matchedIndices: boundaryAcronym,
    };
  }

  // In-order fuzzy walk — every query char must appear in order, but
  // not necessarily contiguously. Score rewards small gaps between
  // matches (dense runs = higher score) and early first-hit position.
  const walked = fuzzyWalk(q, c);
  if (walked) {
    const first = walked[0] ?? 0;
    const last = walked[walked.length - 1] ?? 0;
    const span = Math.max(1, last - first + 1);
    const density = q.length / span;
    const positionBonus = 1 - first / Math.max(1, c.length);
    const score = 0.1 + 0.25 * density + 0.1 * positionBonus;
    return { candidate, score, matchedIndices: walked };
  }

  return { candidate, score: 0, matchedIndices: [] };
}

/**
 * Score a list of candidates against a query, return the ones above
 * `threshold`, sorted descending. Non-matches are dropped.
 */
export function fuzzyPick(
  query: string,
  candidates: readonly string[],
  opts: FuzzyOptions & { threshold?: number; limit?: number } = {},
): FuzzyMatch[] {
  const threshold = opts.threshold ?? 0.0001;
  const matches: FuzzyMatch[] = [];
  for (const c of candidates) {
    const m = fuzzyScore(query, c, opts);
    if (m.score > threshold) matches.push(m);
  }
  matches.sort((a, b) => b.score - a.score);
  return opts.limit !== undefined ? matches.slice(0, opts.limit) : matches;
}

function acronymWalk(q: string, originalC: string, lowerC: string): number[] | null {
  const out: number[] = [];
  let qi = 0;
  for (let i = 0; i < originalC.length && qi < q.length; i++) {
    if (!isBoundary(originalC, i)) continue;
    if (lowerC[i] === q[qi]) {
      out.push(i);
      qi++;
    }
  }
  return qi === q.length ? out : null;
}

function fuzzyWalk(q: string, c: string): number[] | null {
  const out: number[] = [];
  let ci = 0;
  for (let qi = 0; qi < q.length; qi++) {
    let found = -1;
    for (; ci < c.length; ci++) {
      if (c[ci] === q[qi]) {
        found = ci;
        ci++;
        break;
      }
    }
    if (found === -1) return null;
    out.push(found);
  }
  return out;
}

const SEPARATOR_RE = /[\s\-_./\\]/;

function isBoundary(s: string, i: number): boolean {
  if (i === 0) return true;
  const prev = s[i - 1]!;
  if (SEPARATOR_RE.test(prev)) return true;
  const cur = s[i]!;
  // camelCase boundary: lowercase-then-uppercase.
  if (prev >= 'a' && prev <= 'z' && cur >= 'A' && cur <= 'Z') return true;
  return false;
}
