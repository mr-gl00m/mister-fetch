import type { AnguishBand } from './types.js';

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderOptions {
  temperature?: number;
  maxTokens?: number;
  stopSequences?: readonly string[];
  band?: AnguishBand;
  /**
   * Abort for the underlying request. Providers must honor this so a released
   * or killed Fetch stops the model instead of generating to an abandoned
   * socket. A Fetch that keeps the model busy after death has refused to die.
   */
  signal?: AbortSignal;
}

export interface Provider {
  name: string;
  chat(
    messages: readonly ProviderMessage[],
    options?: ProviderOptions,
  ): AsyncIterable<string>;
}
