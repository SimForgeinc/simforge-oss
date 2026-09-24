import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RenderIntentV1 } from '@simforge-oss/scenario';

import { carlaSimulatorOptions, loadBuiltinRenderEngine } from './builtin-engines.js';
import { CarlaSimulator, CarlaSimulatorError } from './carla-simulator.js';
import type { RenderProgressRecord } from './progress.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A stand-in UE server: listens on the port after `delayMs`, like CARLA's cold start. */
async function fakeServer(options: { delayMs?: number; exitCode?: number } = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'carla-sim-'));
  const script = join(directory, 'CarlaUnreal.sh');
  const body = options.exitCode !== undefined
    ? `echo 'Signal 11 caught.'; exit ${options.exitCode}`
    : `exec node -e "const port = Number(process.argv[1].split('=')[1]); setTimeout(() => require('node:net').createServer((s) => s.end()).listen(port, '127.0.0.1'), ${options.delayMs ?? 0})" -- "$1"`;
  await writeFile(script, `#!/bin/sh\n${body}\n`);
  await chmod(script, 0o755);
  return script;
}

const simulators: CarlaSimulator[] = [];
afterEach(async () => {
  await Promise.all(simulators.splice(0).map((simulator) => simulator.stop('test cleanup')));
});

function simulator(command: string, port: number, overrides: Partial<ConstructorParameters<typeof CarlaSimulator>[0]> = {}): CarlaSimulator {
  const created = new CarlaSimulator({
    command, args: [`-carla-rpc-port=${port}`], host: '127.0.0.1', port,
    readyTimeoutMs: 10_000, idleStopMs: 60_000, handshake: null, stopGraceMs: 2_000, log: () => undefined,
    ...overrides,
  });
  simulators.push(created);
  return created;
}

describe('the on-demand CARLA server', () => {
  it('is not running until a job asks for it, cold-starts once and is reused while warm', async () => {
    const port = await freePort();
    const server = simulator(await fakeServer({ delayMs: 300 }), port);
    expect(server.residency()).toBeNull();
    const first = await server.ensureRunning(new AbortController().signal);
    expect(first.cold).toBe(true);
    expect(first.cold && first.coldStartMs).toBeGreaterThanOrEqual(300);
    expect(server.residency()).not.toBeNull();
    const second = await server.ensureRunning(new AbortController().signal);
    expect(second).toEqual({ cold: false, residentSince: first.residentSince });
  });

  it('stops after its idle timeout and starts cold again for the next job', async () => {
    const port = await freePort();
    const server = simulator(await fakeServer(), port, { idleStopMs: 200 });
    await server.ensureRunning(new AbortController().signal);
    server.markIdle();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(server.residency()).toBeNull();
    expect((await server.ensureRunning(new AbortController().signal)).cold).toBe(true);
  });

  it('a job arriving before the idle timeout keeps the server', async () => {
    const port = await freePort();
    const server = simulator(await fakeServer(), port, { idleStopMs: 500 });
    await server.ensureRunning(new AbortController().signal);
    server.markIdle();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await server.ensureRunning(new AbortController().signal)).cold).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(server.residency()).not.toBeNull();
  });

  it('fails loudly with carla_simulator_start_timeout and leaves nothing running', async () => {
    const port = await freePort();
    const server = simulator(await fakeServer({ delayMs: 60_000 }), port, { readyTimeoutMs: 1_500 });
    const error = await server.ensureRunning(new AbortController().signal).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CarlaSimulatorError);
    expect((error as CarlaSimulatorError).code).toBe('carla_simulator_start_timeout');
    expect((error as CarlaSimulatorError).retryable).toBe(true);
    expect(server.residency()).toBeNull();
  });

  it('names a server that died during its cold start, with its output', async () => {
    const port = await freePort();
    const server = simulator(await fakeServer({ exitCode: 139 }), port);
    const error = await server.ensureRunning(new AbortController().signal).catch((caught: unknown) => caught) as CarlaSimulatorError;
    expect(error.code).toBe('carla_simulator_exited');
    expect(error.message).toContain('code 139');
    expect(error.message).toContain('Signal 11 caught.');
  });

  it('refuses to adopt a listener it did not start', async () => {
    const foreign = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
    const { port } = foreign.address() as AddressInfo;
    try {
      const server = simulator(await fakeServer(), port);
      const error = await server.ensureRunning(new AbortController().signal).catch((caught: unknown) => caught) as CarlaSimulatorError;
      expect(error.code).toBe('carla_simulator_port_occupied');
      expect(error.retryable).toBe(false);
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
  });
});

describe('the CARLA engine with an on-demand server', () => {
  const INTENT = { schema: 'simforge.render-intent/v1' } as unknown as RenderIntentV1;

  it('records the cold start in the job evidence and never renders without a server', async () => {
    const port = await freePort();
    const directory = await mkdtemp(join(tmpdir(), 'carla-engine-'));
    const binary = join(directory, 'fake-carla-exec');
    await writeFile(binary, '#!/bin/sh\nexit 1\n');
    await chmod(binary, 0o755);
    const engine = await loadBuiltinRenderEngine('carla', {
      binary, engineVersion: 'f'.repeat(40), port,
      simulator: { command: await fakeServer({ delayMs: 100 }), args: [`-carla-rpc-port=${port}`], handshake: null, idleStopMs: 60_000 },
    });
    const records: RenderProgressRecord[] = [];
    const context = {
      jobId: 'usrj_1', attempt: 1, intent: INTENT, intentSha256: '1'.repeat(64),
      executionPackageControlSha256: '2'.repeat(64), schedules: [], inputs: new Map(),
      workspace: join(directory, 'workspace'), signal: new AbortController().signal,
      reportProgress: async (record: RenderProgressRecord) => { records.push(record); },
    };
    try {
      expect(engine.gpuResidency?.()).toBeNull();
      // The fake adapter fails the render; the server start before it is what is under test.
      await engine.execute(context).catch(() => undefined);
      const coldStart = records.find((record) => record.event === 'warning' && record.code === 'carla_simulator_cold_start');
      expect(coldStart && coldStart.event === 'warning' && coldStart.message).toMatch(/cold-started on demand for this job in \d+\.\d s \(coldStartMs=\d+\)/);
      expect(engine.gpuResidency?.()).not.toBeNull();
      records.length = 0;
      await engine.execute(context).catch(() => undefined);
      expect(records.some((record) => record.event === 'warning' && record.code === 'carla_simulator_cold_start')).toBe(false);
      await engine.releaseGpuResidency?.('test');
      expect(engine.gpuResidency?.()).toBeNull();
    } finally {
      await engine.close?.();
    }
  });

  it('rejects a simulator block that would talk to a different port or has unknown fields', () => {
    expect(() => carlaSimulatorOptions({ command: '/x', args: ['-carla-rpc-port=2001'] }, '127.0.0.1', 2000)).toThrow(/does not match the engine port 2000/);
    expect(() => carlaSimulatorOptions({ command: '/x', args: [], idleStop: 5 }, '127.0.0.1', 2000)).toThrow(/Unknown CARLA simulator option/);
    expect(carlaSimulatorOptions({ command: '/x', args: [] }, '127.0.0.1', 2000)).toMatchObject({ readyTimeoutMs: 120_000, idleStopMs: 600_000 });
  });
});
