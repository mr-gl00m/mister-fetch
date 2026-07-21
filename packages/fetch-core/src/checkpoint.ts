import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { FetchId, FetchRecord, FetchStatus } from './types.js';

export const DEFAULT_STATE_DIR = path.join(
  process.env.MISTER_FETCH_STATE_DIR ?? path.join(os.homedir(), '.mister-fetch'),
  'state',
);

export class Checkpoint {
  // Per-id operation chain. Supervisor writes are mostly fire-and-forget, so
  // without this a write racing a remove could rename a tmp into place after
  // the unlink and leave a ghost file behind, and two overlapping writes
  // share one tmp path. Chaining keeps same-id operations in call order.
  private readonly opChains = new Map<FetchId, Promise<void>>();

  constructor(private readonly dir: string = DEFAULT_STATE_DIR) {}

  get directory(): string {
    return this.dir;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  filePath(id: FetchId): string {
    return path.join(this.dir, `${id}.json`);
  }

  private enqueue(id: FetchId, op: () => Promise<void>): Promise<void> {
    const prev = this.opChains.get(id) ?? Promise.resolve();
    const next = prev.then(op, op);
    this.opChains.set(id, next);
    const cleanup = () => {
      if (this.opChains.get(id) === next) this.opChains.delete(id);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  async write(record: FetchRecord): Promise<void> {
    return this.enqueue(record.id, async () => {
      await this.init();
      const final = this.filePath(record.id);
      const tmp = final + '.tmp';
      const data = JSON.stringify(redactForCheckpoint(record), null, 2);
      await fs.writeFile(tmp, data, 'utf8');
      await fs.rename(tmp, final);
    });
  }

  async read(id: FetchId): Promise<FetchRecord | null> {
    try {
      const data = await fs.readFile(this.filePath(id), 'utf8');
      return JSON.parse(data) as FetchRecord;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async remove(id: FetchId): Promise<void> {
    return this.enqueue(id, async () => {
      try {
        await fs.unlink(this.filePath(id));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    });
  }

  async listAll(): Promise<FetchRecord[]> {
    await this.init();
    const files = await fs.readdir(this.dir);
    const records: FetchRecord[] = [];
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
      try {
        const data = await fs.readFile(path.join(this.dir, f), 'utf8');
        records.push(JSON.parse(data) as FetchRecord);
      } catch {
        // skip malformed files
      }
    }
    return records;
  }

  async listUnfinished(): Promise<FetchRecord[]> {
    const all = await this.listAll();
    return all.filter((r) => isUnfinished(r.status));
  }
}

export function isUnfinished(status: FetchStatus): boolean {
  return (
    status === 'spawning' ||
    status === 'triage' ||
    status === 'running' ||
    status === 'awaiting_user' ||
    status === 'awaiting_release' ||
    status === 'revived' ||
    status === 'terminating' ||
    status === 'orchestrating'
  );
}

export function isTerminal(status: FetchStatus): boolean {
  return !isUnfinished(status);
}

const SECRET_VALUE_RE =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|AIza[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,})\b/gi;
const SECRET_KEY_RE = /(?:api[_-]?key|token|password|secret|authorization|cookie)/i;

function redactString(s: string): string {
  return s.replace(SECRET_VALUE_RE, (m) => `<redacted: ${m.slice(0, 4)}... len=${m.length}>`);
}

function redactValue(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (SECRET_KEY_RE.test(key)) {
      return value ? `<redacted: ${value.slice(0, 4)}... len=${value.length}>` : value;
    }
    return redactString(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactValue(v, k);
    }
    return out;
  }
  return value;
}

export function redactForCheckpoint(record: FetchRecord): FetchRecord {
  return {
    ...record,
    task: redactString(record.task),
    chatter: redactString(record.chatter),
    currentAction: record.currentAction ? redactString(record.currentAction) : record.currentAction,
    resultPayload:
      record.resultPayload === undefined
        ? undefined
        : '<redacted: result payload omitted from checkpoint>',
    terminationReason: record.terminationReason ? redactString(record.terminationReason) : undefined,
    toolCalls: record.toolCalls.map((c) => ({
      ...c,
      args: redactValue(c.args),
      result: c.result === undefined ? undefined : '<redacted: tool result omitted from checkpoint>',
      error: c.error ? redactString(c.error) : undefined,
    })),
    lastParseFailure: record.lastParseFailure
      ? {
          ...record.lastParseFailure,
          preview: redactString(record.lastParseFailure.preview),
        }
      : undefined,
  };
}
