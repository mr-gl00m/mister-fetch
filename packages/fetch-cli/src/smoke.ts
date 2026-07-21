import { Supervisor, anguishConfigForFetch, currentAnguish, band as bandOf, isUnfinished, type FetchRecord, type TriageResult } from '@mister-fetch/core';
import { createOllamaProvider, normalizeOllamaBaseUrl } from './ollama.js';

// npm workspace scripts run with cwd=packages/fetch-cli. Restore the
// directory the user actually launched from (npm records it in INIT_CWD)
// so relative paths in f:/g:/dg:/open: resolve against it.
if (process.env.INIT_CWD) process.chdir(process.env.INIT_CWD);

const model = process.env.MISTER_FETCH_MODEL ?? 'hermes3:latest';
const baseUrl = normalizeOllamaBaseUrl(process.env.MISTER_FETCH_OLLAMA_URL ?? 'http://localhost:11434');
const task = process.argv.slice(2).join(' ').trim() || 'find me the top five free email services';

function log(...parts: unknown[]): void {
  process.stdout.write(parts.map(String).join(' ') + '\n');
}

function printRecord(r: FetchRecord, config: Parameters<typeof currentAnguish>[1]): void {
  const effectiveConfig = anguishConfigForFetch(config, r.mode, r.taskClass);
  const A = r.status === 'awaiting_release'
    ? 1
    : currentAnguish(r.anguish, effectiveConfig, Date.now());
  const b = bandOf(A, effectiveConfig);
  log(
    `[${r.id}] status=${r.status} A=${A.toFixed(2)} band=${b} reviveCount=${r.reviveCount} tools=${r.toolCalls.length} chatter="${r.chatter}" action="${r.currentAction ?? ''}"`
  );
}

async function main(): Promise<void> {
  log(`MISTER FETCH smoke — model=${model} — task="${task}"`);
  const provider = createOllamaProvider({ baseUrl, model });

  const supervisor = new Supervisor({
    provider,
    onUpdate: (r) => printRecord(r, supervisor.config),
    onTriageRejection: (t: string, result: TriageResult) => {
      log(`TRIAGE REFUSED "${t}": ${result.kind} — ${result.reason ?? result.clarifyingQuestion ?? result.decomposition?.join(' // ') ?? ''}`);
    },
  });

  await supervisor.start();

  const rec = await supervisor.spawn(task);
  if (!rec) {
    log('triage refused — nothing spawned');
    supervisor.stop();
    process.exit(1);
  }

  log(`spawned FETCH ${rec.id}`);

  // Poll until terminal. Purgatory (awaiting_release) never resolves without
  // a user, and smoke has no user: report the parked state and release it so
  // the harness always exits.
  let released = false;
  while (true) {
    await new Promise((r) => setTimeout(r, 500));
    const current = supervisor.get(rec.id);
    if (!current) {
      log('fetch removed from living roster');
      break;
    }
    if (current.status === 'awaiting_release' && !released) {
      released = true;
      log(`entered purgatory: "${current.chatter}" — reason: ${current.terminationReason ?? '(none)'}`);
      log('smoke is non-interactive — releasing.');
      supervisor.release(current.id);
      continue;
    }
    if (!isUnfinished(current.status)) {
      log(`reached terminal status: ${current.status}`);
      log(`termination reason: ${current.terminationReason ?? '(none)'}`);
      log(`result payload: ${JSON.stringify(current.resultPayload ?? null, null, 2).slice(0, 1200)}`);
      log(`tool calls:`);
      for (const c of current.toolCalls) {
        const tag = c.ok ? 'ok' : 'FAIL';
        const detail = c.ok
          ? `result=${JSON.stringify(c.result).slice(0, 240)}`
          : `error=${c.error}`;
        log(`  [${tag}] ${c.name}(${JSON.stringify(c.args)}) ${detail}`);
      }
      break;
    }
  }

  supervisor.stop();
  process.exit(0);
}

main().catch((e) => {
  log(`FATAL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
