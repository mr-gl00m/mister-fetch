import { getTaskClass } from './task-classes.js';
import type { FetchRecord, ValidatorVerdict } from './types.js';

export function validateCompletion(record: FetchRecord): ValidatorVerdict {
  const cls = getTaskClass(record.taskClass);
  if (!cls) {
    return {
      accepted: false,
      finalStatus: 'failed_unfulfilled',
      reason: `unknown task class "${record.taskClass}"`,
    };
  }

  const successful = record.toolCalls.filter((c) => c.ok);
  const required = cls.validatorRequirements.minSuccessfulTools;
  if (successful.length < required) {
    return {
      accepted: false,
      finalStatus: 'failed_unfulfilled',
      reason: `requires ${required} successful tool call(s); got ${successful.length}`,
    };
  }

  if (record.resultPayload === undefined || record.resultPayload === null) {
    return {
      accepted: false,
      finalStatus: 'failed_unfulfilled',
      reason: 'no result payload produced',
    };
  }

  for (const call of record.toolCalls) {
    if (!cls.tools.includes(call.name)) {
      return {
        accepted: false,
        finalStatus: 'failed_unfulfilled',
        reason: `fetch used tool "${call.name}" outside class ACL [${cls.tools.join(', ')}]`,
      };
    }
  }

  if (cls.validatorRequirements.requireGrounding) {
    const corpus = buildGroundingCorpus(record);
    const ungrounded = findUngroundedPayloadLeaves(record.resultPayload, corpus);
    if (ungrounded.length > 0) {
      const preview = ungrounded.slice(0, 3).map((s) => `"${s}"`).join(', ');
      return {
        accepted: false,
        finalStatus: 'failed_unfulfilled',
        reason: `payload has ${ungrounded.length} ungrounded term(s) not in successful tool output: ${preview}`,
      };
    }
  }

  return {
    accepted: true,
    finalStatus: 'completed',
    reason: 'validator approved',
  };
}

/**
 * Evidence corpus for final-answer validation. Only values returned by
 * successful tools count as evidence. The user's question is context and
 * cannot establish the truth of an answer assembled from its vocabulary.
 */
export function buildGroundingCorpus(record: FetchRecord): string {
  const parts: string[] = [];
  for (const call of record.toolCalls) {
    if (!call.ok) continue;
    appendCorpusValues(call.result, parts, new WeakSet<object>());
  }
  return normalizeCorpus(parts.join(' '));
}

/**
 * Context corpus for transient chatter and failure reasons. It includes the
 * task so a Fetch may repeat a number supplied by the user while describing
 * its work. Final payloads use buildGroundingCorpus instead.
 */
export function buildContextCorpus(record: FetchRecord): string {
  return normalizeCorpus(`${record.task} ${buildGroundingCorpus(record)}`);
}

function appendCorpusValues(
  value: unknown,
  parts: string[],
  seen: WeakSet<object>,
): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    parts.push(String(value));
    return;
  }
  if (typeof value === 'boolean') {
    parts.push(value ? 'true' : 'false');
    return;
  }
  if (typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) appendCorpusValues(item, parts, seen);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    appendCorpusValues(item, parts, seen);
  }
}

function normalizeCorpus(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u201c\u201d\u2018\u2019\u2032\u2033]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

interface CorpusIndex {
  words: Set<string>;
  numbers: Set<string>;
  numericValues: Set<string>;
}

function buildCorpusIndex(corpus: string): CorpusIndex {
  const claims = extractNumericClaims(corpus);
  const numbers = new Set(claims.map((claim) => claim.normalized));
  const numericValues = new Set(claims.map((claim) => claim.value));
  const words = new Set(tokenizeWords(maskNumericClaims(corpus)));
  return { words, numbers, numericValues };
}

function findUngroundedPayloadLeaves(payload: unknown, corpus: string): string[] {
  const ungrounded: string[] = [];
  const index = buildCorpusIndex(corpus);
  walk(payload, (leaf) => {
    if (typeof leaf === 'number' && Number.isFinite(leaf)) {
      const canonical = canonicalizeNumber(String(leaf));
      if (!canonical || !index.numericValues.has(canonical.value)) {
        ungrounded.push(String(leaf));
      }
      return;
    }
    if (typeof leaf !== 'string') return;
    const trimmed = leaf.trim();
    if (!trimmed) return;

    for (const claim of extractNumericClaims(trimmed)) {
      if (!index.numbers.has(claim.normalized)) {
        ungrounded.push(claim.raw);
        return;
      }
    }

    for (const token of tokenizeWords(maskNumericClaims(trimmed))) {
      if (!isInterestingToken(token)) continue;
      if (!index.words.has(token)) {
        ungrounded.push(token);
        return;
      }
    }
  });
  return ungrounded;
}

/**
 * Extract numeric spans from free text and return spans missing from the
 * supplied corpus. Chatter uses the context corpus, so repeating a number
 * from the task is allowed without treating the task as final-answer evidence.
 */
export function findUngroundedFactSpans(
  text: string,
  corpus: string,
): string[] {
  if (!text) return [];
  const grounded = buildCorpusIndex(corpus).numbers;
  return extractNumericClaims(text)
    .filter((claim) => !grounded.has(claim.normalized))
    .map((claim) => claim.raw);
}

/** Replace every unsupported numeric span with [?]. */
export function scrubUngroundedFactSpans(
  text: string,
  corpus: string,
): { text: string; scrubbed: string[] } {
  if (!text) return { text, scrubbed: [] };
  const grounded = buildCorpusIndex(corpus).numbers;
  const scrubbed: string[] = [];
  const out = text.replace(numericClaimRe(), (raw) => {
    const canonical = canonicalizeNumber(raw);
    if (canonical && grounded.has(canonical.normalized)) return raw;
    scrubbed.push(raw);
    return '[?]';
  });
  return { text: out, scrubbed };
}

interface NumericClaim {
  raw: string;
  normalized: string;
  value: string;
}

function numericClaimRe(): RegExp {
  return /(?<![\p{L}\p{N}_])[+-]?(?:[$\u20ac\u00a3\u00a5]\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?(?![\p{L}\p{N}_]|\.\d)/gu;
}

function extractNumericClaims(text: string): NumericClaim[] {
  const claims: NumericClaim[] = [];
  for (const match of text.matchAll(numericClaimRe())) {
    const raw = match[0];
    const canonical = canonicalizeNumber(raw);
    if (canonical) claims.push({ raw, ...canonical });
  }
  return claims;
}

function maskNumericClaims(text: string): string {
  return text.replace(numericClaimRe(), ' ');
}

interface CanonicalNumber {
  normalized: string;
  value: string;
}

function canonicalizeNumber(raw: string): CanonicalNumber | null {
  const currency = raw.match(/[$\u20ac\u00a3\u00a5]/u)?.[0] ?? '';
  const percent = /%\s*$/u.test(raw);
  let value = raw
    .toLowerCase()
    .replace(/[$\u20ac\u00a3\u00a5,%\s]/g, '');
  if (!value) return null;

  let sign = '';
  if (value[0] === '+' || value[0] === '-') {
    sign = value[0] === '-' ? '-' : '';
    value = value.slice(1);
  }
  const [rawInteger = '', rawFraction] = value.split('.', 2);
  if (!/^\d+$/.test(rawInteger)) return null;
  const integer = rawInteger.replace(/^0+(?=\d)/, '') || '0';
  const fraction = rawFraction?.replace(/0+$/, '');
  const magnitude = fraction ? `${integer}.${fraction}` : integer;
  const signedValue = magnitude === '0' ? '0' : `${sign}${magnitude}`;
  return {
    normalized: `${currency}${signedValue}${percent ? '%' : ''}`,
    value: signedValue,
  };
}

function walk(value: unknown, cb: (leaf: unknown) => void): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, cb);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) walk(item, cb);
    return;
  }
  cb(value);
}

function tokenizeWords(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}_]+(?:['\u2019-][\p{L}\p{N}_]+)*/gu) ?? [];
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
  'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'as', 'it', 'its',
  'this', 'that', 'these', 'those', 'i', 'me', 'my', 'you', 'your', 'we', 'our',
  'they', 'them', 'he', 'she', 'him', 'her', 'his', 'hers',
  'do', 'does', 'did', 'have', 'has', 'had', 'can', 'could', 'will', 'would',
  'should', 'may', 'might', 'if', 'then', 'else', 'so', 'than', 'about',
  'here', 'there', 'when', 'where', 'why', 'how', 'what', 'which', 'who',
]);

function isInterestingToken(token: string): boolean {
  if (token.length < 2) return false;
  return !STOPWORDS.has(token);
}
