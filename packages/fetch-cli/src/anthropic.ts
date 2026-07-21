import Anthropic from '@anthropic-ai/sdk';
import type {
  Provider,
  ProviderMessage,
  ProviderOptions,
} from '@mister-fetch/core';

export interface AnthropicProviderOptions {
  apiKey?: string;
  model?: string;
}

export function createAnthropicProvider(
  opts: AnthropicProviderOptions = {},
): Provider {
  const model = opts.model ?? 'claude-opus-4-6';
  const client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});

  return {
    name: `anthropic:${model}`,
    chat(messages, options = {}): AsyncIterable<string> {
      return streamChat(client, model, messages, options);
    },
  };
}

async function* streamChat(
  client: Anthropic,
  model: string,
  messages: readonly ProviderMessage[],
  options: ProviderOptions,
): AsyncIterable<string> {
  const systemParts: string[] = [];
  const convo: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else {
      convo.push({ role: m.role, content: m.content });
    }
  }

  if (convo.length === 0) {
    convo.push({ role: 'user', content: 'Respond with the next action.' });
  }

  // Force JSON output: prefill the assistant turn with '{'. Anthropic
  // models continue from the prefill character, guaranteeing the response
  // starts inside a JSON object. We echo '{' as the first yielded chunk so
  // the worker's parser sees a complete object.
  convo.push({ role: 'assistant', content: '{' });

  const params: Anthropic.MessageCreateParamsStreaming = {
    model,
    max_tokens: options.maxTokens ?? 2048,
    temperature: Math.min(1, Math.max(0, options.temperature ?? 0.5)),
    messages: convo,
    stream: true,
  };
  if (systemParts.length > 0) {
    params.system = systemParts.join('\n\n');
  }
  if (options.stopSequences && options.stopSequences.length > 0) {
    params.stop_sequences = [...options.stopSequences];
  }

  yield '{';
  const stream = client.messages.stream(
    params,
    options.signal ? { signal: options.signal } : undefined,
  );
  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      yield event.delta.text;
    }
  }
}
