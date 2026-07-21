import type { ToolCallRecord } from '../types.js';

export interface ToolContext {
  signal?: AbortSignal;
  /** Stable key used by stateful tools (e.g., browser) to isolate per-fetch state. */
  sessionKey?: string;
}

export interface Tool {
  name: string;
  description: string;
  execute(args: unknown, ctx: ToolContext): Promise<unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): string[] {
    return [...this.tools.keys()];
  }

  async invoke(
    name: string,
    args: unknown,
    acl: readonly string[],
    ctx: ToolContext = {},
  ): Promise<ToolCallRecord> {
    const start = Date.now();
    if (!acl.includes(name)) {
      return {
        name,
        args,
        ok: false,
        ts: start,
        durationMs: 0,
        error: `tool "${name}" not in this Fetch's ACL [${acl.join(', ')}]`,
      };
    }
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        name,
        args,
        ok: false,
        ts: start,
        durationMs: 0,
        error: `tool "${name}" not registered`,
      };
    }
    try {
      const result = await tool.execute(args, ctx);
      return {
        name,
        args,
        result,
        ok: true,
        ts: start,
        durationMs: Date.now() - start,
      };
    } catch (e) {
      return {
        name,
        args,
        ok: false,
        ts: start,
        durationMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}
