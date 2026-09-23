import { afterEach } from 'vitest';

/**
 * The identity suites run the engine synchronously (a golden case on WASM is
 * several seconds, tens under load), back to back. Vitest's worker reports
 * progress to the main process over RPC and needs an event-loop turn to read
 * the replies; a long enough run of synchronous cases starves it and the run
 * fails with "Timeout calling onTaskUpdate" although every case passed.
 * Yielding one macrotask after each case keeps the channel serviced.
 */
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
