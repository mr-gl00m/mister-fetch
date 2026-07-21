import { spawn } from 'node:child_process';
import type { Tool, ToolContext } from './registry.js';
import { assertAllowedLocalPath, defaultLocalSearchRoot } from './local-path-policy.js';

/**
 * local_doc_grep — rich-document content search via ripgrep-all (`rga`).
 *
 * ripgrep-all wraps ripgrep with a preprocessor pipeline that makes
 * PDFs, Office docs (docx/xlsx/pptx), EPUBs, zip/tar/7z archives,
 * images-with-OCR, and even sqlite databases searchable as plain text.
 * The JSON output shape matches ripgrep's exactly, so this tool is
 * essentially a second invocation surface over the same parser.
 *
 * Install: `cargo install ripgrep_all` OR the prebuilt binaries at
 * https://github.com/phiresky/ripgrep-all/releases. Put `rga` on PATH,
 * or set MISTER_FETCH_RGA_PATH. rga needs a working `rg` on PATH too.
 *
 * Failure mode: if the binary isn't present we throw with an install
 * hint. If rga is present but a specific preprocessor (e.g. `pdftotext`)
 * is missing, rga itself will skip that file type and surface nothing;
 * we don't second-guess its decisions.
 */

export interface LocalDocGrepArgs {
  pattern: string;
  path?: string;
  glob?: string;
  limit?: number;
  ignoreCase?: boolean;
  literal?: boolean;
}

export interface LocalDocGrepHit {
  file: string;
  line: number;
  column?: number;
  text: string;
}

const RGA_TIMEOUT_MS = 45_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

export const localDocGrepTool: Tool = {
  name: 'local_doc_grep',
  description:
    'Search the CONTENT of rich documents (PDF, Office, EPUB, archives, OCR, sqlite) via ripgrep-all. ' +
    'Args: { pattern: string, path?: string (default: cwd), glob?: string, ' +
    'limit?: number (1..200, default 20), ignoreCase?: boolean, literal?: boolean }. ' +
    'Returns { file, line, text } hits. Slower than local_grep because preprocessors run per file, ' +
    'but the only tool that can see inside a PDF body. Requires rga on PATH.',

  async execute(args: unknown, ctx: ToolContext): Promise<LocalDocGrepHit[]> {
    const parsed = parseArgs(args);
    parsed.path = parsed.path
      ? await assertAllowedLocalPath(parsed.path, 'local_doc_grep')
      : await defaultLocalSearchRoot('local_doc_grep');
    const rgaPath = process.env.MISTER_FETCH_RGA_PATH ?? 'rga';
    const rgaArgs = buildRgaArgs(parsed);

    let stdout: string;
    try {
      stdout = await runRga(rgaPath, rgaArgs, ctx.signal);
    } catch (e) {
      if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          'local_doc_grep: ripgrep-all (rga) not found. Install from ' +
            'https://github.com/phiresky/ripgrep-all/releases ' +
            'and put rga on PATH, or set MISTER_FETCH_RGA_PATH. rga needs `rg` on PATH too.',
        );
      }
      throw e;
    }

    return parseRgaJsonLines(stdout, parsed.limit);
  },
};

interface ParsedArgs {
  pattern: string;
  path: string | null;
  glob: string | null;
  limit: number;
  ignoreCase: boolean;
  literal: boolean;
}

function parseArgs(args: unknown): ParsedArgs {
  if (typeof args !== 'object' || args === null) {
    throw new Error('local_doc_grep: args must be an object');
  }
  const a = args as Record<string, unknown>;
  const pattern = typeof a.pattern === 'string' ? a.pattern : '';
  if (!pattern) throw new Error('local_doc_grep: args.pattern (non-empty string) required');

  const path = typeof a.path === 'string' && a.path.trim() ? a.path.trim() : null;
  const glob = typeof a.glob === 'string' && a.glob.trim() ? a.glob.trim() : null;

  let limit = DEFAULT_LIMIT;
  if (typeof a.limit === 'number' && Number.isFinite(a.limit)) {
    limit = Math.max(1, Math.min(MAX_LIMIT, Math.round(a.limit)));
  }
  const ignoreCase = a.ignoreCase !== false;
  const literal = a.literal === true;
  return { pattern, path, glob, limit, ignoreCase, literal };
}

function buildRgaArgs(p: ParsedArgs): string[] {
  const args: string[] = ['--json', '--max-count', String(p.limit)];
  if (p.ignoreCase) args.push('-i');
  if (p.literal) args.push('--fixed-strings');
  if (p.glob) args.push('--glob', p.glob);
  args.push('--', p.pattern);
  if (p.path) args.push(p.path);
  return args;
}

async function runRga(rgaPath: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(rgaPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`local_doc_grep: rga timed out after ${RGA_TIMEOUT_MS}ms`));
    }, RGA_TIMEOUT_MS);
    const abort = () => {
      proc.kill();
      reject(new Error('local_doc_grep: aborted'));
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
      if (code !== 0 && code !== 1) {
        reject(
          new Error(
            `local_doc_grep: rga exited ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`,
          ),
        );
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

function parseRgaJsonLines(stdout: string, limit: number): LocalDocGrepHit[] {
  const out: LocalDocGrepHit[] = [];
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
