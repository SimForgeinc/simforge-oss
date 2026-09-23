// devflow layout for SimForge OSS. Read by `pnpm verify` and `pnpm agent:env`
// (scripts/devflow/). After the monorepo cutover this file lives at
// `oss/devflow.config.mjs`; the monorepo root config imports it and re-roots
// it with `underDir(config, "oss")`, and the public mirror keeps using it as is.
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
    { name: "native-migration", run: ["node", "qualification/native-migration/harness.mjs", "status"] },
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
    urls: (ctx) => ({ studio: ctx.httpsUrl ?? ctx.localUrl }),
    start: { cwd: "studio", run: ["pnpm", "dev"] },
    prodBuild: { cwd: "studio", run: ["pnpm", "build"] },
    prodStart: { cwd: "studio", run: ["pnpm", "exec", "next", "start", "-p", "{port}"] },
    // Rebuildable outputs `agent:env --gc` may delete from idle envs.
    rebuildable: ["native/target", "renderer/target", "studio/.next", ".turbo", "test-results", "playwright-report"],
  },
};
