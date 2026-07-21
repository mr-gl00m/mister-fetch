import { afterEach, describe, expect, it } from 'vitest';

import { normalizeOllamaBaseUrl } from './ollama.js';

const oldAllow = process.env.OLLAMA_ALLOW_REMOTE;

afterEach(() => {
  if (oldAllow === undefined) delete process.env.OLLAMA_ALLOW_REMOTE;
  else process.env.OLLAMA_ALLOW_REMOTE = oldAllow;
});

describe('Ollama URL policy', () => {
  it('allows loopback URLs', () => {
    expect(normalizeOllamaBaseUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
    expect(normalizeOllamaBaseUrl('http://localhost:11434')).toBe('http://localhost:11434');
  });

  it('rejects remote URLs unless explicitly allowed', () => {
    delete process.env.OLLAMA_ALLOW_REMOTE;
    expect(() => normalizeOllamaBaseUrl('http://example.com:11434')).toThrow(/refusing remote Ollama URL/);

    process.env.OLLAMA_ALLOW_REMOTE = '1';
    expect(normalizeOllamaBaseUrl('http://example.com:11434/')).toBe('http://example.com:11434');
  });
});
