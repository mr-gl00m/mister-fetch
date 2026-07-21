/**
 * Minimal text-overlap reranker for search hits. Used by the worker loop
 * in Balanced / Quality mode to trim noisy result sets to a focused top-K
 * before they enter the grounding corpus and the recent-tool-calls log.
 *
 * This is the *floor* implementation — it uses pure token-recall with a
 * small stopword list, no embeddings, no ML. The interface is shaped so
 * that an embedding-backed reranker (cosine similarity over a query
 * vector and hit vectors) is a drop-in replacement: swap the scoring
 * function, keep the rest.
 */

export interface RerankableHit {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  [k: string]: unknown;
}

export interface RerankOptions {
  topK: number;
  /** Drop hits scoring below this fraction of max possible. Range [0, 1]. */
  threshold: number;
}

export interface RerankResult<T extends RerankableHit> {
  kept: T[];
  dropped: number;
  /** Parallel array of scores for `kept`, in the same order. Useful for debug/logging. */
  scores: number[];
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'from', 'with',
  'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'has', 'have', 'had', 'this', 'that', 'these', 'those',
  'it', 'its', 'as', 'if', 'than', 'then', 'so', 'not',
]);

const MIN_TOKEN_LEN = 3;

function tokenize(s: string): string[] {
  const out: string[] = [];
  const parts = s.toLowerCase().split(/[^a-z0-9]+/);
  for (const p of parts) {
    if (p.length < MIN_TOKEN_LEN) continue;
    if (STOPWORDS.has(p)) continue;
    out.push(p);
  }
  return out;
}

function asString(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x == null) return '';
  return String(x);
}

function hitText(hit: RerankableHit): string {
  const title = asString(hit.title);
  const snippet = asString(hit.snippet);
  return `${title}\n${snippet}`;
}

function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const u = new URL(raw);
    // Strip common tracking params + fragment, lowercase host.
    u.hash = '';
    const drop = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'fbclid', 'gclid', 'ref', 'ref_src',
    ];
    for (const k of drop) u.searchParams.delete(k);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname}${u.search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

/**
 * Rerank and trim a list of search hits against a query. Deduplicates by
 * normalized URL, scores each unique hit by token-recall (fraction of
 * query tokens that appear in title+snippet), filters below threshold,
 * sorts descending, returns top K.
 *
 * If the query tokenizes to nothing (very short or all stopwords), the
 * reranker falls through: returns the first K hits unchanged with zero
 * scores so we don't accidentally nuke a result set on a degenerate query.
 */
export function rerankHits<T extends RerankableHit>(
  query: string,
  hits: readonly T[],
  opts: RerankOptions,
): RerankResult<T> {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) {
    const kept = hits.slice(0, opts.topK);
    return { kept: [...kept], dropped: Math.max(0, hits.length - kept.length), scores: kept.map(() => 0) };
  }

  const seen = new Set<string>();
  const scored: Array<{ hit: T; score: number }> = [];

  for (const hit of hits) {
    const url = normalizeUrl(hit.url);
    const dedupKey = url ?? asString(hit.title).toLowerCase().trim();
    if (dedupKey && seen.has(dedupKey)) continue;
    if (dedupKey) seen.add(dedupKey);

    const hitTokens = new Set(tokenize(hitText(hit)));
    let hits_ = 0;
    for (const q of queryTokens) {
      if (hitTokens.has(q)) hits_++;
    }
    const score = hits_ / queryTokens.size;
    if (score < opts.threshold) continue;
    scored.push({ hit, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, opts.topK);
  return {
    kept: top.map((s) => s.hit),
    dropped: hits.length - top.length,
    scores: top.map((s) => s.score),
  };
}

/**
 * Best-effort detector: is this tool result shaped like a search-hit array
 * we can rerank? Used by the worker loop to decide whether to post-process
 * a tool result. Returns the array (cast narrowed) or null.
 */
export function asHitArray(result: unknown): RerankableHit[] | null {
  if (!Array.isArray(result)) return null;
  if (result.length === 0) return null;
  for (const h of result) {
    if (h == null || typeof h !== 'object') return null;
    const obj = h as Record<string, unknown>;
    if (!('title' in obj) && !('url' in obj)) return null;
  }
  return result as RerankableHit[];
}
