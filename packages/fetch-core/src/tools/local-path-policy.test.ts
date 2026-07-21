import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { assertAllowedLocalPath, defaultLocalSearchRoot } from './local-path-policy.js';

const oldCwd = process.cwd();
const oldRoots = process.env.MISTER_FETCH_ALLOWED_ROOTS;
const oldWide = process.env.MISTER_FETCH_ALLOW_WIDE_LOCAL;
const temps: string[] = [];

afterEach(async () => {
  process.chdir(oldCwd);
  if (oldRoots === undefined) delete process.env.MISTER_FETCH_ALLOWED_ROOTS;
  else process.env.MISTER_FETCH_ALLOWED_ROOTS = oldRoots;
  if (oldWide === undefined) delete process.env.MISTER_FETCH_ALLOW_WIDE_LOCAL;
  else process.env.MISTER_FETCH_ALLOW_WIDE_LOCAL = oldWide;
  await Promise.all(temps.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mister-fetch-path-'));
  temps.push(dir);
  return dir;
}

describe('local path policy', () => {
  it('allows paths under the configured root', async () => {
    const root = await tempDir();
    process.env.MISTER_FETCH_ALLOWED_ROOTS = root;

    await expect(assertAllowedLocalPath(path.join(root, 'child'), 'test_tool')).resolves.toBe(
      path.join(root, 'child'),
    );
  });

  it('rejects paths outside the configured root', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    process.env.MISTER_FETCH_ALLOWED_ROOTS = root;

    await expect(assertAllowedLocalPath(outside, 'test_tool')).rejects.toThrow(/outside allowed local roots/);
  });

  it('defaults unscoped searches to cwd unless wide local search is enabled', async () => {
    const root = await tempDir();
    process.chdir(root);
    delete process.env.MISTER_FETCH_ALLOWED_ROOTS;
    delete process.env.MISTER_FETCH_ALLOW_WIDE_LOCAL;

    await expect(defaultLocalSearchRoot('test_tool')).resolves.toBe(root);

    process.env.MISTER_FETCH_ALLOW_WIDE_LOCAL = '1';
    await expect(defaultLocalSearchRoot('test_tool')).resolves.toBeNull();
  });
});
