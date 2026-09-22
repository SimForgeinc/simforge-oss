import { readFile } from 'node:fs/promises';

import { z } from 'zod';

const ModuleOptionsSchema = z.record(z.string(), z.unknown());
const ModuleSpecifierSchema = z.string().min(1).max(2048);

const HttpControlConfigSchema = z.strictObject({
  kind: z.literal('http'),
  baseUrl: z.url(),
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  headers: z.record(z.string().min(1), z.string()).default({}),
  requestTimeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
});
const ModuleControlConfigSchema = z.strictObject({
  kind: z.literal('module'),
  module: ModuleSpecifierSchema,
  options: ModuleOptionsSchema.default({}),
});

export const RenderWorkerConfigSchema = z.strictObject({
  workerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  instanceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  engine: z.union([
    z.strictObject({
      id: z.enum(['browser', 'carla', 'native']),
      options: ModuleOptionsSchema.default({}),
    }),
    z.strictObject({
      module: ModuleSpecifierSchema,
      options: ModuleOptionsSchema.default({}),
    }),
  ]),
  control: z.discriminatedUnion('kind', [HttpControlConfigSchema, ModuleControlConfigSchema]),
  labels: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/), z.string().max(256)).default({}),
  scratchDir: z.string().min(1),
  cacheDir: z.string().min(1),
  gpuLockPath: z.string().min(1),
  /** Parallel artifact hash+reserve+upload lanes per completed job. */
  uploadConcurrency: z.number().int().min(1).max(8).default(3),
  pollIntervalMs: z.number().int().min(100).max(300_000).default(5_000),
  retries: z.strictObject({
    maxAttempts: z.number().int().min(1).max(20).default(4),
    initialDelayMs: z.number().int().min(10).max(60_000).default(500),
    maxDelayMs: z.number().int().min(10).max(300_000).default(10_000),
  }).prefault({}),
  /**
   * The persistent content-addressed input cache under `cacheDir` and its
   * background prewarm. Env overrides (for launchers that cannot edit the
   * JSON): SIMFORGE_INPUT_DOWNLOAD_CONCURRENCY, SIMFORGE_CACHE_BUDGET_BYTES,
   * SIMFORGE_PREWARM=0|1.
   */
  cache: z.strictObject({
    /** Upper bound for cached blob bytes (LRU eviction beyond it). */
    budgetBytes: z.number().int().min(0).default(96 * 1024 ** 3),
    /** Never fill the disk past this much free space. */
    minFreeBytes: z.number().int().min(0).default(20 * 1024 ** 3),
    jobConcurrency: z.number().int().min(1).max(128).optional(),
    prewarm: z.strictObject({
      enabled: z.boolean().default(true),
      /** Full re-plan (every published set's presence) interval. */
      intervalMs: z.number().int().min(10_000).max(86_400_000).default(600_000),
      /** Cheap manifest-generation check interval. */
      pollMs: z.number().int().min(5_000).max(3_600_000).default(120_000),
      idleConcurrency: z.number().int().min(1).max(128).default(16),
      busyConcurrency: z.number().int().min(0).max(32).default(2),
      busyBytesPerSecond: z.number().int().min(0).default(4 * 1024 * 1024),
    }).prefault({}),
    /** Blobs no published set wants are deleted once unused this long. */
    unwantedGraceMs: z.number().int().min(0).default(7 * 86_400_000),
  }).prefault({}),
  /** Job workspaces: deleted right after success; failed ones kept this long for debugging. */
  workspaceRetentionMs: z.number().int().min(0).default(3 * 86_400_000),
  health: z.strictObject({
    host: z.string().min(1).default('0.0.0.0'),
    port: z.number().int().min(1).max(65535).default(8080),
  }).prefault({}),
});

export type RenderWorkerConfig = z.infer<typeof RenderWorkerConfigSchema>;

export async function loadRenderWorkerConfig(path: string): Promise<RenderWorkerConfig> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  return RenderWorkerConfigSchema.parse(raw);
}
