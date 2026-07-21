import type { Provider, ProviderMessage, ProviderOptions } from '@mister-fetch/core';

export interface OllamaProviderOptions {
  baseUrl?: string;
  model?: string;
}

export function normalizeOllamaBaseUrl(raw: string | undefined): string {
  const base = (raw ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`invalid MISTER_FETCH_OLLAMA_URL: ${base}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`invalid MISTER_FETCH_OLLAMA_URL protocol: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const local =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0';
  if (!local && process.env.OLLAMA_ALLOW_REMOTE !== '1') {
    throw new Error(
      `refusing remote Ollama URL "${base}". Set OLLAMA_ALLOW_REMOTE=1 to allow prompt/tool-log egress.`,
    );
  }
  return base;
}

export function createOllamaProvider(opts: OllamaProviderOptions = {}): Provider {
  // 127.0.0.1, not localhost: Node's fetch can resolve "localhost" to IPv6 ::1
  // while Ollama binds IPv4 127.0.0.1, producing an opaque "fetch failed".
  const baseUrl = normalizeOllamaBaseUrl(opts.baseUrl);
  const model = opts.model ?? 'hermes3:latest';

  return {
    name: `ollama:${model}`,
    chat(messages, options = {}): AsyncIterable<string> {
      return streamChat(baseUrl, model, messages, options);
    },
  };
}

async function* streamChat(
  baseUrl: string,
  model: string,
  messages: readonly ProviderMessage[],
  options: ProviderOptions,
): AsyncIterable<string> {
  const body = {
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    format: 'json',
    options: {
      temperature: options.temperature ?? 0.5,
      num_predict: options.maxTokens ?? 1024,
      ...(options.stopSequences ? { stop: [...options.stopSequences] } : {}),
    },
  };

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    throw new Error(`ollama HTTP ${res.status}${errText ? `: ${errText}` : ''}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // finally: an abandoned generator (worker bails mid-stream on abort) must
  // cancel the reader, which closes the connection and lets Ollama stop
  // generating instead of finishing the turn for nobody.
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as {
            message?: { content?: string };
            done?: boolean;
          };
          if (msg.message?.content) {
            yield msg.message.content;
          }
          if (msg.done) return;
        } catch {
          // skip malformed line
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
