import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { E2E_ENV, currentMode, envValue, type E2eMode } from "./env";
import { EVIDENCE_DIR } from "./paths";

/**
 * One test's isolated world: its own `SIMFORGE_CLOUD_ROOT` (database,
 * artifacts, `host.json`, native-runtime state) and `SIMFORGE_MAPS_CACHE_ROOT`
 * (map corpus), plus the disposal list every helper registers into. Nothing a
 * test does may reach the developer's real `~/.simforge` or map cache.
 */
export type E2eContext = {
  readonly id: string;
  readonly mode: E2eMode;
  /** `SIMFORGE_CLOUD_ROOT` for this test. */
  readonly dataRoot: string;
  /** `SIMFORGE_MAPS_CACHE_ROOT` for this test, pre-created with the corpus profile directories. */
  readonly mapsCacheRoot: string;
  readonly runsRoot: string;
  /** Where {@link writeEvidence} puts this test's documents. */
  readonly evidenceDir: string;
  /** The environment overlay every child process of this test must inherit. */
  readonly env: Record<string, string>;
  /** Register a teardown step; they run in reverse order on {@link E2eContext.dispose}. */
  register(dispose: () => Promise<void> | void): void;
  dispose(): Promise<void>;
};

export type CreateE2eContextOptions = {
  /** Short label that appears in the run directory name. */
  name?: string;
  mode?: E2eMode;
  /** Extra environment for every child process started with this context. */
  env?: Record<string, string>;
  /** Keep the temporary roots after disposal (also honoured via `SIMFORGE_E2E_KEEP_DATA_ROOT`). */
  keepDataRoot?: boolean;
};

/**
 * The cloud origin every child process of a test inherits, refused outright
 * if it names production. Read-only intent is not enforceable once a bearer
 * token exists, so the origin is the place to stop it.
 */
function nonProductionCloudOrigin(): string {
  const configured = envValue(E2E_ENV.cloudOrigin) ?? envValue(E2E_ENV.stagingOrigin) ?? "https://staging.simforge.ai";
  const { hostname } = new URL(configured);
  if (hostname === "simforge.ai" || hostname === "www.simforge.ai") {
    throw new Error(`Refusing to point an E2E host at production (${configured}); set ${E2E_ENV.cloudOrigin} to dev or staging`);
  }
  return configured;
}

/** The three profile directories an installed map corpus is addressed through. */
export const MAP_CORPUS_PROFILES = ["dev-assets", "map-bundles", ".corpus"] as const;

export async function createE2eContext(options: CreateE2eContextOptions = {}): Promise<E2eContext> {
  const label = (options.name ?? "e2e").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40);
  const base = envValue(E2E_ENV.dataRoot) ?? tmpdir();
  await mkdir(base, { recursive: true });
  const runRoot = await mkdtemp(join(base, `simforge-${label}-`));
  const id = basename(runRoot);
  const dataRoot = join(runRoot, "cloud");
  const mapsCacheRoot = join(runRoot, "maps");
  const runsRoot = join(runRoot, "runs");
  const evidenceDir = join(EVIDENCE_DIR, id);
  await Promise.all([
    mkdir(dataRoot, { recursive: true }),
    mkdir(runsRoot, { recursive: true }),
    mkdir(evidenceDir, { recursive: true }),
    ...MAP_CORPUS_PROFILES.map((profile) => mkdir(join(mapsCacheRoot, profile), { recursive: true })),
  ]);
  /*
   * Clone a seeded data root when one is configured.
   *
   * An empty root has no *installed* map: `/api/simforge/maps/catalog` lists
   * the ten entitled maps, but `/api/simforge/maps` returns `{"maps":[]}`,
   * and installing even the smallest costs a browser closure of ~1.8 GB.
   * Symlinking a corpus into the cache is not enough — installation is
   * recorded in the database, not on disk. So tests that need a real
   * scenario clone a root that already has one, which is also how the
   * project's own headless recipe works. Each test still gets its own copy,
   * so nothing a test does escapes into the seed or into a sibling.
   */
  const seed = envValue(E2E_ENV.seedDataRoot);
  if (seed !== undefined) {
    await cp(seed, dataRoot, { recursive: true });
    // A seed captured while a host was running carries that host's liveness
    // records. Copied forward they make the new supervisor believe another
    // host owns this root, and it exits before serving anything.
    await Promise.all(
      ["host.json", "host.lock", "host-port.json"].map((name) => rm(join(dataRoot, name), { force: true })),
    );
  }
  // A seeded root carries its own map cache, and the installation records in
  // its database refer to it. Pointing the cache elsewhere would leave every
  // installed map registered but unreadable.
  const effectiveMapsCacheRoot = seed === undefined ? mapsCacheRoot : join(dataRoot, "map-cache");

  const keep = options.keepDataRoot ?? envValue(E2E_ENV.keepDataRoot) === "1";
  const disposers: (() => Promise<void> | void)[] = [];
  return {
    id,
    mode: options.mode ?? currentMode(),
    dataRoot,
    mapsCacheRoot: effectiveMapsCacheRoot,
    runsRoot,
    evidenceDir,
    env: {
      /*
       * Pin the SimCloud origin for every host and CLI this suite starts.
       *
       * `connection.ts:33` defines `DEFAULT_CLOUD_ORIGIN = "https://simforge.ai"`
       * and `:194` falls back to it, so a host launched without this variable
       * talks to PRODUCTION. A suite that signs in, publishes datasets and
       * uploads artifacts must never inherit that default: a read today is a
       * write tomorrow when someone copies the recipe. Pinned here rather
       * than at each call site so no future launch can forget it.
       */
      SIMFORGE_CLOUD_ORIGIN: nonProductionCloudOrigin(),
      SIMFORGE_CLOUD_ROOT: dataRoot,
      SIMFORGE_MAPS_CACHE_ROOT: effectiveMapsCacheRoot,
      SIMFORGE_RUNS_ROOT: runsRoot,
      SIMFORGE_NATIVE_RUNTIME_STATE_ROOT: join(dataRoot, "native-runtime"),
      // The corpus falls back to XDG when the explicit variable is dropped by a
      // child; keep that fallback inside the sandbox too.
      XDG_DATA_HOME: join(runRoot, "xdg"),
      ...options.env,
    },
    register(dispose) {
      disposers.push(dispose);
    },
    async dispose() {
      const failures: unknown[] = [];
      while (disposers.length > 0) {
        const dispose = disposers.pop();
        try {
          await dispose?.();
        } catch (error) {
          failures.push(error);
        }
      }
      if (!keep) await rm(runRoot, { recursive: true, force: true });
      if (failures.length > 0) throw failures[0];
    },
  };
}
