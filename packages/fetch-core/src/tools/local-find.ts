import { spawn } from 'node:child_process';
import type { Tool, ToolContext } from './registry.js';
import { fuzzyScore } from '../fuzzy.js';
import { assertAllowedLocalPath, defaultLocalSearchRoot } from './local-path-policy.js';

/**
 * local_find — filesystem metadata lookup via Everything's `es.exe` CLI.
 *
 * Everything is a separate Windows process that maintains a live NTFS
 * index of every filename on every mounted volume. `es.exe` is its
 * command-line client. When present, it returns tens of thousands of
 * results per second with zero warmup. When absent, the tool fails
 * cleanly with an install hint rather than falling back to a slow
 * `dir /s` walk — slow-walk pretending to be Everything is exactly the
 * thing we are NOT shipping.
 *
 * Contract: takes a query, returns a ranked list of
 * `{ path, name, directory }` records. Ranking is hybrid: Everything's
 * native order first, then re-scored against the query by `fuzzy.ts`
 * so camelCase and acronym matches bubble up alongside substring
 * matches.
 *
 * To install:
 *   1. Install Everything (https://www.voidtools.com/)
 *   2. Install the Everything Command Line Interface (es.exe)
 *   3. Put es.exe on PATH, or set MISTER_FETCH_ES_PATH to its full path.
 *
 * This tool is Windows-first. On macOS/Linux the dream is
 * `mdfind`/`locate`/`plocate`; a future port sits behind a platform
 * check here.
 */

export interface LocalFindArgs {
  query: string;
  limit?: number;
  extension?: string;
  path?: string;
}

export interface LocalFindHit {
  path: string;
  name: string;
  directory: string;
  score?: number;
}

const ES_TIMEOUT_MS = 5_000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

export const localFindTool: Tool = {
  name: 'local_find',
  description:
    'Find files and folders on this machine by name. ' +
    'Args: { query: string, limit?: number (1..200, default 25), ' +
    'extension?: string (e.g. "pdf"), path?: string (restrict to a folder) }. ' +
    'Returns a ranked list of { path, name, directory }. ' +
    'Uses Everything (es.exe) — instant on Windows. Does NOT read file contents; ' +
    'for content search use local_grep or local_doc_grep.',

  async execute(args: unknown, ctx: ToolContext): Promise<LocalFindHit[]> {
    const { query, limit, extension, path } = parseArgs(args);
    if (process.platform !== 'win32') {
      throw new Error(
        'local_find: es.exe integration is Windows-only. ' +
          'Linux/macOS adapter (mdfind/plocate) is not yet implemented.',
      );
    }

    const esPath = process.env.MISTER_FETCH_ES_PATH ?? 'es.exe';
    const scopedPath = path
      ? await assertAllowedLocalPath(path, 'local_find')
      : await defaultLocalSearchRoot('local_find');
    const esArgs = buildEsArgs(query, limit, extension, scopedPath);

    let stdout: string;
    try {
      stdout = await runEs(esPath, esArgs, ctx.signal);
    } catch (e) {
      if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          'local_find: es.exe not found. Install Everything + the Everything CLI from ' +
            'https://www.voidtools.com/ and put es.exe on PATH, or set MISTER_FETCH_ES_PATH.',
        );
      }
      throw e;
    }

    const hits = parseEsStdout(stdout);
    if (hits.length === 0) return [];

    // Re-rank via fuzzy matcher against the filename (not the full path)
    // so "report" doesn't lose to a deep-nested non-report path. Score each
    // hit individually rather than keying a map by filename: two files with
    // the same name in different folders must both survive, each with its own
    // path. (BH-2026-07-04-004)
    const out = hits
      .map((h) => ({ hit: h, score: fuzzyScore(query, h.name).score }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({ ...s.hit, score: s.score }));
    // Anything that didn't score but Everything still returned — keep
    // at the tail so we don't drop valid results on a degenerate query.
    if (out.length === 0) {
      return hits.slice(0, limit);
    }
    return out;
  },
};

function parseArgs(args: unknown): {
  query: string;
  limit: number;
  extension: string | null;
  path: string | null;
} {
  if (typeof args !== 'object' || args === null) {
    throw new Error('local_find: args must be an object');
  }
  const a = args as Record<string, unknown>;
  const query = typeof a.query === 'string' ? a.query.trim() : '';
  if (!query) throw new Error('local_find: args.query (non-empty string) required');

  let limit = DEFAULT_LIMIT;
  if (typeof a.limit === 'number' && Number.isFinite(a.limit)) {
    limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(a.limit)));
  }

  const extension =
    typeof a.extension === 'string' && a.extension.trim()
      ? a.extension.replace(/^\./, '').trim()
      : null;
  const path =
    typeof a.path === 'string' && a.path.trim() ? a.path.trim() : null;

  return { query, limit, extension, path };
}

function buildEsArgs(
  query: string,
  limit: number,
  extension: string | null,
  path: string | null,
): string[] {
  const args: string[] = ['-n', String(limit), '-full-path-and-name'];
  if (extension) args.push('-ext', extension);
  if (path) args.push('-path', path);
  args.push(query);
  return args;
}

async function runEs(esPath: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(esPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`local_find: es.exe timed out after ${ES_TIMEOUT_MS}ms`));
    }, ES_TIMEOUT_MS);
    const abort = () => {
      proc.kill();
      reject(new Error('local_find: aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (code !== 0) {
        reject(new Error(`local_find: es.exe exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseEsStdout(stdout: string): LocalFindHit[] {
  const out: LocalFindHit[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const path = line.trim();
    if (!path) continue;
    const sep = path.lastIndexOf('\\') >= 0 ? '\\' : '/';
    const idx = path.lastIndexOf(sep);
    const name = idx >= 0 ? path.slice(idx + 1) : path;
    const directory = idx >= 0 ? path.slice(0, idx) : '';
    out.push({ path, name, directory });
  }
  return out;
}
