// devflow layout for SimForge OSS. Read by `pnpm verify` and `pnpm agent:env`
// (scripts/devflow/). After the monorepo cutover this file lives at
// `oss/devflow.config.mjs`; the monorepo root config imports it and re-roots
// it with `underDir(config, "oss")`, and the public mirror keeps using it as is.
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Agent envs publish only these maps into their fresh Studio database (seeding
// every installed map takes minutes); DEVFLOW_MAPS=all|a,b,c overrides.
const ENV_MAPS = ["richmond-field-station", "yale-street"];

function mapsFarm(ctx) {
  const source = process.env.SIMFORGE_MAPS_CACHE_ROOT || join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "simforge/maps");
  const wanted = process.env.DEVFLOW_MAPS ?? ENV_MAPS.join(",");
  if (wanted === "all" || !existsSync(source)) return {};
  const maps = new Set(wanted.split(","));
  const farm = join(ctx.stateDir, "maps");
  mkdirSync(farm, { recursive: true });
  for (const top of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, top.name);
    const to = join(farm, top.name);
    if (["dev-assets", "map-bundles", ".corpus"].includes(top.name)) {
      mkdirSync(to, { recursive: true });
      for (const entry of readdirSync(from)) {
        // Keep non-map helpers (e.g. sumo-runtime); filter map directories.
        const isMap = existsSync(join(source, "map-bundles", entry)) || existsSync(join(source, ".corpus", entry));
        if ((!isMap || maps.has(entry)) && !existsSync(join(to, entry))) symlinkSync(join(from, entry), join(to, entry));
      }
    } else if (!existsSync(to)) symlinkSync(from, to);
  }
  return { SIMFORGE_MAPS_CACHE_ROOT: farm };
}

export default {
  name: "simforge-oss",
  // The closest merge base among these is "my change".
  baseRefs: ["origin/main", "main"],
  packageManager: "pnpm",

  turbo: {
    tasks: ["typecheck", "test", "lint"],
    // Tasks red on main today: reported on every run, never gating. Remove an
    // entry once it passes (verify says so). Nightly `verify --full` keeps it honest.
    knownFailures: "devflow.known-failures.json",
    // A change to one of these invalidates every package.
    global: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.base.json", "turbo.json", "patches/**"],
    // Files outside any workspace package that still feed one.
    triggers: [
      { when: ["native/crates/**", "native/Cargo.toml", "native/Cargo.lock"], packages: ["@simforge-oss/native-runtime"] },
      { when: ["fixtures/render-timeline/**", "fixtures/physics/**"], packages: ["@simforge-oss/native-runtime"] },
    ],
  },

  checks: [
    {
      name: "style",
      describe: "StyleX lint on changed Studio files",
      when: ["packages/studio-ui/src/**/*.{ts,tsx}", "studio/app/**/*.{ts,tsx}", "scripts/style/**"],
      // {changed} expands to the changed files matching `when` (dropped under --full).
      run: ["node", "scripts/style/lint.mjs", "{changed}"],
      changedFilter: ["packages/studio-ui/src/**", "studio/app/**"],
    },
    {
      name: "style-ratchet",
      when: ["packages/studio-ui/src/**", "studio/app/**", "scripts/style/**"],
      run: ["node", "scripts/style/ratchet.mjs", "--check"],
    },
    {
      // The OS credential vault must never block the event loop, and a cloud
      // host must never open one (a locked Linux keyring wedged the server).
      name: "studio-cloud-vault",
      when: ["studio/app/lib/cloud/**", "studio/app/api/simforge/cloud/**", "studio/app/lib/host/cloud.tsx"],
      steps: [{ cwd: "studio", run: ["pnpm", "run", "test:cloud-vault"] }],
    },
    {
      // The render-job API's native preset/overrides (422 on an unknown key or
      // invalid value) and the lease screen that keeps them off older workers.
      name: "studio-render-preset",
      when: [
        "studio/app/lib/scenario/render-preset.ts",
        "studio/app/lib/scenario/render-wire-contracts.ts",
        "studio/app/lib/scenario/render-worker-control-store.ts",
        "studio/app/lib/scenario/__tests__/render-preset.test.ts",
        "packages/render/src/worker-control.ts",
        "packages/render/src/native/render-config-keys.ts",
      ],
      steps: [
        // The lease store imports the engine, whose WASM binding is a build artifact
        // (from the shared turbo cache when another tree or CI already built it).
        { turbo: "build:artifacts", packages: ["@simforge-oss/native-runtime"] },
        { cwd: "studio", run: ["pnpm", "run", "test:render-preset"] },
      ],
    },
    { name: "release-scripts", when: ["scripts/release/**"], run: ["node", "--test", "scripts/release/*.test.mjs"] },
    { name: "integration-scripts", when: ["scripts/integration/**"], run: ["node", "--test", "scripts/integration/*.test.mjs"] },
    { name: "devflow", when: ["scripts/devflow/**", "devflow.config.mjs", "turbo.json"], run: ["node", "--test", "scripts/devflow/*.test.mjs"] },
    {
      // CPU-only render conformance: no GPU box needed. The Bevy renderer's
      // contract parity against the viewer fixture (actor matrices + derived
      // lights) and the render-timeline identity corpus through the shared
      // sampler (timeline key, content digest, per-pose f64 bits).
      name: "render-cpu",
      describe: "renderer contract parity + timeline identity (CPU)",
      when: [
        "renderer/render-core/**",
        "renderer/Cargo.lock",
        "packages/viewer/fixtures/renderer-contract/**",
        "packages/render/src/timeline/**",
        "native/crates/simforge-core/src/trace/**",
        "fixtures/render-timeline/**",
      ],
      rust: true,
      heavy: true,
      steps: [
        { cwd: "renderer", run: ["cargo", "nextest", "run", "--no-tests=pass", "-p", "render-core", "--test", "parity_fixture"] },
        { cwd: "native", run: ["cargo", "nextest", "run", "--no-tests=pass", "-p", "simforge-core", "--test", "render_timeline_identity"] },
      ],
    },
  ],

  cargo: [
    // Engine: fmt + nextest over affected crates. The wasm32 and napi builds of
    // the bindings are the turbo task @simforge-oss/native-runtime#build:artifacts
    // (triggered by any native/ change), so they come from the shared turbo cache
    // when another worktree or CI already built the same sources.
    { name: "native", dir: "native", mode: "test", exclude: ["simforge-bindings-python"] },
    // Bevy renderer: type-check only in the inner loop (its CPU conformance
    // tests run in the render-cpu check); full tests run under --full.
    { name: "renderer", dir: "renderer", mode: "check", fullMode: "check" },
  ],

  // Golden-trace verify: only when engine inputs changed. The physics
  // golden-maneuver bands and the committed render-timeline corpus replayed
  // through the native engine (Rust) and the WASM binding (TS).
  golden: {
    name: "golden",
    describe: "physics goldens + render-timeline identity (Rust + WASM)",
    when: [
      "native/crates/simforge-core/**",
      "native/crates/simforge-compiler/**",
      "native/crates/simforge-bindings-*/**",
      "native/Cargo.lock",
      "fixtures/physics/**",
      "fixtures/render-timeline/**",
      "packages/engine/src/**",
    ],
    rust: true,
    heavy: true,
    steps: [
      { cwd: "native", run: ["cargo", "nextest", "run", "--no-tests=pass", "-p", "simforge-core", "-E", "test(golden) | binary(render_timeline_identity)"] },
      { turbo: "test:golden", packages: ["@simforge-oss/native-runtime"] },
    ],
  },

  // `verify --full` only (merge queue / nightly).
  full: [
    { name: "e2e", run: ["pnpm", "exec", "playwright", "test", "-c", "e2e/playwright.config.ts", "--project=smoke"] },
    { name: "gpu-golden", heavy: true, run: ["node", "qualification/golden-harness/golden.mjs", "verify", "all"] },
  ],

  // Remote cache: Depot Cache when a Depot token is available (CI and dev
  // boxes; see scripts/devflow/lib/remote-cache.mjs), else this S3 bucket in
  // the AWS dev account, else machine-local caches only.
  remoteCache: { bucket: "simforge-devflow-cache-dev", region: "us-east-1", prefix: "turbo/simforge-oss/", profile: process.env.AWS_PROFILE || "simforge" },

  env: {
    worktreesDir: "../worktrees",
    worktreePrefix: "oss-agent-",
    branchPrefix: "agent/",
    // pnpm hardlinks from its content-addressed store: seconds, no copies.
    install: { run: ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"], lockfile: "pnpm-lock.yaml" },
    ports: ["studio"],
    envFiles: [".env.local", "studio/.env.local"],
    // The dev server resolves workspace packages from source; only the Rust
    // artifacts (napi addon + wasm) must exist, and they come from the turbo cache.
    prepare: [{ turbo: "build:artifacts", packages: ["@simforge-oss/native-runtime"] }],
    vars: (ctx) => ({
      PORT: String(ctx.ports.studio),
      NODE_OPTIONS: "--conditions=development",
      // OSS Studio keeps its PGlite database and artifacts here: one per env.
      SIMFORGE_CLOUD_ROOT: ctx.stateDir,
      ...(ctx.httpsUrl ? { NEXT_PUBLIC_BASE_URL: ctx.httpsUrl, SIMFORGE_ALLOWED_DEV_ORIGINS: `localhost,127.0.0.1,${ctx.tailnetHost}` } : {}),
    }),
    setup: mapsFarm,
    // OSS Studio authorizes browsers only through a loopback bootstrap (its
    // security model); the tailnet URL is for the hosted build (SimCloud envs).
    login: (ctx) => ({
      hint: `loopback bootstrap: SIMFORGE_CLOUD_ROOT=${ctx.stateDir} node packages/cli/bin/simforge.js host open`,
    }),
    urls: (ctx) => ({ studio: ctx.httpsUrl ?? ctx.localUrl }),
    start: { cwd: "studio", run: ["pnpm", "dev"] },
    prodBuild: { cwd: "studio", run: ["pnpm", "build"] },
    prodStart: { cwd: "studio", run: ["pnpm", "exec", "next", "start", "-p", "{port}"] },
    // Published map artifacts are content-addressed: one copy for all envs.
    sharedState: ["artifacts"],
    // Written by the dev server; `--destroy` does not count them as uncommitted work.
    ignoreDirty: ["studio/next-env.d.ts", "studio/AGENTS.md", "studio/CLAUDE.md", "studio/public/app-switcher/**"],
    // Rebuildable outputs `agent:env --gc` may delete from idle envs.
    rebuildable: ["native/target", "renderer/target", "studio/.next", ".turbo", "test-results", "playwright-report"],
  },
};
