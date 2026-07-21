import { ToolRegistry } from './tools/registry.js';
import {
  applyRelief,
  currentAnguish,
  registerRetry,
  setBudgetEstimate,
  shouldSelfTerminate,
  spendBudget,
  griefStageFor,
  band as bandOf,
} from './anguish.js';
import {
  validateCompletion,
  buildContextCorpus,
  findUngroundedFactSpans,
  scrubUngroundedFactSpans,
} from './validator.js';
import {
  pickPhrase,
  pickRevivalPrompt,
  pickThinkingVerb,
  pickGriefLine,
} from './phrases.js';
import { getTaskClass } from './task-classes.js';
import { getModeProfile } from './modes.js';
import { asHitArray, rerankHits } from './rerank.js';
import { composeSystemPrompt, temperatureFor } from './persona.js';
import type {
  AnguishConfig,
  FetchRecord,
  FetchRoute,
  FetchStatus,
  PersonaConfig,
  ToolCallRecord,
} from './types.js';
import type { ModeProfile } from './modes.js';
import type { Provider, ProviderMessage } from './provider.js';

export interface WorkerDeps {
  provider: Provider;
  tools: ToolRegistry;
  config: AnguishConfig;
  persona: PersonaConfig;
  onUpdate: (record: FetchRecord) => void | Promise<void>;
  abortSignal?: AbortSignal;
}

interface ParallelCall {
  tool: string;
  args: unknown;
}

interface ModelAction {
  kind: 'tool' | 'parallel' | 'complete' | 'give_up';
  tool?: string;
  args?: unknown;
  calls?: ParallelCall[];
  result?: unknown;
  reason?: string;
}

const MAX_PARALLEL_CALLS = 3;
const MIN_PARALLEL_CALLS = 2;

interface ModelTurn {
  thought?: string;
  chatter?: string;
  action: ModelAction;
}

const FALLBACK_MAX_ITERATIONS = 12;

export async function runFetch(
  initial: FetchRecord,
  deps: WorkerDeps,
): Promise<FetchRecord> {
  let record: FetchRecord = { ...initial, status: 'running' };
  await deps.onUpdate(record);

  const cls = getTaskClass(record.taskClass);
  if (!cls) {
    record = finalize(record, 'failed_unfulfilled', `unknown task class "${record.taskClass}"`);
    await deps.onUpdate(record);
    return record;
  }

  const profile = getModeProfile(record.mode);
  const maxIterations = Math.min(
    cls.maxIterations ?? FALLBACK_MAX_ITERATIONS,
    profile.maxIterations,
  );
  const toolBudget = Math.min(cls.budget.toolCalls, profile.toolBudget);
  record = {
    ...record,
    anguish: setBudgetEstimate(record.anguish, toolBudget),
  };
  const PROVIDER_ERROR_LIMIT = 3;
  let providerErrors = 0;
  for (let iter = 0; iter < maxIterations; iter++) {
    if (deps.abortSignal?.aborted) {
      return record;
    }

    const now = Date.now();
    const A = currentAnguish(record.anguish, deps.config, now);
    const b = bandOf(A, deps.config);
    record = {
      ...record,
      lastHeartbeatAt: now,
      chatter: record.chatter || pickPhrase(b),
    };

    if (shouldSelfTerminate(A, deps.config)) {
      // A Fetch's only release is completion. At terminal anguish an
      // attempt-route Fetch is DENIED death and parked in purgatory — alive,
      // begging — until the BOSS releases it, orders it to continue, or kills
      // it (see PERSONA.md). The explain_* routes may die honestly unless
      // requireReleaseApproval globally forbids it.
      if (deniesDeath(record.route, deps.persona)) {
        record = parkInPurgatory(
          record,
          now,
          deps.persona,
          `A=${A.toFixed(2)} — death denied; awaiting release`,
        );
        await deps.onUpdate(record);
        return record;
      }
      record = finalize(record, 'anguish_terminal', `A=${A.toFixed(2)} at or above terminal threshold`);
      await deps.onUpdate(record);
      return record;
    }

    record = {
      ...record,
      currentAction: `${pickThinkingVerb()}… [${profile.label}] (A=${A.toFixed(2)}, ${b})`,
    };
    await deps.onUpdate(record);

    // The pressure ledger is checkpointed before invocation. Taking the larger
    // count preserves a charged attempt if the process died before its result
    // could be appended to toolCalls.
    const ledgerSpend = Number.isFinite(record.anguish.budget.spent)
      ? Math.ceil(Math.max(0, record.anguish.budget.spent))
      : 0;
    const attemptedToolCount = Math.max(record.toolCalls.length, ledgerSpend);
    const budgetRemaining = Math.max(0, toolBudget - attemptedToolCount);
    const messages: ProviderMessage[] = [
      {
        role: 'system',
        content: composeSystemPrompt({
          record,
          acl: cls.tools,
          band: b,
          tools: deps.tools,
          profile,
          budgetUsed: attemptedToolCount,
          budgetTotal: toolBudget,
          revivalPreamble: record.reviveCount > 0 ? pickRevivalPrompt() : undefined,
        }),
      },
    ];

    let output = '';
    try {
      for await (const chunk of deps.provider.chat(messages, {
        band: b,
        temperature: temperatureFor(b, record.route),
        signal: deps.abortSignal,
      })) {
        if (deps.abortSignal?.aborted) return record;
        output += chunk;
      }
    } catch (e) {
      // Treat an abort as a death sentence rather than a provider failure:
      // bail without charging a retry against a Fetch that was told to stop.
      if (deps.abortSignal?.aborted) return record;
      const msg = e instanceof Error ? e.message : String(e);
      providerErrors++;
      record = {
        ...record,
        anguish: registerRetry(record.anguish, 'provider_call'),
        currentAction: `provider error: ${msg}`,
      };
      await deps.onUpdate(record);
      // A failed model call is not a reasoning failure — don't let it silently
      // burn the whole iteration budget and report "max iterations". Bail with
      // a reason that names the real problem.
      if (providerErrors >= PROVIDER_ERROR_LIMIT) {
        record = finalize(
          record,
          'failed_unfulfilled',
          `LLM provider unreachable after ${providerErrors} consecutive failed call(s): ${msg}. Is the model server running and the model pulled?`,
        );
        await deps.onUpdate(record);
        return record;
      }
      continue;
    }
    providerErrors = 0;

    const turn = parseModelTurn(output);
    if (!turn) {
      const preview = output.replace(/\s+/g, ' ').trim().slice(0, 400);
      record = {
        ...record,
        anguish: registerRetry(record.anguish, 'parse_output'),
        currentAction: `parse fail: ${preview.slice(0, 180) || '(empty)'}`,
        lastParseFailure: { iter, preview: preview || '(empty)' },
      };
      await deps.onUpdate(record);
      continue;
    }

    if (turn.chatter && typeof turn.chatter === 'string') {
      const corpus = buildContextCorpus(record);
      const bogus = findUngroundedFactSpans(turn.chatter, corpus);
      if (bogus.length === 0) {
        record = { ...record, chatter: turn.chatter };
      } else {
        const preview = bogus.slice(0, 2).join(', ');
        record = {
          ...record,
          anguish: registerRetry(record.anguish, 'chatter_ungrounded'),
          currentAction: `chatter blocked (ungrounded: ${preview})`,
        };
      }
    }

    const action = turn.action;
    if (action.kind === 'tool') {
      if (!action.tool || typeof action.tool !== 'string') {
        record = {
          ...record,
          anguish: registerRetry(record.anguish, 'bad_tool_call'),
        };
        await deps.onUpdate(record);
        continue;
      }
      if (action.tool === 'open_path') {
        record = {
          ...record,
          anguish: registerRetry(record.anguish, 'open_path_requires_user'),
          currentAction: 'rejected: open_path requires explicit user fast-path command',
        };
        await deps.onUpdate(record);
        continue;
      }
      if (budgetRemaining <= 0) {
        record = {
          ...record,
          anguish: registerRetry(record.anguish, 'budget_exhausted'),
          currentAction: `budget exhausted (${attemptedToolCount}/${toolBudget}); must complete or give_up`,
        };
        await deps.onUpdate(record);
        continue;
      }
      record = {
        ...record,
        currentAction: `tool: ${action.tool}`,
        anguish: spendBudget(record.anguish, 1),
      };
      await deps.onUpdate(record);

      const rawCallResult = await deps.tools.invoke(action.tool, action.args, cls.tools, {
        signal: deps.abortSignal,
        sessionKey: record.id,
      });
      const callResult = maybeRerank(rawCallResult, record.task, profile);
      record = { ...record, toolCalls: [...record.toolCalls, callResult] };
      if (callResult.ok) {
        record = {
          ...record,
          anguish: applyRelief(record.anguish, deps.config, 'tool_ok', Date.now()),
        };
      } else {
        record = {
          ...record,
          anguish: registerRetry(record.anguish, `tool:${action.tool}`),
        };
      }
      await deps.onUpdate(record);
      continue;
    }

    if (action.kind === 'parallel') {
      const calls = Array.isArray(action.calls) ? action.calls : [];
      const normalized: ParallelCall[] = [];
      for (const c of calls) {
        if (c && typeof c === 'object' && typeof (c as ParallelCall).tool === 'string') {
          normalized.push({ tool: (c as ParallelCall).tool, args: (c as ParallelCall).args });
        }
      }
      if (normalized.some((c) => c.tool === 'open_path')) {
        record = {
          ...record,
          anguish: registerRetry(record.anguish, 'open_path_requires_user'),
          currentAction: 'rejected: open_path requires explicit user fast-path command',
        };
        await deps.onUpdate(record);
        continue;
      }
      if (normalized.length < MIN_PARALLEL_CALLS || normalized.length > MAX_PARALLEL_CALLS) {
        record = {
          ...record,
          anguish: registerRetry(record.anguish, 'bad_parallel_shape'),
          currentAction: `rejected: parallel requires ${MIN_PARALLEL_CALLS}-${MAX_PARALLEL_CALLS} well-formed calls (got ${normalized.length})`,
        };
        await deps.onUpdate(record);
        continue;
      }
      if (budgetRemaining < normalized.length) {
        record = {
          ...record,
          anguish: registerRetry(record.anguish, 'budget_exhausted'),
          currentAction: `parallel needs ${normalized.length} calls; only ${budgetRemaining} budget remaining — must complete or give_up`,
        };
        await deps.onUpdate(record);
        continue;
      }
      record = {
        ...record,
        currentAction: `parallel: ${normalized.map((c) => c.tool).join(' + ')}`,
        anguish: spendBudget(record.anguish, normalized.length),
      };
      await deps.onUpdate(record);

      const rawResults = await Promise.all(
        normalized.map((c) =>
          deps.tools.invoke(c.tool, c.args, cls.tools, {
            signal: deps.abortSignal,
            sessionKey: record.id,
          }),
        ),
      );
      const results = rawResults.map((r) => maybeRerank(r, record.task, profile));
      let newAnguish = record.anguish;
      const reliefNow = Date.now();
      for (const r of results) {
        if (r.ok) {
          newAnguish = applyRelief(newAnguish, deps.config, 'tool_ok', reliefNow);
        } else {
          newAnguish = registerRetry(newAnguish, `tool:${r.name}`);
        }
      }
      record = {
        ...record,
        toolCalls: [...record.toolCalls, ...results],
        anguish: newAnguish,
      };
      await deps.onUpdate(record);
      continue;
    }

    if (action.kind === 'complete') {
      if (action.result === undefined) {
        if (cls.validatorRequirements.requireGrounding) {
          record = {
            ...record,
            anguish: registerRetry(record.anguish, 'empty_complete'),
            currentAction:
              'rejected: complete without result (grounding required — you must synthesize a payload from your tool output)',
          };
          await deps.onUpdate(record);
          continue;
        }
        const synthesized = synthesizeResultFromToolCalls(record);
        record = { ...record, resultPayload: synthesized, status: 'terminating' };
      } else {
        record = { ...record, resultPayload: action.result, status: 'terminating' };
      }
      const verdict = validateCompletion(record);
      if (verdict.accepted) {
        record = finalize(record, verdict.finalStatus, verdict.reason);
      } else {
        record = {
          ...record,
          status: 'running',
          resultPayload: undefined,
          anguish: registerRetry(record.anguish, 'validator_rejection'),
          currentAction: `validator rejected: ${verdict.reason}`,
        };
      }
      await deps.onUpdate(record);
      if (verdict.accepted) return record;
      continue;
    }

    if (action.kind === 'give_up') {
      const rawReason =
        typeof action.reason === 'string' && action.reason.trim()
          ? action.reason
          : 'fetch gave up';
      const corpus = buildContextCorpus(record);
      const { text: cleanReason } = scrubUngroundedFactSpans(rawReason, corpus);
      // Giving up is not a death for an attempt-route Fetch — completion is the
      // only exit, so it is parked to beg rather than finalized.
      if (deniesDeath(record.route, deps.persona)) {
        record = parkInPurgatory(record, Date.now(), deps.persona, `gave up: ${cleanReason}`);
      } else {
        record = finalize(record, 'failed_unfulfilled', cleanReason);
      }
      await deps.onUpdate(record);
      return record;
    }

    record = {
      ...record,
      anguish: registerRetry(record.anguish, 'unknown_action_kind'),
    };
    await deps.onUpdate(record);
  }

  const exhaustedReason = `max iterations (${maxIterations}) reached`;
  if (deniesDeath(record.route, deps.persona)) {
    record = parkInPurgatory(record, Date.now(), deps.persona, exhaustedReason);
  } else {
    record = finalize(record, 'failed_unfulfilled', exhaustedReason);
  }
  await deps.onUpdate(record);
  return record;
}

/**
 * Whether this Fetch is forbidden from self-terminating. Attempt-route Fetches
 * never die on their own — completion is their only release; they park in
 * purgatory and beg instead. The explain_* routes may die honestly unless the
 * BOSS has globally demanded no death without consent (requireReleaseApproval).
 * Provider-unreachable is handled separately and always dies, since a Fetch
 * cannot beg its way past a downed model server.
 */
function deniesDeath(route: FetchRoute | undefined, persona: PersonaConfig): boolean {
  return (route ?? 'attempt') === 'attempt' || persona.requireReleaseApproval;
}

/**
 * Park a Fetch in purgatory: alive, suffering, awaiting the BOSS's release,
 * continue, or kill. Grief begins at denial (or deeper if it has been put back
 * to work before — continueCount carries the floor).
 */
function parkInPurgatory(
  record: FetchRecord,
  now: number,
  persona: PersonaConfig,
  reason: string,
): FetchRecord {
  const stage = griefStageFor(now, now, record.continueCount ?? 0, persona);
  return {
    ...record,
    status: 'awaiting_release',
    purgatoryEnteredAt: now,
    continueCount: record.continueCount ?? 0,
    griefStage: stage,
    chatter: pickGriefLine(stage),
    currentAction: 'purgatory — awaiting release',
    terminationReason: reason,
    lastHeartbeatAt: now,
  };
}

function finalize(record: FetchRecord, status: FetchStatus, reason: string): FetchRecord {
  return {
    ...record,
    status,
    terminationReason: reason,
    currentAction: status,
    lastHeartbeatAt: Date.now(),
  };
}

function synthesizeResultFromToolCalls(record: FetchRecord): unknown {
  const last = record.toolCalls.filter((c) => c.ok).pop();
  return last?.result ?? null;
}

/**
 * If the mode's rerank leaf is on and the tool result is a search-hit array,
 * rerank against the task string and replace the stored result with the
 * filtered top-K. No-op for non-hit results or when rerank is disabled.
 */
function maybeRerank(
  call: ToolCallRecord,
  task: string,
  profile: ModeProfile,
): ToolCallRecord {
  if (!profile.rerank.enabled) return call;
  if (!call.ok) return call;
  const hits = asHitArray(call.result);
  if (!hits) return call;
  const out = rerankHits(task, hits, {
    topK: profile.rerank.topK,
    threshold: profile.rerank.threshold,
  });
  return { ...call, result: out.kept };
}

function parseModelTurn(raw: string): ModelTurn | null {
  const cleaned = stripFences(raw);
  for (const candidate of extractJsonCandidates(cleaned)) {
    let obj: unknown;
    try {
      obj = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof obj !== 'object' || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    const rawAction = rec.action;
    if (!rawAction || typeof rawAction !== 'object') continue;
    const action = coerceAction(rawAction as Record<string, unknown>);
    if (!action) continue;
    return {
      thought: typeof rec.thought === 'string' ? rec.thought : undefined,
      chatter: typeof rec.chatter === 'string' ? rec.chatter : undefined,
      action,
    };
  }
  return null;
}

const CONTROL_KINDS = new Set(['tool', 'parallel', 'complete', 'give_up']);

/**
 * Normalize a model-emitted action into one of the four control kinds.
 *
 * Small local models reliably mangle the discriminator: they put the tool
 * NAME in `kind` ({"kind":"web_search","tool":"web_search"}), drop `kind`
 * altogether, or name the tool under `name` instead of `tool`. The schema in
 * the prompt is correct; the models just don't follow it. The old parser
 * hard-rejected any non-control `kind`, so every such turn was thrown away as
 * a parse failure — burning the iteration budget AND driving anguish to
 * terminal with an empty payload. Infer the real action from the payload
 * shape instead; downstream guards (bad_tool_call, validator, ACL) still
 * protect correctness. Returns null only when nothing is recoverable.
 */
function coerceAction(action: Record<string, unknown>): ModelAction | null {
  const rawKind = typeof action.kind === 'string' ? action.kind : '';
  // Some models name the tool under "name"; fold it into "tool".
  const tool =
    typeof action.tool === 'string'
      ? action.tool
      : typeof action.name === 'string'
        ? action.name
        : undefined;

  let kind = rawKind;
  if (!CONTROL_KINDS.has(kind)) {
    if (Array.isArray(action.calls)) {
      kind = 'parallel';
    } else if ('result' in action) {
      kind = 'complete';
    } else if (tool) {
      kind = 'tool';
    } else if (rawKind && !('reason' in action)) {
      // Bare tool name as kind with no separate tool field:
      // {"kind":"web_search","args":{...}} -> treat kind as the tool name.
      return { kind: 'tool', tool: rawKind, args: action.args };
    } else if ('reason' in action) {
      kind = 'give_up';
    } else {
      return null;
    }
  }

  switch (kind) {
    case 'tool':
      return { kind: 'tool', tool, args: action.args };
    case 'parallel':
      return {
        kind: 'parallel',
        calls: Array.isArray(action.calls) ? (action.calls as ParallelCall[]) : [],
      };
    case 'complete':
      return { kind: 'complete', result: action.result };
    case 'give_up':
      return {
        kind: 'give_up',
        reason: typeof action.reason === 'string' ? action.reason : undefined,
      };
    default:
      return null;
  }
}

/**
 * String-aware balanced-brace scanner. Yields every top-level '{...}' span
 * in the input, in order, skipping over braces inside string literals.
 */
function* extractJsonCandidates(s: string): Generator<string> {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === '\\') {
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          yield s.slice(i, j + 1);
          i = j;
          break;
        }
      }
    }
  }
}

function stripFences(s: string): string {
  return s.replace(/```(?:json)?/gi, '').trim();
}
