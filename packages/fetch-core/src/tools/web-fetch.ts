import type { Tool, ToolContext } from './registry.js';
import { assertPublicUrl } from './ssrf.js';

/**
 * web_fetch — minimal GET + HTML-to-text tool.
 *
 * Purpose: give the worker a way to pull an article body into the
 * grounding corpus without paying Playwright startup or holding a
 * browser context open. Complements `browser` rather than replacing
 * it — use `browser` when you need JS rendering, cookies, or
 * click-through; use `web_fetch` when you just want the readable text
 * from a well-behaved page so the validator has something to cite.
 *
 * The HTML-to-text pass is deliberately simple: strip <script>/<style>/
 * <noscript>, flatten tags to whitespace, collapse runs of whitespace,
 * decode the handful of entities the worker is likely to hit. It is
 * NOT a Readability implementation — Quality mode's deep-scrape leaf
 * (Phase 3b) will add that.
 */

export interface WebFetchArgs {
  url: string;
  maxChars?: number;
}

export interface WebFetchResult {
  url: string;
  status: number;
  title: string;
  text: string;
  truncated: boolean;
}

const FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_CHARS = 6_000;
const HARD_MAX_CHARS = 20_000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description:
    'Fetch a single URL and return its readable text body. ' +
    'Args: { url: string, maxChars?: number (default 6000, max 20000) }. ' +
    'Returns { url, status, title, text, truncated }. ' +
    'Use when you have a URL from web_search and want its body as grounding ' +
    'material without spinning up the headless browser. Does not execute JS.',

  async execute(args: unknown, ctx: ToolContext): Promise<WebFetchResult> {
    const { url, maxChars } = parseArgs(args);
    const signal = combineSignals(ctx.signal, FETCH_TIMEOUT_MS);

    // SSRF-guarded fetch: every hop, including redirects, is checked against
    // the private-host blocklist before the request goes out (BH-2026-07-04-001).
    const res = await guardedFetch(url, signal);
    if (!res.ok) {
      throw new Error(`web_fetch: HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    const raw = await res.text();

    let title = '';
    let body = raw;
    if (contentType.includes('html') || looksLikeHtml(raw)) {
      const extracted = extractFromHtml(raw);
      title = extracted.title;
      body = extracted.text;
    }

    const truncated = body.length > maxChars;
    const text = truncated ? body.slice(0, maxChars) : body;
    return {
      url: res.url || url,
      status: res.status,
      title,
      text,
      truncated,
    };
  },
};

const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch with SSRF checks on every hop. Uses redirect: "manual" so a public URL
 * that redirects to a private target (169.254.169.254, localhost, a LAN host)
 * is caught before the follow-up request goes out, which redirect: "follow"
 * would not do.
 */
async function guardedFetch(startUrl: string, signal: AbortSignal): Promise<Response> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal,
      redirect: 'manual',
    });
    if (!REDIRECT_STATUS.has(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    current = new URL(location, current).toString();
  }
  throw new Error(`web_fetch: too many redirects (> ${MAX_REDIRECTS})`);
}

function parseArgs(args: unknown): { url: string; maxChars: number } {
  if (typeof args !== 'object' || args === null) {
    throw new Error('web_fetch: args must be an object');
  }
  const a = args as Record<string, unknown>;
  const rawUrl = typeof a.url === 'string' ? a.url.trim() : '';
  if (!rawUrl) throw new Error('web_fetch: args.url (non-empty string) required');
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`web_fetch: unsupported protocol "${u.protocol}"`);
    }
  } catch (e) {
    throw new Error(`web_fetch: invalid url "${rawUrl}": ${e instanceof Error ? e.message : String(e)}`);
  }

  let maxChars = DEFAULT_MAX_CHARS;
  if (typeof a.maxChars === 'number' && Number.isFinite(a.maxChars)) {
    maxChars = Math.max(500, Math.min(HARD_MAX_CHARS, Math.round(a.maxChars)));
  }
  return { url: rawUrl, maxChars };
}

function combineSignals(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeoutSignal]) : timeoutSignal;
}

function looksLikeHtml(s: string): boolean {
  const head = s.slice(0, 500).toLowerCase();
  return head.includes('<html') || head.includes('<!doctype') || head.includes('<body');
}

function extractFromHtml(html: string): { title: string; text: string } {
  // Drop anything that never renders or carries no useful text.
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ');

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s);
  const title = titleMatch?.[1] ? decodeEntities(stripTags(titleMatch[1])).trim() : '';

  // Flatten tags to spaces — preserves word boundaries better than
  // "".
  s = s.replace(/<\/?(?:br|p|div|li|tr|h[1-6])[^>]*>/gi, '\n');
  s = stripTags(s);
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n');
  return { title, text: s.trim() };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => codePointOrEmpty(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePointOrEmpty(parseInt(h, 16)));
}

function codePointOrEmpty(code: number): string {
  // String.fromCodePoint throws RangeError outside U+0000..U+10FFFF and for
  // lone surrogates. A malformed numeric entity (&#9999999999;) must not abort
  // the whole fetch. (BH-2026-07-04-002)
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return '';
  if (code >= 0xd800 && code <= 0xdfff) return '';
  return String.fromCodePoint(code);
}
