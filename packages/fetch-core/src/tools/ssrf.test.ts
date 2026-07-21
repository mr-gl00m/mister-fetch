import { describe, it, expect } from 'vitest';
import { isBlockedHost, assertPublicUrl } from './ssrf.js';

describe('SSRF host guard (BH-2026-07-04-001 / 005)', () => {
  it('blocks loopback, private, link-local, and metadata literals', () => {
    for (const h of [
      '127.0.0.1',
      'localhost',
      'sub.localhost',
      '10.1.2.3',
      '192.168.1.1',
      '172.16.0.1',
      '169.254.169.254',
      'metadata.google.internal',
      '0.0.0.0',
      '100.64.0.1',
    ]) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });

  it('blocks the numeric IPv4 forms that the old startsWith checks missed', () => {
    // All of these route to 127.0.0.1.
    for (const h of ['2130706433', '0x7f000001', '0177.0.0.1', '127.1']) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });

  it('blocks IPv6 loopback, link-local, ULA, and mapped loopback', () => {
    for (const h of ['::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1']) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });

  it('allows ordinary public hostnames and IPs', () => {
    for (const h of ['example.com', 'news.ycombinator.com', '8.8.8.8', '1.1.1.1']) {
      expect(isBlockedHost(h)).toBe(false);
    }
  });

  it('assertPublicUrl rejects private hosts and non-http protocols', async () => {
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/blocked/);
    await expect(assertPublicUrl('http://127.0.0.1:11434/api')).rejects.toThrow(/blocked/);
    await expect(assertPublicUrl('http://2130706433/')).rejects.toThrow(/blocked/);
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/blocked/);
  });

  it('assertPublicUrl allows a public literal IP without a DNS lookup', async () => {
    await expect(assertPublicUrl('https://8.8.8.8/')).resolves.toBeInstanceOf(URL);
  });
});
