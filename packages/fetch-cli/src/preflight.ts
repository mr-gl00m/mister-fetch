/**
 * Startup preflight. Checks the things whose absence otherwise shows up as a
 * confusing failed Fetch ("max iterations reached") rather than an honest
 * "your model server is down". Runs once before the TUI renders.
 */

export type PreflightStatus = 'ok' | 'warn' | 'fail';

export interface PreflightLine {
  status: PreflightStatus;
  text: string;
}

export interface PreflightOpts {
  usingAnthropic: boolean;
  anthropicKeyPresent: boolean;
  ollamaBaseUrl: string;
  model: string;
}

export async function runPreflight(opts: PreflightOpts): Promise<PreflightLine[]> {
  const lines: PreflightLine[] = [];

  if (opts.usingAnthropic) {
    lines.push(
      opts.anthropicKeyPresent
        ? { status: 'ok', text: `provider: Anthropic (${opts.model}) — API key set` }
        : { status: 'fail', text: 'provider: Anthropic selected but ANTHROPIC_API_KEY is empty' },
    );
  } else {
    lines.push(await checkOllama(opts.ollamaBaseUrl, opts.model));
  }

  lines.push(checkSearch());
  return lines;
}

async function checkOllama(baseUrl: string, model: string): Promise<PreflightLine> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      return { status: 'fail', text: `provider: Ollama at ${baseUrl} returned HTTP ${res.status}` };
    }
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const names = (data.models ?? []).map((m) => m.name ?? '').filter(Boolean);
    const base = (s: string) => s.split(':')[0];
    const present = names.some((n) => n === model || base(n) === base(model));
    if (!present) {
      const have = names.slice(0, 4).join(', ') || 'none';
      return {
        status: 'warn',
        text: `provider: Ollama up at ${baseUrl}, but "${model}" is not pulled (have: ${have}). Run: ollama pull ${base(model)}`,
      };
    }
    return { status: 'ok', text: `provider: Ollama at ${baseUrl} — ${model} ready` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: 'fail',
      text: `provider: Ollama UNREACHABLE at ${baseUrl} (${msg}). Start it with: ollama serve`,
    };
  }
}

function checkSearch(): PreflightLine {
  if (process.env.SEARXNG_URL) {
    return { status: 'ok', text: `search: SearXNG (${process.env.SEARXNG_URL})` };
  }
  if (process.env.TAVILY_API_KEY) {
    return { status: 'ok', text: 'search: Tavily (API key set)' };
  }
  if (process.env.BRAVE_SEARCH_API_KEY ?? process.env.BRAVE_API_KEY) {
    return { status: 'ok', text: 'search: Brave (API key set)' };
  }
  return {
    status: 'warn',
    text: 'search: DuckDuckGo fallback (brittle). Set SEARXNG_URL, TAVILY_API_KEY, or BRAVE_SEARCH_API_KEY for reliable web research.',
  };
}

export function renderPreflight(lines: PreflightLine[]): string {
  const mark = (s: PreflightStatus) => (s === 'ok' ? '\x1b[32m✓\x1b[0m' : s === 'warn' ? '\x1b[33m!\x1b[0m' : '\x1b[31m✗\x1b[0m');
  return lines.map((l) => `  ${mark(l.status)} ${l.text}`).join('\n');
}
