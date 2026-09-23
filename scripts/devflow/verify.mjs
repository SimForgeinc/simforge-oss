#!/usr/bin/env node
// `pnpm verify` — the one local gate. Runs only what the change affects:
//   checks  repo-level steps whose `when` globs match a changed file
//           (style lint on the changed files, CPU-only render conformance, ...)
//   rust    cargo fmt + cargo nextest over affected crates (sccache; target/ stays per worktree)
//   wasm    wasm32 build of the bindings crate when it is affected
//   js      turbo typecheck/test/lint over changed packages and their dependents
//   golden  engine golden-trace verify, only when engine inputs changed
// Caches: turbo outputs and sccache objects are shared by every worktree on the
// machine and, through Depot Cache, with the other agents' boxes and CI.
// `--full` runs everything regardless of the diff and adds the slow suites
// (e2e, GPU goldens): the merge-queue / nightly gate.
//
// Output contract (agents parse it): one line per step,
//   `  PASS|FAIL|SKIP  <step>  <secs>  <detail>`
// failing steps print their log tail, and the LAST line is always
//   `VERIFY PASS|FAIL passed=N failed=N skipped=N time=Ns [failing=a,b] report=<path>`.
// Exit code 0 on PASS, 1 on FAIL, 2 on usage errors.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLayout, repoRoot } from "./lib/layout.mjs";
import { changedFiles, resolveBase } from "./lib/git.mjs";
import { affectedCrates, workspaceCrates } from "./lib/cargo.mjs";
import { ensureTool, toolPathDir } from "./lib/tools.mjs";
import { sccacheRemoteEnv, turboRemoteCache } from "./lib/remote-cache.mjs";
import { acquireSlot, jobsPerSlot, slotCount } from "./lib/slots.mjs";
import { CACHE_ROOT, matchesAny, runLogged, seconds, sh, tail, trySh, withNodePath } from "./lib/util.mjs";

const USAGE = `Usage: verify [--full] [--base <ref>] [--only <steps>] [--no-remote-cache] [--stream] [--plan]
  --full             everything, not just what changed, plus e2e/GPU/golden suites
  --base <ref>       diff against this ref (default: closest of the layout's base refs)
  --only <steps>     comma list of: checks,rust,wasm,js,golden,full (or a check name)
  --no-remote-cache  machine-local caches only
  --stream           stream step output instead of capturing it
  --plan             print what would run and exit (the change-to-test mapping)`;

function parseArgs(argv) {
  const args = { full: false, base: null, only: null, remote: true, stream: false, plan: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--full") args.full = true;
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--only") args.only = new Set(argv[++i].split(","));
    else if (a === "--no-remote-cache") args.remote = false;
    else if (a === "--stream") args.stream = true;
    else if (a === "--plan") args.plan = true;
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`verify: unknown argument ${a}\n${USAGE}`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const root = repoRoot();
const layout = await loadLayout(root);
const runDir = join(root, ".devflow", "verify");
mkdirSync(runDir, { recursive: true });
const started = Date.now();
const results = [];
const baseEnv = withNodePath({
  ...process.env,
  FORCE_COLOR: "0",
  CARGO_TERM_COLOR: "never",
  TURBO_TELEMETRY_DISABLED: "1",
  TURBO_NO_UPDATE_NOTIFIER: "1",
  DO_NOT_TRACK: "1",
});
const want = (step, name = step) => !args.only || args.only.has(step) || args.only.has(name);

function record(name, status, ms, detail = "", log = null) {
  results.push({ name, status, ms, detail, log });
  console.log(`  ${status.toUpperCase().padEnd(4)}  ${name.padEnd(18)} ${seconds(ms).padEnd(7)} ${detail}`);
  if (status === "fail" && log && !args.stream) {
    console.log(tail(log, 60).replace(/^/gm, "      │ "));
    console.log(`      └ full log: ${log}`);
  }
}

// ---------------------------------------------------------------- change -> plan
const base = args.base
  ? { ref: args.base, sha: sh("git", ["merge-base", "HEAD", args.base], { cwd: root }) }
  : resolveBase(root, layout.baseRefs);
const diffFiles = base ? changedFiles(root, base.sha) : null; // the change itself, even under --full
const changed = args.full ? null : diffFiles;
const touches = (globs) => changed === null || changed.some((file) => matchesAny(file, globs));
const changedMatching = (globs) => (changed ?? []).filter((file) => matchesAny(file, globs) && existsSync(join(root, file)));

function turboPackages() {
  const out = sh(join(root, "node_modules/.bin/turbo"), ["ls", "--output=json"], { cwd: root, env: baseEnv, maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(out.slice(out.indexOf("{")));
  return parsed.packages.items
    .map((p) => ({ name: p.name, dir: p.path.replace(/\\/g, "/").replace(/\/$/, "") }))
    .filter((p) => p.dir && p.dir !== ".");
}

function planJs() {
  if (!layout.turbo) return null;
  if (!existsSync(join(root, "node_modules/.bin/turbo"))) return { error: "turbo is not installed; run the package manager install first" };
  if (changed === null) return { filters: [], scope: "all packages" };
  if (changed.some((f) => matchesAny(f, layout.turbo.global ?? []))) return { filters: [], scope: "all packages (a global input changed)" };
  const packages = turboPackages().sort((a, b) => b.dir.length - a.dir.length);
  const selected = new Set();
  for (const file of changed) {
    const owner = packages.find((p) => file.startsWith(`${p.dir}/`));
    if (owner) selected.add(owner.name);
  }
  for (const trigger of layout.turbo.triggers ?? []) {
    if (changed.some((f) => matchesAny(f, trigger.when))) trigger.packages.forEach((p) => selected.add(p));
  }
  if (!selected.size) return { skip: "no workspace package changed" };
  const names = [...selected].sort();
  return { filters: names.map((name) => `--filter=...${name}`), scope: `${names.join(",")} +dependents` };
}

function planCargo(ws) {
  if (changed !== null && !changed.some((f) => f.startsWith(`${ws.dir}/`))) return { skip: `no change under ${ws.dir}/` };
  let crates;
  try {
    crates = workspaceCrates(root, ws.dir);
  } catch (error) {
    return { error: `cargo metadata failed: ${error.message.split("\n")[0]}` };
  }
  const affected = changed === null ? { all: true, crates: crates.map((c) => c.name) } : affectedCrates(crates, ws.dir, changed);
  const selected = affected.crates.filter((c) => !(ws.exclude ?? []).includes(c));
  if (!selected.length) return { skip: "changes are outside every crate" };
  return { crates: selected, scope: affected.all ? `all ${selected.length} crates` : selected.join(",") };
}

const planStarted = Date.now();
const plan = {
  checks: layout.checks.map((c) => ({ check: c, run: touches(c.when ?? ["**"]) })),
  cargo: layout.cargo.map((ws) => ({ ws, ...planCargo(ws) })),
  js: planJs(),
  golden: layout.golden ? touches(layout.golden.when) : false,
};
const planMs = Date.now() - planStarted;

console.log(
  `devflow verify · ${layout.name} · ${args.full ? "full" : "affected"} · base ${base ? `${base.ref}@${base.sha.slice(0, 9)}` : "none (everything)"}` +
    (changed ? ` · ${changed.length} changed file${changed.length === 1 ? "" : "s"}` : "") +
    ` · plan ${seconds(planMs)}`,
);

if (args.plan) {
  for (const { check, run } of plan.checks) console.log(`  ${run ? "RUN " : "skip"}  ${check.name}`);
  for (const c of plan.cargo) console.log(`  ${c.crates ? "RUN " : "skip"}  rust:${c.ws.name}  ${c.scope ?? c.skip ?? c.error}`);
  console.log(`  ${plan.js?.filters ? "RUN " : "skip"}  js  ${plan.js?.scope ?? plan.js?.skip ?? plan.js?.error ?? "no turbo in layout"}`);
  console.log(`  ${plan.golden ? "RUN " : "skip"}  golden`);
  console.log(`PLAN ok time=${seconds(Date.now() - started)}`);
  process.exit(0);
}

// ---------------------------------------------------------------- environments
let rustEnvCache = null;
async function rustEnv() {
  if (rustEnvCache) return rustEnvCache;
  const env = { ...baseEnv, CARGO_INCREMENTAL: "0", CARGO_BUILD_JOBS: String(jobsPerSlot()) };
  env.PATH = `${await toolPathDir()}:${env.PATH}`;
  const sccache = process.env.DEVFLOW_SCCACHE === "0" ? null : await ensureTool("sccache").catch(() => null);
  let remote = { kind: "local" };
  if (sccache) {
    remote = args.remote ? sccacheRemoteEnv(layout) : { kind: "local", env: {} };
    Object.assign(env, {
      RUSTC_WRAPPER: sccache,
      SCCACHE_DIR: process.env.SCCACHE_DIR || join(CACHE_ROOT, "sccache"),
      SCCACHE_CACHE_SIZE: process.env.SCCACHE_CACHE_SIZE || "30G",
      SCCACHE_IDLE_TIMEOUT: "3600",
      // One sccache server per machine; a config change restarts it.
      SCCACHE_SERVER_PORT: process.env.SCCACHE_SERVER_PORT || "4226",
      ...remote.env,
    });
    // The server keeps the config it started with; make sure it matches ours.
    const want = `${remote.kind}`;
    const marker = join(CACHE_ROOT, "sccache-server.mode");
    const have = existsSync(marker) ? readFileSync(marker, "utf8") : "";
    if (have !== want) {
      trySh(sccache, ["--stop-server"], { env, timeout: 30_000 });
      writeFileSync(marker, want);
    }
    trySh(sccache, ["--start-server"], { env, timeout: 30_000 });
  }
  rustEnvCache = { env, sccache, remote: remote.kind };
  return rustEnvCache;
}

async function withSlot(label, heavy, fn) {
  if (!heavy) return fn();
  const release = await acquireSlot(`${layout.name}:${label}`);
  try {
    return await fn();
  } finally {
    release();
  }
}

function turboFlags() {
  return [
    "--continue",
    "--output-logs=errors-only",
    "--summarize",
    `--cache-dir=${join(CACHE_ROOT, "turbo", layout.name)}`,
    `--concurrency=${jobsPerSlot()}`,
    "--env-mode=loose",
    "--ui=stream",
    "--log-order=grouped",
  ];
}

// ---------------------------------------------------------------- command steps (checks, golden, full)
async function runCommandStep(name, step) {
  const t0 = Date.now();
  const env = step.rust ? { ...(await rustEnv()).env, DEVFLOW_SLOT_HELD: "1" } : { ...baseEnv };
  const commands = step.steps ?? [{ cwd: step.cwd, run: step.run }];
  const log = join(runDir, `${name}.log`);
  return withSlot(name, step.heavy, async () => {
    let code = 0;
    for (const [i, cmd] of commands.entries()) {
      let argv = cmd.run;
      let cwd = join(root, cmd.cwd ?? step.cwd ?? ".");
      let stepEnv = { ...env, ...(step.env ?? {}) };
      if (cmd.turbo) {
        // A turbo task: always run from the repo root so artifacts come from the shared cache.
        const remote = await turboRemoteCache(layout, { enabled: args.remote });
        stepEnv = { ...stepEnv, ...remote.env };
        argv = [join(root, "node_modules/.bin/turbo"), "run", cmd.turbo, ...(cmd.packages ?? []).map((p) => `--filter=${p}`), ...turboFlags()];
        cwd = root;
      }
      if (argv.includes("{changed}")) {
        const files = changed === null ? [] : changedMatching(step.changedFilter ?? step.when);
        if (changed !== null && !files.length) continue;
        argv = argv.flatMap((a) => (a === "{changed}" ? files : [a]));
      }
      const [bin, ...rest] = argv;
      const res = await runLogged(bin, rest, {
        cwd,
        env: stepEnv,
        logFile: i === 0 ? log : log.replace(/\.log$/, `-${i}.log`),
        stream: args.stream,
      });
      if (res.code !== 0) {
        record(name, "fail", Date.now() - t0, `exit ${res.code}: ${argv.slice(0, 6).join(" ")}`, res.logFile);
        return;
      }
    }
    record(name, "pass", Date.now() - t0, step.describe ?? "");
  });
}

for (const { check, run } of plan.checks) {
  if (!want("checks", check.name)) continue;
  if (!run) record(check.name, "skip", 0, "no matching change");
  else await runCommandStep(check.name, check);
}

// ---------------------------------------------------------------- rust + wasm
for (const c of plan.cargo) {
  const label = `rust:${c.ws.name}`;
  if (!want("rust") && !want("wasm")) break;
  if (c.skip) {
    record(label, "skip", 0, c.skip);
    continue;
  }
  if (c.error) {
    record(label, "fail", 0, c.error);
    continue;
  }
  const rust = await rustEnv();
  const cwd = join(root, c.ws.dir);
  const pkgArgs = c.crates.flatMap((name) => ["-p", name]);
  await withSlot(label, true, async () => {
    if (want("rust")) {
      const t0 = Date.now();
      const log = join(runDir, `${label.replace(":", "-")}.log`);
      // rustfmt: gate only on files this change touched (main is not fmt-clean everywhere).
      const fmt = await runLogged("cargo", ["fmt", "--check", ...pkgArgs], { cwd, env: rust.env, logFile: log.replace(".log", "-fmt.log") });
      const unformatted = [...readFileSync(fmt.logFile, "utf8").matchAll(/^Diff in (.+?):\d+:/gm)].map((m) => m[1].replace(`${root}/`, ""));
      const mine = [...new Set(unformatted.filter((f) => diffFiles === null || diffFiles.includes(f)))];
      const mode = args.full ? c.ws.fullMode ?? "test" : c.ws.mode ?? "test";
      const cmd = mode === "test" ? ["nextest", "run", "--no-fail-fast", "--no-tests=pass", ...pkgArgs] : ["check", "--tests", ...pkgArgs];
      const res = await runLogged("cargo", cmd, { cwd, env: rust.env, logFile: log, stream: args.stream });
      const summary = mode === "test" ? readFileSync(log, "utf8").match(/Summary \[.*$/m)?.[0]?.replace(/\s+/g, " ").trim() ?? "" : "cargo check --tests";
      const fmtNote = mine.length ? ` · rustfmt needed: ${mine.join(" ")} (run \`cargo fmt\` in ${c.ws.dir}/)` : "";
      record(label, res.code === 0 && !mine.length ? "pass" : "fail", Date.now() - t0, `${c.scope} · ${summary} · sccache ${rust.remote}${fmtNote}`, res.code === 0 ? fmt.logFile : log);
    }
    if (want("wasm")) {
      for (const crate of c.ws.wasm ?? []) {
        if (!c.crates.includes(crate)) {
          record(`wasm:${crate}`, "skip", 0, "crate not affected");
          continue;
        }
        const log = join(runDir, `wasm-${crate}.log`);
        const res = await runLogged("cargo", ["build", "--target", "wasm32-unknown-unknown", "-p", crate], { cwd, env: rust.env, logFile: log, stream: args.stream });
        record(`wasm:${crate}`, res.code === 0 ? "pass" : "fail", res.ms, "cargo build --target wasm32-unknown-unknown", log);
      }
    }
  });
}

// ---------------------------------------------------------------- js (turbo)
/** Turbo tasks already red on the base branch: reported, never gating (see the file for why each is listed). */
function readKnown() {
  if (!layout.turbo?.knownFailures) return {};
  try {
    return JSON.parse(readFileSync(join(root, layout.turbo.knownFailures), "utf8")).tasks ?? {};
  } catch {
    return {};
  }
}

function latestTurboSummary(since) {
  const dir = join(root, ".turbo", "runs");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).mtimeMs >= since);
  if (!files.length) return null;
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return JSON.parse(readFileSync(files[0], "utf8"));
}

if (want("js") && plan.js) {
  const js = plan.js;
  if (js.error) record("js", "fail", 0, js.error);
  else if (js.skip) record("js", "skip", 0, js.skip);
  else {
    const t0 = Date.now();
    // Turbo tasks may build Rust artifacts (napi/wasm), so they get the sccache env too.
    const env = { ...(layout.cargo.length ? (await rustEnv()).env : baseEnv), DEVFLOW_SLOT_HELD: "1" };
    const remote = await turboRemoteCache(layout, { enabled: args.remote });
    Object.assign(env, remote.env);
    const log = join(runDir, "js.log");
    const tasks = layout.turbo.tasks ?? ["typecheck", "test", "lint"];
    await withSlot("js", true, async () => {
      const res = await runLogged(
        join(root, "node_modules/.bin/turbo"),
        [
          "run",
          ...tasks,
          ...js.filters,
          ...turboFlags(),
        ],
        { cwd: root, env, logFile: log, stream: args.stream },
      );
      await remote.close();
      const summary = latestTurboSummary(t0);
      let ok = res.code === 0;
      const known = new Set(Object.keys(readKnown()));
      let detail = js.scope;
      if (summary?.tasks) {
        const real = summary.tasks.filter((t) => t.command && t.command !== "<NONEXISTENT>");
        const allFailed = real.filter((t) => t.execution?.exitCode);
        const knownRed = allFailed.filter((t) => known.has(t.taskId));
        const failed = allFailed.filter((t) => !known.has(t.taskId));
        const healed = real.filter((t) => known.has(t.taskId) && !t.execution?.exitCode);
        const local = real.filter((t) => t.cache?.status === "HIT" && t.cache?.local).length;
        const remoteHits = real.filter((t) => t.cache?.status === "HIT" && !t.cache?.local && t.cache?.remote).length;
        detail = `${js.scope} · ${real.length} tasks: ${local} local-cached, ${remoteHits} remote-cached, ${failed.length} failed · remote ${remote.kind}`;
        if (remote.stats) detail += ` (${remote.stats.hits} hit/${remote.stats.puts} put)`;
        if (failed.length) detail += ` · failed: ${failed.map((t) => t.taskId).join(" ")}`;
        if (knownRed.length) detail += ` · known-red (red on the base too, not gating): ${knownRed.map((t) => t.taskId).join(" ")}`;
        if (healed.length) detail += ` · NOW PASSING, remove from ${layout.turbo.knownFailures}: ${healed.map((t) => t.taskId).join(" ")}`;
        ok = failed.length === 0;
      }
      record("js", ok ? "pass" : "fail", Date.now() - t0, detail, log);
    });
  }
}

// ---------------------------------------------------------------- golden
if (want("golden") && layout.golden) {
  if (!plan.golden) record("golden", "skip", 0, "no engine input changed");
  else await runCommandStep("golden", layout.golden);
}

// ---------------------------------------------------------------- full-only suites
if (args.full && want("full")) {
  for (const step of layout.full) await runCommandStep(step.name, step);
}

// ---------------------------------------------------------------- summary
const failed = results.filter((r) => r.status === "fail");
const passed = results.filter((r) => r.status === "pass");
const skipped = results.filter((r) => r.status === "skip");
const total = Date.now() - started;
const reportFile = join(runDir, "latest.json");
writeFileSync(
  reportFile,
  `${JSON.stringify({ layout: layout.name, full: args.full, base, changed, planMs, slots: slotCount(), results, ok: !failed.length, ms: total, at: new Date().toISOString() }, null, 2)}\n`,
);
console.log(
  `VERIFY ${failed.length ? "FAIL" : "PASS"} passed=${passed.length} failed=${failed.length} skipped=${skipped.length} time=${seconds(total)}` +
    (failed.length ? ` failing=${failed.map((r) => r.name).join(",")}` : "") +
    ` report=${reportFile.replace(`${root}/`, "")}`,
);
process.exit(failed.length ? 1 : 0);
