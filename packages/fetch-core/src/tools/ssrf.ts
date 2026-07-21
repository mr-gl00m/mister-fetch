import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * SSRF guard shared by web_fetch and browser. A web-research fetch must never
 * reach loopback, private, link-local, or cloud-metadata targets. The literal
 * check covers the dotted-quad, decimal, hex, and octal IPv4 forms (the OS
 * routes 2130706433 / 0x7f000001 / 0177.0.0.1 to 127.0.0.1) plus IPv6
 * loopback/ULA/link-local. assertPublicUrl additionally resolves DNS names and
 * rejects a public name that points at a private address.
 *
 * Closes bug-hunt findings BH-2026-07-04-001 (web_fetch had no gate) and
 * BH-2026-07-04-005 (browser's literal-string gate missed the numeric forms).
 */

function parseIntStrict(part: string): number | null {
  if (/^0x[0-9a-f]+$/i.test(part)) return parseInt(part, 16);
  if (/^0[0-7]+$/.test(part)) return parseInt(part, 8);
  if (/^\d+$/.test(part)) return parseInt(part, 10);
  return null;
}

/**
 * Normalize an IPv4 host string (dotted-quad or a short a / a.b / a.b.c form,
 * each part decimal, hex, or octal) into 4 octets the way inet_aton does.
 * Returns null for anything that is not an IPv4 form (e.g. a DNS name).
 */
function ipv4ToOctets(host: string): number[] | null {
  const parts = host.trim().split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = parseIntStrict(p);
    if (n === null || n < 0) return null;
    nums.push(n);
  }
  if (nums.length === 4) {
    return nums.every((n) => n <= 255) ? nums : null;
  }
  if (nums.length === 1) {
    const v = nums[0]!;
    if (v > 0xffffffff) return null;
    return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  }
  if (nums.length === 2 && nums[0]! <= 255 && nums[1]! <= 0xffffff) {
    const v = nums[1]!;
    return [nums[0]!, (v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  if (nums.length === 3 && nums[0]! <= 255 && nums[1]! <= 255 && nums[2]! <= 0xffff) {
    const v = nums[2]!;
    return [nums[0]!, nums[1]!, (v >> 8) & 255, v & 255];
  }
  return null;
}

function isPrivateOctets(octets: number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback /8
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIPv6(raw: string): boolean {
  const h = raw.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe80:')) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // ULA fc00::/7
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped) {
    const octets = ipv4ToOctets(mapped[1]!);
    return octets ? isPrivateOctets(octets) : true;
  }
  return false;
}

/** True when a literal host string is a private / loopback / metadata target. */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '') return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'metadata.google.internal') return true;
  if (isIP(host) === 6) return isPrivateIPv6(host);
  const octets = ipv4ToOctets(host);
  if (octets) return isPrivateOctets(octets);
  return false;
}

/**
 * Validate an outbound URL. Rejects unsupported protocols and private hosts,
 * then resolves DNS names and rejects if any resolved address is private.
 * Returns the parsed URL on success; throws (message prefixed "blocked:") on
 * any block so callers can surface a terse reason.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`blocked: invalid url "${raw}"`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`blocked: unsupported protocol "${u.protocol}"`);
  }
  if (isBlockedHost(u.hostname)) {
    throw new Error(`blocked: host "${u.hostname}" is a private or loopback address`);
  }
  const stripped = u.hostname.replace(/^\[|\]$/g, '');
  const isLiteralIp = isIP(stripped) !== 0 || ipv4ToOctets(u.hostname) !== null;
  if (!isLiteralIp) {
    let addrs: { address: string }[];
    try {
      addrs = await lookup(u.hostname, { all: true });
    } catch {
      throw new Error(`blocked: cannot resolve host "${u.hostname}"`);
    }
    for (const a of addrs) {
      if (isBlockedHost(a.address)) {
        throw new Error(
          `blocked: host "${u.hostname}" resolves to private address ${a.address}`,
        );
      }
    }
  }
  return u;
}
