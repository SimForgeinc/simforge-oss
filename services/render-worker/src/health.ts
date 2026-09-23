import { createServer, type Server } from 'node:http';

export type WorkerHealthState = 'starting' | 'ready' | 'busy' | 'draining' | 'stopped';

export interface WorkerHealth {
  set(state: WorkerHealthState, detail?: string): void;
  /** Extra read-only status (cache/prewarm readiness) served beside the state. */
  setStatus?(key: string, value: unknown): void;
  close(): Promise<void>;
}

export async function startWorkerHealthServer(host: string, port: number): Promise<WorkerHealth> {
  let state: WorkerHealthState = 'starting';
  let detail: string | undefined;
  const extra: Record<string, unknown> = {};
  const server: Server = createServer((request, response) => {
    if (request.url !== '/health' && request.url !== '/ready') {
      response.writeHead(404).end();
      return;
    }
    const healthy = state === 'ready' || state === 'busy' || (request.url === '/health' && state === 'draining');
    response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ state, ...(detail ? { detail } : {}), ...extra }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    set(nextState, nextDetail) {
      state = nextState;
      detail = nextDetail;
    },
    setStatus(key, value) {
      extra[key] = value;
    },
    close() {
      state = 'stopped';
      return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
