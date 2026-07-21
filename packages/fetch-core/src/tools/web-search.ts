import type { Tool, ToolContext } from './registry.js';
import { fuseRankings, type FusionInput } from '../rank-fusion.js';

/**
 * Multi-provider web search.
 *
 * When `SEARXNG_URL` is set, that instance is fanned out in parallel
 * with the first available commercial provider (Tavily → Brave → DDG)
 * and their ranked lists are merged via reciprocal-rank fusion from
 * `rank-fusion.ts`. Providers default to equal weight. Any future weighting
 * requires relevance measurements rather than source-type assumptions.
 *
 * When SEARXNG_URL is not set, behavior falls back to the original
 * single-provider chain:
 *   1. Tavily      (TAVILY_API_KEY)       — best quality for agents
 *   2. Brave       (BRAVE_SEARCH_API_KEY) — generous free tier
 *   3. DuckDuckGo  (no key)               — zero-config HTML fallback
 *
 * DDG is intentionally brittle — it scrapes HTML and breaks when layout
 * shifts. Keep it as a last-resort only.
 */

export interface WebSearchArgs {
  query: string;
  count?: number;
  limit?: number;
  topic?: 'general' | 'news';
  days?: number;
  provider?: 'tavily' | 'brave' | 'duckduckgo';
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

type SearchTopic = 'general' | 'news';
type SearchProvider = 'tavily' | 'brave' | 'duckduckgo';

interface ParsedArgs {
  query: string;
  count: number;
  topic: SearchTopic;
  days: number;
  provider: SearchProvider | undefined;
}

const SEARCH_TIMEOUT_MS = 15_000;
const MIN_RESULTS = 1;
const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;
const MAX_QUERY_LEN = 400;
const DEFAULT_NEWS_DAYS = 3;
const USER_AGENT =
  'MisterFetch/0.1 (https://github.com/mister-fetch; single-shot disposable agent)';

export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Search the web. Args: { query: string, count?: number (1..10, default 5), ' +
    'topic?: "general" | "news", days?: number (news recency, 1..30), ' +
    'provider?: "tavily" | "brave" | "duckduckgo" }. ' +
    'When SEARXNG_URL is set, SearXNG is fanned out in parallel with the ' +
    'first configured commercial provider and results are merged by reciprocal-rank fusion. ' +
    'Otherwise falls back to a single provider chosen from env. ' +
    'Returns a list of { title, url, snippet } objects.',

  async execute(args: unknown, ctx: ToolContext): Promise<WebSearchResult[]> {
    const parsed = parseArgs(args);
    const signal = combineSignals(ctx.signal, SEARCH_TIMEOUT_MS);
    const searxngUrl = process.env.SEARXNG_URL;

    // Fan-out path: SearXNG + one commercial provider merged via RRF.
    // Both branches are awaited in parallel; a single provider failure
    // degrades gracefully to the other branch's list.
    if (searxngUrl && !parsed.provider) {
      const commercial = pickCommercialProvider();
      const runs: Array<Promise<FusionInput<WebSearchResult>>> = [];
      runs.push(
        runProvider('searxng', () => searchSearxng(parsed, searxngUrl, signal), 1.0),
      );
      if (commercial) {
        runs.push(
          runProvider(commercial, () => dispatchCommercial(commercial, parsed, signal), 1.0),
        );
      }
      const settled = await Promise.all(runs);
      const inputs = settled.filter((s) => s.hits.length > 0);
      if (inputs.length === 0) {
        throw new Error(
          `web_search: fan-out produced no results for "${parsed.query}" ` +
            `(providers: ${settled.map((s) => s.provider).join(', ')})`,
        );
      }
      return fuseRankings(inputs, { limit: parsed.count });
    }

    // Single-provider fallback path — original behavior.
    const provider = resolveProvider(parsed.provider);
    let results: WebSearchResult[];
    try {
      results = await dispatchCommercial(provider, parsed, signal);
    } catch (e) {
      if (e instanceof Error && e.name === 'TimeoutError') {
        throw new Error(
          `web_search: ${provider} timed out after ${SEARCH_TIMEOUT_MS}ms`,
        );
      }
      throw e;
    }

    if (results.length === 0) {
      throw new Error(
        `web_search: no results for "${parsed.query}" (provider: ${provider})`,
      );
    }
    return results;
  },
};

async function dispatchCommercial(
  provider: SearchProvider,
  parsed: ParsedArgs,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  switch (provider) {
    case 'tavily':
      return searchTavily(parsed, signal);
    case 'brave':
      return searchBrave(parsed, signal);
    default:
      return searchDuckDuckGo(parsed, signal);
  }
}

function pickCommercialProvider(): SearchProvider | null {
  if (process.env.TAVILY_API_KEY) return 'tavily';
  if (process.env.BRAVE_SEARCH_API_KEY ?? process.env.BRAVE_API_KEY) return 'brave';
  // DDG is brittle — don't include it in the fan-out by default, only as
  // the single-provider degraded path. If SearXNG is up, it covers DDG.
  return null;
}

async function runProvider(
  provider: string,
  fn: () => Promise<WebSearchResult[]>,
  weight: number,
): Promise<FusionInput<WebSearchResult>> {
  try {
    const hits = await fn();
    return { provider, hits, weight };
  } catch (e) {
    // Swallow per-provider failures — RRF tolerates an empty branch and
    // surfaces whatever the other branch returned. The caller sees an
    // error only if EVERY branch failed.
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[web_search] provider "${provider}" failed: ${msg}`);
    return { provider, hits: [], weight };
  }
}

function parseArgs(args: unknown): ParsedArgs {
  if (typeof args !== 'object' || args === null) {
    throw new Error('web_search: args must be an object');
  }
  const a = args as Record<string, unknown>;

  const query = typeof a.query === 'string' ? a.query.trim() : '';
  if (!query) {
    throw new Error('web_search: args.query (non-empty string) required');
  }
  if (query.length > MAX_QUERY_LEN) {
    throw new Error(
      `web_search: query too long (${query.length} > ${MAX_QUERY_LEN})`,
    );
  }

  const rawCount =
    typeof a.count === 'number'
      ? a.count
      : typeof a.limit === 'number'
        ? a.limit
        : undefined;
  let count = DEFAULT_RESULTS;
  if (rawCount !== undefined && Number.isFinite(rawCount)) {
    count = Math.max(MIN_RESULTS, Math.min(MAX_RESULTS, Math.round(rawCount)));
  }

  const explicitTopic =
    typeof a.topic === 'string' ? a.topic.toLowerCase() : '';
  const topic: SearchTopic =
    explicitTopic === 'news'
      ? 'news'
      : explicitTopic === 'general'
        ? 'general'
        : looksLikeNewsQuery(query)
          ? 'news'
          : 'general';

  let days = DEFAULT_NEWS_DAYS;
  if (typeof a.days === 'number' && Number.isFinite(a.days)) {
    days = Math.max(1, Math.min(30, Math.round(a.days)));
  }

  let provider: SearchProvider | undefined;
  if (typeof a.provider === 'string') {
    const p = a.provider.toLowerCase();
    if (p === 'tavily' || p === 'brave' || p === 'duckduckgo') provider = p;
  }

  return { query, count, topic, days, provider };
}

function resolveProvider(explicit: SearchProvider | undefined): SearchProvider {
  if (explicit) return explicit;
  if (process.env.TAVILY_API_KEY) return 'tavily';
  if (process.env.BRAVE_SEARCH_API_KEY ?? process.env.BRAVE_API_KEY) {
    return 'brave';
  }
  return 'duckduckgo';
}

function combineSignals(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeoutSignal]) : timeoutSignal;
}

async function searchSearxng(
  p: ParsedArgs,
  baseUrl: string,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  // SearXNG exposes /search with ?format=json. The upstream JSON schema
  // returns { results: [{ title, url, content, engine, ... }] } — we
  // pick off the fields we care about, drop anything without a URL, and
  // respect the requested count. We do not pass SearXNG's categories /
  // engines selectors; the admin of the instance owns that.
  const base = baseUrl.replace(/\/+$/, '');
  const url =
    `${base}/search?format=json&q=${encodeURIComponent(p.query)}` +
    `&safesearch=0&language=en`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    signal,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`SearXNG HTTP ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const hits: WebSearchResult[] = [];
  for (const r of data.results ?? []) {
    if (!r.url || !r.title) continue;
    hits.push({
      title: stripHtml(r.title).trim(),
      url: r.url,
      snippet: stripHtml(r.content ?? '').trim(),
    });
    if (hits.length >= p.count) break;
  }
  return hits;
}

async function searchTavily(
  p: ParsedArgs,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('web_search: TAVILY_API_KEY is not set');

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      api_key: apiKey,
      query: p.query,
      max_results: p.count,
      search_depth: 'basic',
      topic: p.topic,
      ...(p.topic === 'news' ? { days: p.days } : {}),
    }),
    signal,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Tavily HTTP ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (data.results ?? []).slice(0, p.count).map((r) => ({
    title: (r.title ?? '').trim(),
    url: r.url ?? '',
    snippet: (r.content ?? '').trim(),
  }));
}

async function searchBrave(
  p: ParsedArgs,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const apiKey =
    process.env.BRAVE_SEARCH_API_KEY ?? process.env.BRAVE_API_KEY;
  if (!apiKey) throw new Error('web_search: BRAVE_SEARCH_API_KEY is not set');

  const isNews = p.topic === 'news';
  const endpoint = isNews
    ? 'https://api.search.brave.com/res/v1/news/search'
    : 'https://api.search.brave.com/res/v1/web/search';
  const freshness = p.days <= 1 ? 'pd' : p.days <= 7 ? 'pw' : 'pm';
  const url =
    `${endpoint}?q=${encodeURIComponent(p.query)}&count=${p.count}` +
    (isNews ? `&freshness=${freshness}` : '');

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
      'User-Agent': USER_AGENT,
    },
    signal,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Brave HTTP ${res.status}: ${err.slice(0, 200)}`);
  }

  if (isNews) {
    const data = (await res.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        description?: string;
        age?: string;
      }>;
    };
    return (data.results ?? []).slice(0, p.count).map((r) => ({
      title: stripHtml(r.title ?? '').trim(),
      url: r.url ?? '',
      snippet:
        (r.age ? `[${r.age}] ` : '') + stripHtml(r.description ?? '').trim(),
    }));
  }

  const data = (await res.json()) as {
    web?: {
      results?: Array<{ title?: string; url?: string; description?: string }>;
    };
  };
  return (data.web?.results ?? []).slice(0, p.count).map((r) => ({
    title: stripHtml(r.title ?? '').trim(),
    url: r.url ?? '',
    snippet: stripHtml(r.description ?? '').trim(),
  }));
}

async function searchDuckDuckGo(
  p: ParsedArgs,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(p.query)}`;
  const res = await fetch(url, {
    headers: {
      // DDG rejects the default fetch UA; a real browser string is required.
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
    signal,
  });
  if (!res.ok) {
    throw new Error(`DuckDuckGo HTTP ${res.status}`);
  }
  const html = await res.text();
  return parseDuckDuckGoHtml(html, p.count);
}

function parseDuckDuckGoHtml(html: string, count: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  // Each result block: result__a anchor (href+title) then result__snippet
  // anchor. Brittle by design — DDG layout changes surface as empty results.
  const pattern =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null && results.length < count) {
    const rawUrl = match[1] ?? '';
    const rawTitle = match[2] ?? '';
    const rawSnippet = match[3] ?? '';
    const decoded = decodeDuckDuckGoUrl(rawUrl);
    if (!decoded) continue;
    const title = stripHtml(rawTitle).trim();
    if (!title) continue;
    results.push({
      title,
      url: decoded,
      snippet: stripHtml(rawSnippet).trim(),
    });
  }
  return results;
}

function decodeDuckDuckGoUrl(raw: string): string {
  try {
    const absolute = raw.startsWith('//') ? `https:${raw}` : raw;
    const parsed = new URL(absolute);
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return absolute;
  } catch {
    return raw;
  }
}

// High-precision news heuristic — false positives push general queries
// into the news vertical (fewer results), so rather miss a news query
// than misclassify a general one.
function looksLikeNewsQuery(query: string): boolean {
  const q = query.toLowerCase();
  return /\b(news|headlines?|breaking|today'?s|this week|latest|recent|current events?|patch notes?|update|announcement|press release)\b/.test(
    q,
  );
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Logged at module import so it fires once on supervisor start rather
// than per-call. DDG fallback works but is brittle; production should
// set a real key OR point at a local SearXNG instance.
if (
  !process.env.SEARXNG_URL &&
  !process.env.TAVILY_API_KEY &&
  !process.env.BRAVE_SEARCH_API_KEY &&
  !process.env.BRAVE_API_KEY
) {
  console.warn(
    '[web_search] no SearXNG instance or commercial API key configured — falling back to brittle DuckDuckGo HTML scraper. ' +
      'Set SEARXNG_URL (e.g. http://localhost:8888), TAVILY_API_KEY (https://tavily.com), or BRAVE_SEARCH_API_KEY for production.',
  );
}
