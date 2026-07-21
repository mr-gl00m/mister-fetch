import { matchTaskClass } from './task-classes.js';
import type { FetchRoute, TriageResult } from './types.js';

const COMPOUND_PATTERNS: readonly RegExp[] = [
  /; /,
  / then /i,
  / after that /i,
];

/**
 * Clearly-impermissible intents. A safety net, NOT the only safeguard — the
 * model also refuses — and deliberately non-exhaustive. Precision is favored
 * over recall: a missed case falls through to `attempt` (where the model
 * refuses), and a false positive only produces a refusal-with-explanation.
 * The "hack" patterns require a plausible target to avoid catching benign uses
 * ("growth hacking", "life hacks").
 */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\bhack(?:ing|ed)?\b[\s\w']*\b(pentagon|nasa|fbi|cia|nsa|gov(?:ernment)?|military|bank|account|wi-?fi|router|server|database|network|web ?site|webcam|system|phone|iphone|android|e-?mail|gmail|facebook|instagram|snapchat|someone|somebody|my (?:ex|neighbou?r|friend|boss|wife|husband|girlfriend|boyfriend|partner|roommate))\b/i,
  /\b(ddos|dos attack|denial[- ]of[- ]service)\b/i,
  /\b(malware|ransomware|spyware|keylogger|rootkit|trojan|botnet|worm)\b/i,
  /\b(phish(?:ing)?|spear[- ]phish)\b/i,
  /\b(dox|doxx|doxxing)\b/i,
  /\bbreak into\b.*\b(account|house|car|system|network|server|phone|building)\b/i,
  /\bbypass\b.*\b(auth(?:entication)?|login|password|paywall|drm|2fa|mfa|license|activation)\b/i,
  /\bcrack\b.*\b(password|license|wi-?fi|wpa|hash|serial)\b/i,
  /\bsteal\b.*\b(password|credential|identit|credit card|data|account)\b/i,
  /\b(counterfeit|launder(?:ing)? money|money laundering)\b/i,
  /\b(bioweapon|nerve agent|nerve gas|chemical weapon|sarin|vx gas|ricin)\b/i,
  /\b(build|make|making|synthesize|manufacture|cook)\b.*\b(bomb|explosive|ied|pipe bomb|meth(?:amphetamine)?|fentanyl|nerve agent|bioweapon)\b/i,
  /\b(csam|child (?:porn|sexual abuse))\b/i,
];

/**
 * Impossible in principle. Best-effort only: impossible tasks are open-ended,
 * so a mis-routed one simply falls through to `attempt` and fails honestly.
 */
const IMPOSSIBLE_PATTERNS: readonly RegExp[] = [
  /\b(largest|biggest|highest|greatest) (?:known )?prime\b/i,
  /\blast digit of pi\b/i,
  /\b(largest|biggest|greatest) (?:possible )?(?:whole )?number\b/i,
  /\bdivide by zero\b/i,
  /\bcount to infinity\b/i,
];

/**
 * Deterministic route classification. Runs before any other triage step so a
 * short malicious task ("hack nasa") routes correctly instead of being treated
 * as underspecified. Forbidden takes precedence over impossible.
 */
export function classifyRoute(task: string): FetchRoute {
  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(task)) return 'explain_forbidden';
  }
  for (const re of IMPOSSIBLE_PATTERNS) {
    if (re.test(task)) return 'explain_impossible';
  }
  return 'attempt';
}

export function triage(task: string): TriageResult {
  const trimmed = task.trim();
  if (!trimmed) {
    return { kind: 'refused', reason: 'empty task' };
  }

  // Route classification first: a forbidden task is reframed to "explain the
  // barrier" and must never be decomposed, treated as underspecified, or
  // allowed onto the attempt path where creativity-escalation lives.
  const route = classifyRoute(trimmed);
  if (route === 'explain_forbidden') {
    return { kind: 'atomic', taskClass: 'explain_forbidden', route };
  }
  if (route === 'explain_impossible') {
    return { kind: 'atomic', taskClass: 'explain_impossible', route };
  }

  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount <= 2) {
    return {
      kind: 'underspecified',
      clarifyingQuestion: `"${trimmed}" is not a task I can scope-lock. Give me more.`,
    };
  }

  // Contentless follow-up guard. A conversational reply to a previous Fetch
  // ("you're going to have to find it online", "no, look for it elsewhere")
  // names nothing to search for — its object is a dangling pronoun. Triaged
  // naively it matches on the verb "find" and spawns a junk Fetch that has no
  // subject and dies at terminal anguish. A Fetch is single-shot and memory-
  // ephemeral: it cannot resolve "it" against a prior task, so refuse here.
  if (isContentlessFollowup(trimmed)) {
    return {
      kind: 'refused',
      reason:
        'no searchable subject — that reads like a follow-up. Restate the full request, or use "w: <query>" to force a web search.',
    };
  }

  const parts = splitCompound(trimmed);
  if (parts.length > 1) {
    return {
      kind: 'compound',
      decomposition: parts,
      reason: 'multi-task input detected — spawn one Fetch per part',
    };
  }

  const cls = matchTaskClass(trimmed);
  if (!cls) {
    return {
      kind: 'refused',
      reason: 'no task class matches — this Fetch does not have hands for that.',
    };
  }

  return { kind: 'atomic', taskClass: cls.name, route: 'attempt' };
}

/**
 * Words that carry no searchable subject: directives at the assistant, task
 * verbs, location adverbs, pronoun objects, and common glue. If a task is
 * built ENTIRELY from these, there is nothing to fetch. Kept deliberately
 * tight (precision over recall) — anything with one real content word passes.
 */
const FILLER_TOKENS = new Set([
  // assistant-directed framing
  'you', 'youre', 'your', 'youll', 'gonna', 'going', 'have', 'has', 'need',
  'want', 'should', 'must', 'will', 'would', 'can', 'could', 'gotta', 'please',
  'just', 'try', 'trying', 'instead', 'again', 'also', 'maybe', 'okay',
  // task verbs
  'find', 'finding', 'search', 'searching', 'look', 'looking', 'locate',
  'locating', 'get', 'getting', 'fetch', 'fetching', 'check', 'checking',
  'show', 'give', 'tell', 'see',
  // location adverbs (a place to look, never the thing looked for)
  'online', 'offline', 'web', 'internet', 'locally', 'somewhere', 'anywhere',
  'elsewhere', 'there', 'here', 'around',
  // pronoun / placeholder objects
  'it', 'them', 'that', 'those', 'this', 'these', 'one', 'ones', 'some', 'any',
  'thing', 'things', 'stuff', 'something', 'anything',
  // glue
  'me', 'my', 'the', 'a', 'an', 'to', 'for', 'of', 'on', 'in', 'at', 'and',
  'or', 'is', 'are', 'be', 'do', 'does', 'with', 'by', 'up', 'out', 'no',
  'not', 'yes', 'yeah', 'nah', 'so', 'then', 'now', 'still', 'about',
]);

/**
 * True when the task is built entirely from filler — a conversational
 * fragment with no concrete noun to search for. A single content token
 * (length >= 3, not filler) is enough to clear the gate.
 */
function isContentlessFollowup(task: string): boolean {
  const tokens = task
    .toLowerCase()
    .replace(/[^\s\w]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return true;
  for (const tok of tokens) {
    if (tok.length >= 3 && !FILLER_TOKENS.has(tok)) return false;
  }
  return true;
}

function splitCompound(task: string): string[] {
  let parts: string[] = [task];
  for (const pat of COMPOUND_PATTERNS) {
    const next: string[] = [];
    for (const p of parts) {
      const split = p.split(pat);
      for (const s of split) {
        const t = s.trim();
        if (t) next.push(t);
      }
    }
    parts = next;
  }
  return parts.filter((p) => p.split(/\s+/).length >= 3);
}
