import { realpath } from 'node:fs/promises';
import path from 'node:path';

const ALLOW_WIDE_ENV = 'MISTER_FETCH_ALLOW_WIDE_LOCAL';
const ROOTS_ENV = 'MISTER_FETCH_ALLOWED_ROOTS';

function isEnabled(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

function configuredRoots(): string[] {
  const raw = process.env[ROOTS_ENV];
  const roots = raw
    ? raw.split(path.delimiter).map((p) => p.trim()).filter(Boolean)
    : [process.cwd()];
  return roots.map((p) => path.resolve(p));
}

function hasRootPrefix(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function canonicalizeExisting(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

export async function assertAllowedLocalPath(input: string, toolName: string): Promise<string> {
  const candidate = await canonicalizeExisting(path.resolve(input));
  if (isEnabled(process.env[ALLOW_WIDE_ENV])) return candidate;

  const roots = await Promise.all(configuredRoots().map((r) => canonicalizeExisting(r)));
  if (roots.some((root) => hasRootPrefix(candidate, root))) return candidate;

  throw new Error(
    `${toolName}: path "${candidate}" is outside allowed local roots ` +
      `[${roots.join(', ')}]. Set ${ROOTS_ENV} or ${ALLOW_WIDE_ENV}=1 to widen search.`,
  );
}

export async function defaultLocalSearchRoot(toolName: string): Promise<string | null> {
  if (isEnabled(process.env[ALLOW_WIDE_ENV])) return null;
  return assertAllowedLocalPath(process.cwd(), toolName);
}
