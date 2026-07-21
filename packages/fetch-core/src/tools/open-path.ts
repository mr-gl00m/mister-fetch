import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContext } from './registry.js';
import { assertAllowedLocalPath } from './local-path-policy.js';

/**
 * open_path — open a file or folder in the OS file manager / default app.
 *
 * The click-to-open side of the flagship use case: `local_find` returns
 * a path, the user picks one, this tool opens the containing folder (or
 * the file itself) in their native shell. Platform-aware:
 *
 *   - Windows: `explorer.exe <path>` — opens the containing folder for
 *     a file (with the file selected via `/select,`) or the folder itself.
 *   - macOS:   `open <path>`
 *   - Linux:   `xdg-open <path>`
 *
 * This tool is the ONE ACTION tool in the registry that intentionally
 * has a side effect on the user's desktop. Every other tool is read-only.
 * Guard rails:
 *   - Path is stat'd first; opening a non-existent path is a no-op with
 *     a clean error.
 *   - Path is passed as an argv entry, NOT shell-interpolated.
 *   - On "open file", we resolve to the parent directory and pass
 *     `/select,<file>` so Explorer highlights it — that's what the user
 *     expects from "click to open."
 */

export interface OpenPathArgs {
  path: string;
  /** If true, open the PARENT directory with the path selected. Default: auto. */
  reveal?: boolean;
}

export interface OpenPathResult {
  opened: string;
  kind: 'file' | 'directory';
  revealed: boolean;
}

export const openPathTool: Tool = {
  name: 'open_path',
  description:
    'Open a file or folder in the native file manager. ' +
    'Args: { path: string, reveal?: boolean (if true, open parent dir with file selected) }. ' +
    'Platform-aware: explorer.exe on Windows, open on macOS, xdg-open on Linux. ' +
    'The one tool with an intentional desktop side effect — every other tool is read-only.',

  async execute(args: unknown, _ctx: ToolContext): Promise<OpenPathResult> {
    const parsed = parseArgs(args);
    const resolved = await assertAllowedLocalPath(parsed.path, 'open_path');

    let kind: 'file' | 'directory';
    try {
      const s = await stat(resolved);
      kind = s.isDirectory() ? 'directory' : 'file';
    } catch (e) {
      throw new Error(
        `open_path: cannot stat "${resolved}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    const shouldReveal = parsed.reveal ?? kind === 'file';
    launch(resolved, kind, shouldReveal);
    return { opened: resolved, kind, revealed: shouldReveal };
  },
};

function parseArgs(args: unknown): { path: string; reveal: boolean | undefined } {
  if (typeof args !== 'object' || args === null) {
    throw new Error('open_path: args must be an object');
  }
  const a = args as Record<string, unknown>;
  const p = typeof a.path === 'string' ? a.path.trim() : '';
  if (!p) throw new Error('open_path: args.path (non-empty string) required');
  const reveal = typeof a.reveal === 'boolean' ? a.reveal : undefined;
  return { path: p, reveal };
}

function launch(target: string, kind: 'file' | 'directory', reveal: boolean): void {
  if (process.platform === 'win32') {
    // explorer.exe /select,<path> highlights the file inside its parent.
    // For a plain folder or an unrevealed file, just pass the path.
    const args = reveal && kind === 'file' ? [`/select,${target}`] : [target];
    spawn('explorer.exe', args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    const args = reveal && kind === 'file' ? ['-R', target] : [target];
    spawn('open', args, { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  // Linux / BSD — xdg-open doesn't support a "reveal" mode, so on reveal
  // we fall back to opening the parent directory.
  const effective = reveal && kind === 'file' ? path.dirname(target) : target;
  spawn('xdg-open', [effective], { detached: true, stdio: 'ignore' }).unref();
}
