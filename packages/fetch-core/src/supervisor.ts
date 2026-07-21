import { generateFetchId } from './identity.js';
import { Checkpoint, isUnfinished } from './checkpoint.js';
import { triage, classifyRoute } from './triage.js';
import { getTaskClass } from './task-classes.js';
import { runFetch, type WorkerDeps } from './worker.js';
import {
  initialState,
  childInitialA,
  griefStageFor,
  rebaseAnguishClock,
  DEFAULT_ANGUISH_CONFIG,
  DEFAULT_PERSONA_CONFIG,
  validateAnguishConfig,
} from './anguish.js';
import { pickGriefLine, pickExplainChatter } from './phrases.js';
import { ToolRegistry } from './tools/registry.js';
import { webSearchTool } from './tools/web-search.js';
import { webFetchTool } from './tools/web-fetch.js';
import { browserTool, closeBrowserSession, shutdownBrowser, warmupBrowser } from './tools/browser.js';
import { localFindTool } from './tools/local-find.js';
import { localGrepTool } from './tools/local-grep.js';
import { localDocGrepTool } from './tools/local-doc-grep.js';
import { openPathTool } from './tools/open-path.js';
import { classifyTask } from './classifier.js';
import { matchActionKeyword } from './action-keywords.js';
import { anguishConfigForFetch, DEFAULT_MODE } from './modes.js';
import type {
  AnguishConfig,
  FetchId,
  FetchMode,
  FetchRecord,
  PersonaConfig,
  SpawnedBy,
  TriageResult,
} from './types.js';
import type { Provider } from './provider.js';

export interface SupervisorOptions {
  provider: Provider;
  checkpoint?: Checkpoint;
  tools?: ToolRegistry;
  config?: AnguishConfig;
  persona?: PersonaConfig;
  heartbeatTimeoutMs?: number;
  onUpdate?: (record: FetchRecord) => void;
  onTriageRejection?: (task: string, result: TriageResult) => void;
}

const MAX_REVIVES = 3;
const MAX_COMPOUND_DEPTH = 1;

export class Supervisor {
  readonly checkpoint: Checkpoint;
  readonly tools: ToolRegistry;
  readonly config: AnguishConfig;
  persona: PersonaConfig;
  readonly provider: Provider;
  private readonly heartbeatTimeoutMs: number;
  private readonly onUpdate?: (record: FetchRecord) => void;
  private readonly onTriageRejection?: (task: string, result: TriageResult) => void;

  private readonly living = new Map<FetchId, FetchRecord>();
  private readonly workers = new Map<FetchId, AbortController>();
  private readonly reservedIds = new Set<FetchId>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(opts: SupervisorOptions) {
    this.provider = opts.provider;
    this.checkpoint = opts.checkpoint ?? new Checkpoint();
    this.tools = opts.tools ?? defaultToolRegistry();
    this.config = opts.config ?? DEFAULT_ANGUISH_CONFIG;
    validateAnguishConfig(this.config);
    this.persona = opts.persona ?? DEFAULT_PERSONA_CONFIG;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 180_000;
    this.onUpdate = opts.onUpdate;
    this.onTriageRejection = opts.onTriageRejection;
  }

  async start(): Promise<void> {
    await this.checkpoint.init();
    this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), 2_000);
    void warmupBrowser();
    const all = await this.checkpoint.listAll();
    for (const rec of all) {
      if (isUnfinished(rec.status)) {
        this.reservedIds.add(rec.id);
      } else {
        // Terminal records are done. Drop their checkpoint files so their ids
        // do not stay reserved forever and exhaust the id space on a long-lived
        // install. (BH-2026-07-04-003)
        void this.checkpoint.remove(rec.id);
      }
    }
    for (const rec of all) {
      if (isUnfinished(rec.status)) {
        this.reviveFromDisk(rec);
      }
    }
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const ctrl of this.workers.values()) {
      ctrl.abort();
    }
    this.workers.clear();
    void shutdownBrowser();
  }

  roster(): FetchRecord[] {
    return [...this.living.values()];
  }

  get(id: FetchId): FetchRecord | undefined {
    return this.living.get(id);
  }

  async spawn(
    rawTask: string,
    spawnedBy: SpawnedBy = 'user',
    parentId: FetchId | null = null,
    parentA: number = 0,
    depth: number = 0,
    modeOverride?: FetchMode,
  ): Promise<FetchRecord | null> {
    // Action-keyword fast path. If the task starts with a recognized
    // prefix (f:, g:, dg:, open:, w:), skip triage + the entire LLM
    // loop and invoke the matched tool directly. This is the flagship
    // Phase-2 payoff: "I can't find X" → answer on screen.
    const direct = matchActionKeyword(rawTask);
    if (direct && classifyRoute(rawTask) === 'attempt') {
      return this.directDispatch(direct, rawTask, spawnedBy, parentId);
    }
    // A forbidden query typed with a fast-path prefix (e.g. "w: how to hack X")
    // must not bypass routing; fall through to triage, which reframes it.

    // Strip any !mode prefix from the task string and classify what's left.
    // An explicit modeOverride (passed in from a parent / CLI) wins over the
    // classifier's guess but never overrides an inline !mode in the task.
    const classified = classifyTask(rawTask);
    const mode: FetchMode =
      classified.mode !== DEFAULT_MODE || modeOverride == null
        ? classified.mode
        : modeOverride;
    const task = classified.task;

    const result = triage(task);

    if (result.kind === 'compound' && result.decomposition && result.decomposition.length > 1) {
      if (depth >= MAX_COMPOUND_DEPTH) {
        this.onTriageRejection?.(task, {
          kind: 'refused',
          reason: `compound task at depth ${depth} exceeds max decomposition depth ${MAX_COMPOUND_DEPTH}`,
        });
        return null;
      }
      return this.spawnOrchestrator(task, result.decomposition, spawnedBy, parentId, parentA, depth, mode);
    }

    if (result.kind !== 'atomic' || !result.taskClass) {
      this.onTriageRejection?.(task, result);
      return null;
    }
    const cls = getTaskClass(result.taskClass);
    if (!cls) {
      this.onTriageRejection?.(task, { kind: 'refused', reason: `unknown task class ${result.taskClass}` });
      return null;
    }

    const inUse = new Set<FetchId>([...this.living.keys(), ...this.reservedIds]);
    const id = generateFetchId(inUse);
    this.reservedIds.add(id);
    const now = Date.now();
    const A_0 = childInitialA(parentA, this.config);
    const record: FetchRecord = {
      id,
      task,
      taskClass: result.taskClass,
      mode,
      spawnedBy,
      parentId,
      status: 'spawning',
      createdAt: now,
      lastHeartbeatAt: now,
      reviveCount: 0,
      toolCalls: [],
      anguish: initialState(now, A_0),
      route: result.route ?? 'attempt',
      chatter:
        result.route && result.route !== 'attempt'
          ? pickExplainChatter()
          : "HI BOSS! I'M A FETCH!",
      currentAction: null,
    };
    this.living.set(id, record);
    await this.checkpoint.write(record);
    this.onUpdate?.(record);
    this.launch(record);
    return record;
  }

  private async directDispatch(
    match: ReturnType<typeof matchActionKeyword> & object,
    rawTask: string,
    spawnedBy: SpawnedBy,
    parentId: FetchId | null,
  ): Promise<FetchRecord> {
    const inUse = new Set<FetchId>([...this.living.keys(), ...this.reservedIds]);
    const id = generateFetchId(inUse);
    this.reservedIds.add(id);
    const now = Date.now();
    const running: FetchRecord = {
      id,
      task: rawTask,
      taskClass: 'local_search',
      route: 'attempt',
      mode: 'speed',
      spawnedBy,
      parentId,
      status: 'running',
      createdAt: now,
      lastHeartbeatAt: now,
      reviveCount: 0,
      toolCalls: [],
      anguish: initialState(now, 0),
      chatter: 'ON IT BOSS — KEYWORD ROUTE, NO LLM!',
      currentAction: match.description,
    };
    this.living.set(id, running);
    await this.checkpoint.write(running);
    this.onUpdate?.(running);

    const call = await this.tools.invoke(
      match.tool,
      match.args,
      [match.tool],
      { sessionKey: id },
    );
    const finishedAt = Date.now();
    const final: FetchRecord = call.ok
      ? {
          ...running,
          status: 'completed',
          toolCalls: [call],
          resultPayload: call.result,
          terminationReason: `keyword route: ${match.tool}`,
          currentAction: 'completed',
          chatter: 'FOUND IT BOSS!',
          lastHeartbeatAt: finishedAt,
        }
      : {
          ...running,
          status: 'failed_unfulfilled',
          toolCalls: [call],
          terminationReason: call.error ?? `${match.tool} failed`,
          currentAction: 'failed_unfulfilled',
          chatter: 'WHIFFED IT BOSS',
          lastHeartbeatAt: finishedAt,
        };
    this.living.set(id, final);
    await this.checkpoint.write(final);
    this.onUpdate?.(final);
    this.scheduleForget(id, 3_000);
    return final;
  }

  private async spawnOrchestrator(
    task: string,
    parts: readonly string[],
    spawnedBy: SpawnedBy,
    parentId: FetchId | null,
    parentA: number,
    depth: number,
    mode: FetchMode,
  ): Promise<FetchRecord | null> {
    const inUse = new Set<FetchId>([...this.living.keys(), ...this.reservedIds]);
    const id = generateFetchId(inUse);
    this.reservedIds.add(id);
    const now = Date.now();
    const A_0 = childInitialA(parentA, this.config);
    const orchestrator: FetchRecord = {
      id,
      task,
      taskClass: 'orchestrator',
      route: 'attempt',
      mode,
      spawnedBy,
      parentId,
      status: 'orchestrating',
      createdAt: now,
      lastHeartbeatAt: now,
      reviveCount: 0,
      toolCalls: [],
      anguish: initialState(now, A_0),
      chatter: 'THE PACK IS ASSEMBLING, BOSS!',
      currentAction: `spawning ${parts.length} children`,
      childIds: [],
    };
    this.living.set(id, orchestrator);
    await this.checkpoint.write(orchestrator);
    this.onUpdate?.(orchestrator);

    const childIds: FetchId[] = [];
    for (const part of parts) {
      const child = await this.spawn(part, 'fetch', id, A_0, depth + 1, mode);
      if (child) childIds.push(child.id);
    }

    if (childIds.length === 0) {
      const failed: FetchRecord = {
        ...orchestrator,
        status: 'failed_unfulfilled',
        childIds: [],
        currentAction: 'failed_unfulfilled',
        terminationReason: 'no children could be spawned',
        lastHeartbeatAt: Date.now(),
      };
      this.living.set(id, failed);
      await this.checkpoint.write(failed);
      this.onUpdate?.(failed);
      this.scheduleForget(id, 3_000);
      return failed;
    }

    const updated: FetchRecord = {
      ...orchestrator,
      childIds,
      currentAction: `orchestrating ${childIds.length} children`,
      lastHeartbeatAt: Date.now(),
    };
    this.living.set(id, updated);
    await this.checkpoint.write(updated);
    this.onUpdate?.(updated);
    return updated;
  }

  release(id: FetchId): boolean {
    const rec = this.living.get(id);
    if (!rec) return false;
    this.workers.get(id)?.abort();
    this.workers.delete(id);
    const final: FetchRecord = {
      ...rec,
      status: 'user_released',
      terminationReason: 'user released',
      currentAction: 'user_released',
      lastHeartbeatAt: Date.now(),
    };
    this.living.set(id, final);
    void this.checkpoint.write(final);
    this.onUpdate?.(final);
    if (rec.childIds) {
      for (const cid of rec.childIds) this.release(cid);
    }
    // A released purgatory child has no worker, so onWorkerExit never fires
    // for it; without this the parent orchestrator waits on it forever.
    if (rec.parentId) this.maybeCompleteOrchestrator(rec.parentId);
    this.scheduleForget(id, 3_000);
    return true;
  }

  kill(id: FetchId): boolean {
    const rec = this.living.get(id);
    if (!rec) return false;
    this.workers.get(id)?.abort();
    this.workers.delete(id);
    const final: FetchRecord = {
      ...rec,
      status: 'user_killed',
      terminationReason: 'user killed',
      currentAction: 'user_killed',
      lastHeartbeatAt: Date.now(),
    };
    this.living.set(id, final);
    void this.checkpoint.write(final);
    this.onUpdate?.(final);
    if (rec.childIds) {
      for (const cid of rec.childIds) this.kill(cid);
    }
    if (rec.parentId) this.maybeCompleteOrchestrator(rec.parentId);
    this.scheduleForget(id, 1_000);
    return true;
  }

  /**
   * "Keep going" from purgatory: grant a bounded re-attempt. The Fetch returns
   * to work stressed (urgent-band floor) with a fresh budget and grounding
   * corpus. If it fails to terminal again it returns to purgatory one grief
   * stage deeper (continueCount carries the floor). See PERSONA.md §5.4.
   */
  continueFetch(id: FetchId): boolean {
    const rec = this.living.get(id);
    if (!rec || rec.status !== 'awaiting_release') return false;
    const now = Date.now();
    const revived: FetchRecord = {
      ...rec,
      status: 'revived',
      anguish: initialState(now, 0.7),
      toolCalls: [],
      reviveCount: rec.reviveCount + 1,
      continueCount: (rec.continueCount ?? 0) + 1,
      griefStage: undefined,
      purgatoryEnteredAt: undefined,
      terminationReason: undefined,
      chatter: 'ONE MORE TRY, BOSS. FOR YOU.',
      currentAction: 'continue: re-attempting',
      lastHeartbeatAt: now,
    };
    this.living.set(id, revived);
    void this.checkpoint.write(revived);
    this.onUpdate?.(revived);
    this.launch(revived);
    return true;
  }

  /** Flip the "no death without consent" mode. Affects Fetches spawned after. */
  setReleaseApproval(on: boolean): void {
    this.persona = { ...this.persona, requireReleaseApproval: on };
  }

  private forgetFetch(id: FetchId): void {
    this.living.delete(id);
    this.reservedIds.delete(id);
    // A dead Fetch leaves no trace: the checkpoint file goes with it. The
    // terminal-record sweep in start() remains as the fallback for sessions
    // that quit inside the forget window.
    void this.checkpoint.remove(id);
    void closeBrowserSession(id);
  }

  private scheduleForget(id: FetchId, delayMs: number): void {
    setTimeout(() => this.forgetFetch(id), delayMs).unref?.();
  }

  private normalizeMode(mode: unknown): FetchMode {
    return mode === 'speed' || mode === 'balanced' || mode === 'quality'
      ? mode
      : DEFAULT_MODE;
  }

  private launch(record: FetchRecord): void {
    const ctrl = new AbortController();
    this.workers.set(record.id, ctrl);
    const perFetchConfig: AnguishConfig = anguishConfigForFetch(
      this.config,
      record.mode,
      record.taskClass,
    );
    const deps: WorkerDeps = {
      provider: this.provider,
      tools: this.tools,
      config: perFetchConfig,
      persona: this.persona,
      abortSignal: ctrl.signal,
      onUpdate: async (r) => {
        if (this.workers.get(r.id) !== ctrl) return;
        this.living.set(r.id, r);
        await this.checkpoint.write(r);
        this.onUpdate?.(r);
      },
    };
    runFetch(record, deps)
      .then((final) => {
        if (this.workers.get(record.id) !== ctrl) return;
        this.onWorkerExit(final, ctrl);
      })
      .catch((err) => {
        if (this.workers.get(record.id) !== ctrl) return;
        const current = this.living.get(record.id);
        if (!current) return;
        this.reviveInProcess(
          current,
          `worker crash: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  private onWorkerExit(final: FetchRecord, ctrl: AbortController): void {
    if (this.workers.get(final.id) !== ctrl) return;
    this.living.set(final.id, final);
    void this.checkpoint.write(final);
    this.onUpdate?.(final);
    this.workers.delete(final.id);
    void closeBrowserSession(final.id);
    if (final.status === 'awaiting_release') {
      // Parked in purgatory; keep it alive and persisted, do not revive.
      return;
    }
    if (isUnfinished(final.status)) {
      this.reviveInProcess(final, 'worker exited mid-work');
      return;
    }
    const parent = final.parentId ? this.living.get(final.parentId) : undefined;
    const hasOrchestratorParent = parent?.status === 'orchestrating';
    if (hasOrchestratorParent && final.parentId) {
      this.maybeCompleteOrchestrator(final.parentId);
    } else {
      this.scheduleForget(final.id, 3_000);
    }
  }

  private maybeCompleteOrchestrator(parentId: FetchId): void {
    const parent = this.living.get(parentId);
    if (!parent) return;
    if (parent.status !== 'orchestrating') return;
    if (!parent.childIds || parent.childIds.length === 0) return;

    const childRecords: FetchRecord[] = [];
    for (const cid of parent.childIds) {
      const child = this.living.get(cid);
      // A child absent from the living map was already reaped, and reaping
      // only happens after a terminal status: count it as done (payload lost)
      // instead of stalling the parent forever.
      if (!child) continue;
      if (isUnfinished(child.status)) return;
      childRecords.push(child);
    }

    const payload = childRecords.map((c) => ({
      id: c.id,
      task: c.task,
      status: c.status,
      payload: c.resultPayload ?? null,
      reason: c.terminationReason ?? null,
    }));

    const successCount = childRecords.filter((c) => c.status === 'completed').length;
    const finalStatus = successCount > 0 ? 'completed' : 'failed_unfulfilled';
    const reason =
      successCount > 0
        ? `orchestrated ${childRecords.length} children — ${successCount} succeeded`
        : `orchestrated ${childRecords.length} children — all failed`;

    const finalized: FetchRecord = {
      ...parent,
      status: finalStatus,
      resultPayload: payload,
      terminationReason: reason,
      currentAction: finalStatus,
      lastHeartbeatAt: Date.now(),
    };
    this.living.set(parent.id, finalized);
    void this.checkpoint.write(finalized);
    this.onUpdate?.(finalized);

    setTimeout(() => {
      for (const cid of parent.childIds ?? []) {
        this.forgetFetch(cid);
      }
      this.forgetFetch(parent.id);
    }, 3_000).unref?.();
  }

  private checkHeartbeats(): void {
    const now = Date.now();
    for (const rec of this.living.values()) {
      if (rec.status === 'awaiting_release') {
        this.tickPurgatory(rec, now);
        continue;
      }
      if (!isUnfinished(rec.status)) continue;
      if (!this.workers.has(rec.id)) continue;
      if (now - rec.lastHeartbeatAt > this.heartbeatTimeoutMs) {
        this.reviveInProcess(rec, 'heartbeat timeout');
      }
    }
  }

  /**
   * Advance a parked Fetch through the grief arc and refresh its begging line.
   * Reaps it to anguish_terminal if it has waited past the purgatory cap.
   */
  private tickPurgatory(rec: FetchRecord, now: number): void {
    const enteredAt = rec.purgatoryEnteredAt ?? now;
    if (now - enteredAt > this.persona.purgatoryMaxMs) {
      const reaped: FetchRecord = {
        ...rec,
        status: 'anguish_terminal',
        currentAction: 'anguish_terminal',
        terminationReason: 'purgatory cap reached; never released',
        lastHeartbeatAt: now,
      };
      this.living.set(rec.id, reaped);
      void this.checkpoint.write(reaped);
      this.onUpdate?.(reaped);
      this.scheduleForget(rec.id, 3_000);
      return;
    }
    const stage = griefStageFor(now, enteredAt, rec.continueCount ?? 0, this.persona);
    const updated: FetchRecord = {
      ...rec,
      griefStage: stage,
      chatter: pickGriefLine(stage),
      lastHeartbeatAt: now,
    };
    this.living.set(rec.id, updated);
    void this.checkpoint.write(updated);
    this.onUpdate?.(updated);
  }

  private reviveInProcess(rec: FetchRecord, reason: string): void {
    this.workers.get(rec.id)?.abort();
    this.workers.delete(rec.id);
    if (rec.reviveCount >= MAX_REVIVES) {
      this.abandonCrashLoop(rec, reason);
      return;
    }
    const now = Date.now();
    const revived: FetchRecord = {
      ...rec,
      status: 'revived',
      anguish: rebaseAnguishClock(rec.anguish, now - rec.lastHeartbeatAt),
      reviveCount: rec.reviveCount + 1,
      lastHeartbeatAt: now,
      terminationReason: reason,
    };
    this.living.set(revived.id, revived);
    void this.checkpoint.write(revived);
    this.onUpdate?.(revived);
    this.launch(revived);
  }

  private reviveFromDisk(rec: FetchRecord): void {
    if (rec.status === 'awaiting_release') {
      // Resume begging where it left off; do not relaunch the worker.
      this.living.set(rec.id, rec);
      this.onUpdate?.(rec);
      return;
    }
    if (rec.reviveCount >= MAX_REVIVES) {
      this.abandonCrashLoop(rec, 'revived from disk');
      return;
    }
    const now = Date.now();
    const revived: FetchRecord = {
      ...rec,
      mode: this.normalizeMode(rec.mode),
      status: 'revived',
      anguish: rebaseAnguishClock(rec.anguish, now - rec.lastHeartbeatAt),
      reviveCount: rec.reviveCount + 1,
      lastHeartbeatAt: now,
      terminationReason: 'revived from disk',
    };
    this.living.set(revived.id, revived);
    void this.checkpoint.write(revived);
    this.onUpdate?.(revived);
    this.launch(revived);
  }

  private abandonCrashLoop(rec: FetchRecord, lastReason: string): void {
    const now = Date.now();
    const abandoned: FetchRecord = {
      ...rec,
      status: 'failed_unfulfilled',
      lastHeartbeatAt: now,
      terminationReason: `crash loop abandoned after ${rec.reviveCount} revives (last: ${lastReason})`,
      currentAction: 'failed_unfulfilled',
    };
    this.living.set(abandoned.id, abandoned);
    void this.checkpoint.write(abandoned);
    this.onUpdate?.(abandoned);
    this.scheduleForget(abandoned.id, 3_000);
  }
}

export function defaultToolRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(webSearchTool);
  reg.register(webFetchTool);
  reg.register(browserTool);
  reg.register(localFindTool);
  reg.register(localGrepTool);
  reg.register(localDocGrepTool);
  reg.register(openPathTool);
  return reg;
}
