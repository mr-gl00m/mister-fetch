import { spawn } from 'node:child_process';
import type { Tool, ToolContext } from './registry.js';
import { assertAllowedLocalPath, defaultLocalSearchRoot } from './local-path-policy.js';

/**
 * local_grep — file-content search via ripgrep (`rg`).
 *
 * Spawns `rg --json` so we get per-match newline-delimited JSON that's
 * trivially streaming-parseable. Returns a flat list of
 * `{ file, line, text, column? }` records, capped at `limit`.
 *
 * Why not a Node-native grep? ripgrep is faster than anything we could
 * write in TS, respects `.gitignore`, handles binary detection, and is
 * already on most developer machines. If it's missing we fail cleanly
 * rather than fall back to a slow walk — same doctrine as `local-find`.
 *
 * Safety: the pattern is passed to rg as an argument, NOT shell-interpolated.
 * The one risk vector left is rg's own regex engine, which is well-sandboxed
 * and refuses pathological patterns via its `--regex-size-limit`.
 */

export interface LocalGrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  limit?: number;
  ignoreCase?: boolean;
  literal?: boolean;
  contextLines?: number;
}

export interface LocalGrepHit {
  file: string;
  line: number;
  column?: number;
  text: string;
}

const RG_TIMEOUT_MS = 15_000;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 500;
const DEFAULT_CONTEXT = 0;
const MAX_CONTEXT = 4;

export const localGrepTool: Tool = {
  name: 'local_grep',
  description:
    'Search file CONTENTS for a pattern via ripgrep. ' +
    'Args: { pattern: string, path?: string (default: cwd), glob?: string (e.g. "*.ts"), ' +
    'limit?: number (1..500, default 30), ignoreCase?: boolean, literal?: boolean (treat pattern as fixed string), ' +
    'contextLines?: number (0..4, lines of context around each match) }. ' +
    'Returns a list of { file, line, text } hits. Respects .gitignore by default. ' +
    'For PDF/Office/EPUB/archive content, use local_doc_grep instead.',

  async execute(args: unknown, ctx: ToolContext): Promise<LocalGrepHit[]> {
    const parsed = parseArgs(args);
    parsed.path = parsed.path
      ? await assertAllowedLocalPath(parsed.path, 'local_grep')
      : await defaultLocalSearchRoot('local_grep');
    const rgPath = process.env.MISTER_FETCH_RG_PATH ?? 'rg';
    const rgArgs = buildRgArgs(parsed);

    let stdout: string;
    try {
      stdout = await runRg(rgPath, rgArgs, ctx.signal);
    } catch (e) {
      if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          'local_grep: ripgrep (rg) not found. Install from https://github.com/BurntSushi/ripgrep/releases ' +
            'and put it on PATH, or set MISTER_FETCH_RG_PATH.',
        );
      }
      throw e;
    }

    return parseRgJsonLines(stdout, parsed.limit);
  },
};

interface ParsedArgs {
  pattern: string;
  path: string | null;
  glob: string | null;
  limit: number;
  ignoreCase: boolean;
  literal: boolean;
  contextLines: number;
}

function parseArgs(args: unknown): ParsedArgs {
  if (typeof args !== 'object' || args === null) {
    throw new Error('local_grep: args must be an object');
  }
  const a = args as Record<string, unknown>;
  const pattern = typeof a.pattern === 'string' ? a.pattern : '';
  if (!pattern) throw new Error('local_grep: args.pattern (non-empty string) required');

  const path = typeof a.path === 'string' && a.path.trim() ? a.path.trim() : null;
  const glob = typeof a.glob === 'string' && a.glob.trim() ? a.glob.trim() : null;

  let limit = DEFAULT_LIMIT;
  if (typeof a.limit === 'number' && Number.isFinite(a.limit)) {
    limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(a.limit)));
  }
  let contextLines = DEFAULT_CONTEXT;
  if (typeof a.contextLines === 'number' && Number.isFinite(a.contextLines)) {
    contextLines = Math.max(0, Math.min(MAX_CONTEXT, Math.round(a.contextLines)));
  }
  const ignoreCase = a.ignoreCase !== false;
  const literal = a.literal === true;
  return { pattern, path, glob, limit, ignoreCase, literal, contextLines };
}

function buildRgArgs(p: ParsedArgs): string[] {
  const args: string[] = ['--json', '--max-count', String(p.limit)];
  if (p.ignoreCase) args.push('-i');
  if (p.literal) args.push('--fixed-strings');
  if (p.glob) args.push('--glob', p.glob);
  if (p.contextLines > 0) args.push('-C', String(p.contextLines));
  args.push('--', p.pattern);
  if (p.path) args.push(p.path);
  return args;
}

async function runRg(rgPath: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(rgPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`local_grep: rg timed out after ${RG_TIMEOUT_MS}ms`));
    }, RG_TIMEOUT_MS);
    const abort = () => {
      proc.kill();
      reject(new Error('local_grep: aborted'));
    };
    signal?.addEventListener('abort', abort, { once: true });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    proc.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    proc.on('error', (err) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      // rg exits 1 when there are simply no matches — that's not a failure.
      if (code !== 0 && code !== 1) {
        reject(new Error(`local_grep: rg exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
        return;
      }
      resolve(stdout);
    });
  });
}

interface RgMatchEvent {
  type: 'match';
  data: {
    path: { text?: string } | undefined;
    lines: { text?: string } | undefined;
    line_number: number;
    submatches?: Array<{ start: number; end: number }>;
  };
}

function parseRgJsonLines(stdout: string, limit: number): LocalGrepHit[] {
  const out: LocalGrepHit[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw) continue;
    let evt: { type?: string; data?: unknown };
    try {
      evt = JSON.parse(raw) as { type?: string; data?: unknown };
    } catch {
      continue;
    }
    if (evt.type !== 'match') continue;
    const m = evt as unknown as RgMatchEvent;
    const file = m.data.path?.text ?? '';
    const text = (m.data.lines?.text ?? '').replace(/\r?\n$/, '');
    const line = m.data.line_number;
    if (!file || !Number.isFinite(line)) continue;
    const first = m.data.submatches?.[0];
    out.push({
      file,
      line,
      column: first ? first.start + 1 : undefined,
      text,
    });
    if (out.length >= limit) break;
  }
  return out;
}
