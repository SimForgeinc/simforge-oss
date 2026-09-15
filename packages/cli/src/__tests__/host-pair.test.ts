import { describe, expect, it } from 'vitest';
import { advertisedPairingOrigin } from '../commands/host.js';

/**
 * The connect link `simforge host pair` prints must name an address the other
 * machine can dial. The host record names the bound address, which is only
 * that when the daemon was bound to a single routable interface.
 */
describe('the pairing link advertises a dialable origin', () => {
  it('uses a single-interface bind as-is', () => {
    expect(advertisedPairingOrigin('http://100.72.252.40:5421', undefined)).toBe('http://100.72.252.40:5421');
  });
  it('refuses to guess for loopback and wildcard binds', () => {
    for (const bound of ['http://127.0.0.1:5199', 'http://localhost:5199', 'http://0.0.0.0:5421', 'http://[::]:5421']) {
      expect(() => advertisedPairingOrigin(bound, undefined)).toThrow(/--origin/);
    }
  });
  it('takes an explicit --origin only as a bare origin', () => {
    expect(advertisedPairingOrigin('http://0.0.0.0:5421', 'https://gpu.example.net/')).toBe('https://gpu.example.net');
    expect(() => advertisedPairingOrigin('http://0.0.0.0:5421', 'gpu.example.net')).toThrow();
    expect(() => advertisedPairingOrigin('http://0.0.0.0:5421', 'http://gpu.example.net/studio')).toThrow();
  });
});
