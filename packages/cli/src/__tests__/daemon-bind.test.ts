import { describe, expect, it } from 'vitest';
import { workerBaseUrl } from '../commands/daemon.js';

/**
 * A daemon bound to one interface answers on that interface only. The worker
 * runs on the host's own machine but still has to call the server over an
 * address the server actually accepted, and `127.0.0.1` is not that address
 * unless the bind was a wildcard. Getting this wrong costs a host whose
 * server is up and whose workers never claim a job.
 */
describe('the worker calls the host on an address the host is listening on', () => {
  it('uses loopback only for a wildcard bind, where loopback is genuinely served', () => {
    expect(workerBaseUrl('0.0.0.0', 5421)).toBe('http://127.0.0.1:5421');
    expect(workerBaseUrl('::', 5421)).toBe('http://127.0.0.1:5421');
  });

  it('uses the bound address itself for a single-interface bind', () => {
    // The regression: a tailnet-bound host does not serve 127.0.0.1, so a
    // worker pointed at loopback logs `claim.retry: fetch failed` forever
    // while the server looks healthy.
    expect(workerBaseUrl('100.64.0.10', 5421)).toBe('http://100.64.0.10:5421');
  });

  it('keeps loopback working when loopback is what was asked for', () => {
    expect(workerBaseUrl('127.0.0.1', 5199)).toBe('http://127.0.0.1:5199');
  });
});
