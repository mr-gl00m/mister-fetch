#!/usr/bin/env node
// Headless one-shot entry: the Squad Code external-cli contract (R1 to R8 in
// squad-requirements-for-shipping.md). Summons exactly one Fetch for one task,
// prints exactly one JSON document on stdout, narrates everything else on
// stderr, and exits 0 whenever a usable report was produced. State lives in a
// per-run temp directory that is wiped on exit: no trace survives the run.
//
// Task intake (R2): the task is argv joined; when argv is empty the task is
// read from stdin until close. Argv wins so a stdin pipe left open by the
// caller can never hang an argv invocation.

// npm workspace scripts run with cwd=packages/fetch-cli. Restore the launch
// directory (npm records it in INIT_CWD) so relative paths resolve against
// it. Under Squad, INIT_CWD is absent and the cwd Squad set is kept (R8).
if (process.env.INIT_CWD) process.chdir(process.env.INIT_CWD);

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  Checkpoint,
  Supervisor,
  anguishConfigForFetch,
  band as bandOf,
  currentAnguish,
  isUnfinished,
  type FetchRecord,
  type TriageResult,
} from '@mister-fetch/core';
import { createOllamaProvider, normalizeOllamaBaseUrl } from './ollama.js';
import { createAnthropicProvider } from './anthropic.js';
import { payloadFromRecord, payloadFromRefusal, type HeadlessPayload } from './report.js';

const POLL_MS = 200;
const DEFAULT_DEADLINE_MS = 480_000;

function errlog(...parts: unknown[]): void {
  process.stderr.write(parts.map(String).join(' ') + '\n');
}

function deadlineMs(): number {
  const raw = Number(process.env.MISTER_FETCH_DEADLINE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DEADLINE_MS;
}

async function readStdinToEnd(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function narrate(r: FetchRecord, config: Parameters<typeof currentAnguish>[1]): void {
  const effective = anguishConfigForFetch(config, r.mode, r.taskClass);
  const A =
    r.status === 'awaiting_release' ? 1 : currentAnguish(r.anguish, effective, Date.now());
  errlog(
    `[${r.id}] status=${r.status} A=${A.toFixed(2)} band=${bandOf(A, effective)} ` +
      `tools=${r.toolCalls.length} chatter="${r.chatter}" action="${r.currentAction ?? ''}"`,
  );
}

async function emitAndExit(payload: HeadlessPayload, cleanup: () => void): Promise<never> {
  await new Promise<void>((resolve) => {
    process.stdout.write(JSON.stringify(payload) + '\n', () => resolve());
  });
  cleanup();
  process.exit(0);
}

async function main(): Promise<void> {
  const argvTask = process.argv.slice(2).join(' ').trim();
  const task = argvTask || (await readStdinToEnd()).trim();
  if (!task) {
    errlog('no task: pass the task as argv or pipe it on stdin');
    process.exit(2);
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const envModel = process.env.MISTER_FETCH_MODEL;
  const provider = anthropicKey
    ? createAnthropicProvider({ apiKey: anthropicKey, model: envModel ?? 'claude-opus-4-6' })
    : createOllamaProvider({
        baseUrl: normalizeOllamaBaseUrl(process.env.MISTER_FETCH_OLLAMA_URL),
        model: envModel ?? 'hermes3:latest',
      });

  // Memory-ephemeral, per-run state. MISTER_FETCH_STATE_DIR is deliberately
  // ignored here so a headless run can never revive, or be revived by, an
  // interactive session's Fetches.
  const stateDir = mkdtempSync(path.join(tmpdir(), 'mister-fetch-headless-'));
  const cleanup = (): void => {
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // temp dir cleanup is best effort; the OS temp sweep is the fallback
    }
  };

  // Object wrapper rather than a bare let: property narrowing resets across
  // the spawn() call, so the callback's assignment stays visible to the type
  // checker.
  const triage: { refusal: TriageResult | null } = { refusal: null };
  const seen = new Map<string, FetchRecord>();
  // Purgatory records as they looked while begging. onUpdate overwrites `seen`
  // with the user_released record moments later, and the report needs the
  // parked snapshot's real termination reason, not "user released".
  const parkedSnapshots = new Map<string, FetchRecord>();
  const supervisor = new Supervisor({
    provider,
    checkpoint: new Checkpoint(stateDir),
    onUpdate: (r) => {
      seen.set(r.id, r);
      narrate(r, supervisor.config);
    },
    onTriageRejection: (t, result) => {
      triage.refusal = result;
      errlog(`TRIAGE REFUSED "${t}": ${result.kind}`);
    },
  });

  try {
    errlog(`MISTER FETCH headless: provider=${provider.name}`);
    await supervisor.start();

    const root = await supervisor.spawn(task);
    if (!root) {
      const r = triage.refusal;
      const reason = r
        ? (r.reason ??
          r.clarifyingQuestion ??
          (r.decomposition ? `decompose first: ${r.decomposition.join(' // ')}` : r.kind))
        : 'triage refused the task';
      supervisor.stop();
      return emitAndExit(payloadFromRefusal(task, reason), cleanup);
    }

    const deadlineAt = Date.now() + deadlineMs();
    while (true) {
      await new Promise((r) => setTimeout(r, POLL_MS));

      // Headless has no BOSS to beg: any Fetch that parks in purgatory gets
      // its release immediately, with the begging preserved on stderr. The
      // parked snapshot (reason, evidence, terminal anguish) feeds the report.
      for (const rec of supervisor.roster()) {
        if (rec.status === 'awaiting_release') {
          errlog(`[${rec.id}] purgatory: "${rec.chatter}" (releasing: headless has no user)`);
          parkedSnapshots.set(rec.id, rec);
          supervisor.release(rec.id);
        }
      }

      const current = supervisor.get(root.id) ?? seen.get(root.id);
      if (!current) continue;

      const parked = current.status === 'awaiting_release' || current.status === 'user_released';
      if (parked || !isUnfinished(current.status)) {
        // Prefer the purgatory snapshot over the user_released overwrite: it
        // carries the real termination reason instead of "user released".
        const snapshot =
          current.status === 'user_released'
            ? parkedSnapshots.get(root.id) ?? current
            : current;
        errlog(`final status: ${snapshot.status}${snapshot.terminationReason ? ` (${snapshot.terminationReason})` : ''}`);
        supervisor.stop();
        await emitAndExit(payloadFromRecord(snapshot, supervisor.config, Date.now()), cleanup);
      }

      if (Date.now() >= deadlineAt) {
        errlog(`deadline ${deadlineMs()}ms reached; releasing ${root.id}`);
        const snapshot = supervisor.get(root.id) ?? seen.get(root.id) ?? root;
        supervisor.release(root.id);
        supervisor.stop();
        const payload = payloadFromRecord(
          {
            ...snapshot,
            status: 'failed_unfulfilled',
            terminationReason: `headless deadline (${deadlineMs()}ms) reached before completion`,
          },
          supervisor.config,
          Date.now(),
        );
        await emitAndExit(payload, cleanup);
      }
    }
  } catch (e) {
    supervisor.stop();
    cleanup();
    throw e;
  }
}

main().catch((e) => {
  errlog(`FATAL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
