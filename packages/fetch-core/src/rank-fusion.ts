/**
 * Reciprocal-rank fusion over an arbitrary number of ranked result lists.
 *
 * Given N providers each returning an ordered list of hits, merge them
 * into one ranked list where each unique URL's score is the sum of
 * `weight / (k + rank)` across the providers that returned it. Higher
 * score wins. Dedupe is by normalized URL; title+snippet from the
 * highest-scoring provider-seen-first is kept.
 *
 * This is the Reciprocal Rank Fusion construction described by Cormack,
 * Clarke, and Buettcher (SIGIR 2009), implemented directly in TypeScript.
 * Parameters:
 *   - `k = 60` is the paper's pilot-tuned constant that damps the gap between
 *     rank 1 and rank 2 so a single provider can't monopolize the top.
 *   - Per-provider weights default to 1.0 and get passed in by callers
 *     that want to bias (e.g., SearXNG-aggregated result > single
 *     fallback provider).
 *
 * Interface is shaped so the reranker (`rerank.ts`) can consume the
 * output unchanged. Returned items are `{ title, url, snippet }`.
 */

export interface FusionHit {
  title: string;
  url: string;
  snippet: string;
}

export interface FusionInput<T extends FusionHit> {
  /** Identifier for debugging/logging; not used in the score. */
  provider: string;
  /** Ordered list, rank 0 = best. */
  hits: readonly T[];
  /** Multiplier on this provider's contribution. Default 1.0. */
  weight?: number;
}

export interface FusionOptions {
  /** RRF damping constant. Default 60 (SearXNG default). */
  k?: number;
  /** Cap the returned list to this length. Default unlimited. */
  limit?: number;
}

const DEFAULT_K = 60;

export function fuseRankings<T extends FusionHit>(
  inputs: readonly FusionInput<T>[],
  opts: FusionOptions = {},
): T[] {
  const k = opts.k ?? DEFAULT_K;
  if (!Number.isFinite(k) || k < 0) {
    throw new Error('RRF k must be finite and non-negative');
  }
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 0)) {
    throw new Error('RRF limit must be a non-negative integer');
  }
  const scored = new Map<string, { hit: T; score: number; firstRank: number }>();

  for (const input of inputs) {
    const weight = input.weight ?? 1.0;
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`RRF weight for provider "${input.provider}" must be finite and non-negative`);
    }
    const providerSeen = new Set<string>();
    let uniqueRank = 0;
    for (const hit of input.hits) {
      if (!hit) continue;
      const key = normalizeUrl(hit.url);
      if (!key) continue;
      if (providerSeen.has(key)) continue;
      providerSeen.add(key);
      const contribution = weight / (k + uniqueRank + 1);
      const existing = scored.get(key);
      if (existing) {
        existing.score += contribution;
        // Keep the earliest-ranked representation (usually richest snippet).
        if (uniqueRank < existing.firstRank) {
          existing.hit = hit;
          existing.firstRank = uniqueRank;
        }
      } else {
        scored.set(key, { hit, score: contribution, firstRank: uniqueRank });
      }
      uniqueRank += 1;
    }
  }

  const sorted = [...scored.values()].sort((a, b) => b.score - a.score);
  const limited = opts.limit !== undefined ? sorted.slice(0, opts.limit) : sorted;
  return limited.map((s) => s.hit);
}

function normalizeUrl(raw: string): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.hash = '';
    const drop = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
      'ref',
      'ref_src',
    ];
    for (const p of drop) u.searchParams.delete(p);
    // Strip trailing slash on the pathname so /foo and /foo/ dedupe.
    const path = u.pathname.replace(/\/$/, '') || '/';
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}
