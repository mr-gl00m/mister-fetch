import {
  anguishConfigForFetch,
  currentAnguish,
  type AnguishConfig,
  type FetchRecord,
  type ToolCallRecord,
} from '@mister-fetch/core';

/**
 * Headless payload and five-section report builder for the Squad Code
 * external-cli contract (squad-requirements-for-shipping.md R4 to R6).
 * Pure functions: no supervisor, no I/O, fully testable offline.
 */

export interface HeadlessPayload {
  status: 'completed' | 'failed_unfulfilled' | 'scope_refused' | 'anguish_terminal';
  result: string;
  tool_calls: number;
  anguish_final: number;
  duration: number;
  fetch_id: string;
}

const SUMMARY_MAX_CHARS = 4000;
const EVIDENCE_MAX_BULLETS = 20;
const EVIDENCE_DIGEST_CHARS = 240;

/** Map any record status onto the four payload statuses Squad understands. */
function payloadStatus(record: FetchRecord): HeadlessPayload['status'] {
  switch (record.status) {
    case 'completed':
      return 'completed';
    case 'scope_refused':
      return 'scope_refused';
    case 'anguish_terminal':
      return 'anguish_terminal';
    // Purgatory, user_released, user_killed, and everything mid-flight all
    // reduce to the same headless truth: no answer was produced.
    default:
      return 'failed_unfulfilled';
  }
}

export function payloadFromRecord(
  record: FetchRecord,
  config: AnguishConfig,
  now: number,
): HeadlessPayload {
  const status = payloadStatus(record);
  const effective = anguishConfigForFetch(config, record.mode, record.taskClass);
  const anguishFinal =
    record.status === 'awaiting_release'
      ? 1
      : currentAnguish(record.anguish, effective, now);
  return {
    status,
    result: buildReport(record, status),
    tool_calls: record.toolCalls.length,
    anguish_final: round2(anguishFinal),
    duration: round1(Math.max(0, now - record.createdAt) / 1000),
    fetch_id: record.id,
  };
}

/**
 * A task that never spawned (triage refusal: underspecified, compound too
 * deep, unknown class). The Fetch declines to attempt it, which from the
 * caller's side is a scope refusal: R6 requires SCOPE_REFUSED leading a
 * BLOCKERS bullet and exit 0.
 */
export function payloadFromRefusal(task: string, reason: string): HeadlessPayload {
  const summary = `No Fetch was spawned. Triage refused the task: ${reason}`;
  const result = sections({
    summary: `${summary}\n\nTask as received: ${oneLine(task, 400)}`,
    evidence: ['None.'],
    blockers: [`SCOPE_REFUSED: ${oneLine(reason, 400)}`],
  });
  return {
    status: 'scope_refused',
    result,
    tool_calls: 0,
    anguish_final: 0,
    duration: 0,
    fetch_id: 'NONE',
  };
}

export function buildReport(record: FetchRecord, status: HeadlessPayload['status']): string {
  const evidence = evidenceBullets(record.toolCalls);
  if (status === 'completed') {
    return sections({
      summary:
        `FETCH ${record.id} completed "${oneLine(record.task, 200)}" ` +
        `with ${record.toolCalls.length} tool call(s).\n\n${formatPayload(record.resultPayload)}`,
      evidence,
      blockers: ['None.'],
    });
  }
  const reason = oneLine(record.terminationReason ?? 'no reason recorded', 500);
  const label =
    status === 'anguish_terminal'
      ? `FETCH ${record.id} self-terminated at terminal anguish`
      : `FETCH ${record.id} could not complete the task`;
  return sections({
    summary:
      `${label}: ${reason}. Task: "${oneLine(record.task, 200)}". ` +
      `${record.toolCalls.length} tool call(s) were attempted; ` +
      `any partial evidence is listed below. No answer is asserted.`,
    evidence,
    blockers: [reason],
  });
}

function sections(parts: {
  summary: string;
  evidence: string[];
  blockers: string[];
}): string {
  const evidence =
    parts.evidence.length === 0 || parts.evidence[0] === 'None.'
      ? 'None.'
      : parts.evidence.map((b) => `- ${b}`).join('\n');
  const blockers =
    parts.blockers.length === 0 || parts.blockers[0] === 'None.'
      ? 'None.'
      : parts.blockers.map((b) => `- ${b}`).join('\n');
  return [
    '### SUMMARY',
    truncate(parts.summary, SUMMARY_MAX_CHARS),
    '',
    '### EVIDENCE',
    evidence,
    '',
    '### CHANGES',
    'None.',
    '',
    '### RISKS',
    'None.',
    '',
    '### BLOCKERS',
    blockers,
  ].join('\n');
}

function evidenceBullets(calls: readonly ToolCallRecord[]): string[] {
  const ok = calls.filter((c) => c.ok);
  if (ok.length === 0) return ['None.'];
  const bullets = ok
    .slice(0, EVIDENCE_MAX_BULLETS)
    .map(
      (c) =>
        `${c.name}(${oneLine(safeJson(c.args), 120)}): ${oneLine(safeJson(c.result), EVIDENCE_DIGEST_CHARS)}`,
    );
  if (ok.length > EVIDENCE_MAX_BULLETS) {
    bullets.push(`plus ${ok.length - EVIDENCE_MAX_BULLETS} more successful tool call(s) omitted`);
  }
  return bullets;
}

interface SearchHitLike {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
}

function isHitArray(x: unknown): x is SearchHitLike[] {
  return (
    Array.isArray(x) &&
    x.length > 0 &&
    x.every(
      (h) => h !== null && typeof h === 'object' && 'title' in h && 'url' in h,
    )
  );
}

export function formatPayload(payload: unknown): string {
  if (payload == null) return '(no payload)';
  if (typeof payload === 'string') return payload;
  if (isHitArray(payload)) {
    return payload
      .map(
        (h, i) =>
          `${i + 1}. ${oneLine(String(h.title ?? ''), 120)}\n   ${oneLine(String(h.url ?? ''), 200)}` +
          (h.snippet ? `\n   ${oneLine(String(h.snippet), 240)}` : ''),
      )
      .join('\n');
  }
  return safeJson(payload);
}

function safeJson(x: unknown): string {
  if (x === undefined) return '(none)';
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function oneLine(s: string, max: number): string {
  return truncate(s.replace(/\s+/g, ' ').trim(), max);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
