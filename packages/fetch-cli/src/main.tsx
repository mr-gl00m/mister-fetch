#!/usr/bin/env node
// npm workspace scripts run with cwd=packages/fetch-cli. Restore the
// directory the user actually launched from (npm records it in INIT_CWD)
// so relative paths in f:/g:/dg:/open: resolve against it.
if (process.env.INIT_CWD) process.chdir(process.env.INIT_CWD);

import React from 'react';
import { render } from 'ink';
import { EventEmitter } from 'node:events';
import { Supervisor } from '@mister-fetch/core';
import { createOllamaProvider, normalizeOllamaBaseUrl } from './ollama.js';
import { createAnthropicProvider } from './anthropic.js';
import { App } from './ui/app.js';
import { runPreflight, renderPreflight } from './preflight.js';

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const envModel = process.env.MISTER_FETCH_MODEL;
const ollamaBaseUrl = normalizeOllamaBaseUrl(process.env.MISTER_FETCH_OLLAMA_URL);
const ollamaModel = envModel ?? 'hermes3:latest';

const events = new EventEmitter();
const provider = anthropicKey
  ? createAnthropicProvider({
      apiKey: anthropicKey,
      model: envModel ?? 'claude-opus-4-6',
    })
  : createOllamaProvider({ baseUrl: ollamaBaseUrl, model: ollamaModel });

const model = provider.name;

const supervisor = new Supervisor({
  provider,
  onUpdate: (r) => events.emit('update', r),
  onTriageRejection: (task, result) => events.emit('reject', { task, result }),
});

void (async () => {
  // Preflight: surface a down model server / missing model / no search provider
  // up front, instead of letting it masquerade as a failed Fetch later.
  try {
    const report = await runPreflight({
      usingAnthropic: !!anthropicKey,
      anthropicKeyPresent: !!anthropicKey,
      ollamaBaseUrl,
      model: anthropicKey ? envModel ?? 'claude-opus-4-6' : ollamaModel,
    });
    process.stdout.write('MISTER FETCH preflight:\n' + renderPreflight(report) + '\n\n');
  } catch {
    // Never let preflight block startup.
  }
  // OSC 0 sets both the window and icon title on xterm-compatible terminals.
  process.stdout.write('\x1b]0;MISTER FETCH — FETCH QUEST\x07');
  render(<App supervisor={supervisor} events={events} model={model} />);
})();
