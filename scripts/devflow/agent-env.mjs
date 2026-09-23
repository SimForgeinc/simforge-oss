#!/usr/bin/env node
// `pnpm agent:env <name>`   create (or re-check) an isolated agent env: its own
//                           git worktree + branch, shared deps, its own database
//                           cloned from a template, free ports, a written env
//                           file, seeded QA login, a running dev server and its
//                           own HTTPS tailnet URL. Idempotent; prints the URLs.
// `pnpm agent:env --destroy <name> [--force]`   remove all of it
// `pnpm agent:envs`          list live envs (URL, branch, last commit)
// `pnpm agent:env --gc [--dry-run] [--older-than <days>]`   reclaim disk
//
// Options for create: --base <ref>  --prod-build  --no-start  --no-wait  --reset-db
import { spawn } from "node:child_process";
import { closeSync, readlinkSync, symlinkSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { loadLayout, repoRoot } from "./lib/layout.mjs";
import { allStates, allocatePorts, ensureServe, readState, removeServe, removeState, tailnetHost, writeState } from "./lib/envs.mjs";
import { CACHE_ROOT, matchesAny, runLogged, seconds, sh, trySh, withNodePath } from "./lib/util.mjs";

const USAGE = `Usage:
  agent:env <name> [--base <ref>] [--prod-build] [--no-start] [--no-wait] [--reset-db]
  agent:env --destroy <name> [--force] [--delete-branch]
  agent:env --list            (alias: agent:envs)
  agent:env --gc [--dry-run] [--older-than <days>]
  agent:env --from-branch <branch> [--base <ref>]   (what dev:worktree:init now runs)`;

function parseArgs(argv) {
  const a = { name: null, mode: "create", base: null, prod: false, start: true, wait: true, resetDb: false, force: false, deleteBranch: false, dryRun: false, olderThan: 3 };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--destroy") (a.mode = "destroy"), (a.name = argv[++i]);
    else if (v === "--list") a.mode = "list";
    else if (v === "--gc") a.mode = "gc";
    else if (v === "--base") a.base = argv[++i];
    else if (v === "--prod-build") a.prod = true;
    else if (v === "--no-start") a.start = false;
    else if (v === "--no-wait") a.wait = false;
    else if (v === "--reset-db") a.resetDb = true;
    else if (v === "--force") a.force = true;
    else if (v === "--delete-branch") a.deleteBranch = true;
    else if (v === "--dry-run") a.dryRun = true;
    else if (v === "--older-than") a.olderThan = Number(argv[++i]);
    // Compatibility with the old `dev:worktree:init <branch> [--base b] [--dir d] [--skip-env-pull]`.
    else if (v === "--from-branch") a.fromBranch = true;
    else if (v === "--dir") i += 1;
    else if (v === "--skip-env-pull") {}
    else if (v === "-h" || v === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (!v.startsWith("-") && !a.name) a.name = v;
    else {
      console.error(`agent:env: unknown argument ${v}\n${USAGE}`);
      process.exit(2);
    }
  }
  if (a.fromBranch && a.name) {
    a.branch = a.name;
    a.name = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 41);
  }
  if (a.name && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(a.name)) {
    console.error("agent:env: name must be lowercase letters, digits and dashes (max 41)");
    process.exit(2);
  }
  if ((a.mode === "create" || a.mode === "destroy") && !a.name) {
    console.error(USAGE);
    process.exit(2);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const here = repoRoot();
// The primary checkout owns the worktree list; envs hang off it whichever worktree we run in.
const primary = dirname(resolve(here, sh("git", ["rev-parse", "--git-common-dir"], { cwd: here })));
const layout = await loadLayout(here);
const cfg = layout.env;
if (!cfg && args.mode !== "list") {
  console.error(`agent:env: ${layout.name} has no env section in devflow.config.mjs`);
  process.exit(2);
}
const say = (m) => console.log(m);
const started = Date.now();
const env0 = withNodePath(process.env);

function freeGb(path) {
  const s = statfsSync(path);
  return (s.bavail * s.bsize) / 2 ** 30;
}

function substitute(argv, ctx) {
  return argv.map((a) => a.replace(/\{port(?:\.(\w+))?\}/g, (_, k) => String(k ? ctx.ports[k] : ctx.port)).replace(/\{name\}/g, ctx.name));
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function httpUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual", signal: AbortSignal.timeout(3000) });
    return res.status > 0;
  } catch {
    return false;
  }
}

function lastCommit(dir) {
  return trySh("git", ["log", "-1", "--format=%h %cr %s"], { cwd: dir }) ?? "?";
}

// ---------------------------------------------------------------- list
if (args.mode === "list") {
  const states = allStates().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!states.length) say("no agent envs");
  for (const s of states) {
    const alive = pidAlive(s.pid) && (await httpUp(s.ports[s.webPort]));
    const exists = existsSync(s.worktree);
    say(`${s.name}  [${s.repo}]  ${exists ? (alive ? "UP" : "down") : "MISSING WORKTREE"}`);
    say(`  url     ${s.httpsUrl ?? `http://localhost:${s.ports[s.webPort]}`}${s.httpsUrl ? `  (local http://localhost:${s.ports[s.webPort]})` : ""}`);
    say(`  branch  ${s.branch}  ·  ${exists ? lastCommit(s.worktree) : "-"}`);
    say(`  tree    ${s.worktree}${s.database ? `  ·  db ${s.database}` : ""}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- destroy
async function stopServer(state) {
  if (!pidAlive(state.pid)) return;
  try {
    process.kill(-state.pid, "SIGTERM"); // the server runs in its own process group
  } catch {}
  for (let i = 0; i < 20 && pidAlive(state.pid); i += 1) await new Promise((r) => setTimeout(r, 250));
  if (pidAlive(state.pid)) {
    try {
      process.kill(-state.pid, "SIGKILL");
    } catch {}
  }
}

async function destroy(state, { force, deleteBranch }) {
  if (existsSync(state.worktree) && !force) {
    // Files the dev server itself writes (next-env.d.ts, synced assets) are not work.
    const dirty = (trySh("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: state.worktree }) ?? "")
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter((f) => f && !matchesAny(f, cfg?.ignoreDirty ?? []));
    if (dirty.length) {
      say(`  refusing to destroy ${state.name}: ${state.worktree} has uncommitted changes (commit them, or pass --force)`);
      return false;
    }
  }
  await stopServer(state);
  removeServe(state.tailnetHost, state.httpsPort, state.ports?.[state.webPort]);
  if (state.database) {
    const { dropDatabase } = await import("./lib/pg.mjs");
    try {
      dropDatabase(state.database);
    } catch (e) {
      say(`  warn: could not drop ${state.database}: ${e.message.split("\n")[0]}`);
    }
  }
  if (existsSync(state.worktree)) {
    trySh("git", ["worktree", "remove", "--force", state.worktree], { cwd: primary });
    if (existsSync(state.worktree)) rmSync(state.worktree, { recursive: true, force: true });
    trySh("git", ["worktree", "prune"], { cwd: primary });
  }
  const merged = trySh("git", ["merge-base", "--is-ancestor", state.branch, state.baseSha ?? "HEAD"], { cwd: primary }) !== null;
  if (deleteBranch || merged) trySh("git", ["branch", deleteBranch ? "-D" : "-d", state.branch], { cwd: primary });
  removeState(state.repo, state.name);
  return true;
}

if (args.mode === "destroy") {
  const state = readState(layout.name, args.name);
  if (!state) {
    say(`agent:env: no env named ${args.name} for ${layout.name}`);
    process.exit(1);
  }
  const ok = await destroy(state, args);
  say(ok ? `ENV DESTROYED ${args.name}` : `ENV KEPT ${args.name} (see above)`);
  process.exit(ok ? 0 : 1);
}

// ---------------------------------------------------------------- gc
function duBytes(path) {
  const out = trySh("du", ["-sb", path], { timeout: 120_000 });
  return out ? Number(out.split("\t")[0]) : 0;
}

if (args.mode === "gc") {
  const gb = (b) => `${(b / 2 ** 30).toFixed(1)}G`;
  let freed = 0;
  const act = (what, path) => {
    const size = duBytes(path);
    say(`  ${args.dryRun ? "would remove" : "remove"} ${what}: ${path} (${gb(size)})`);
    if (!args.dryRun) rmSync(path, { recursive: true, force: true });
    freed += size;
  };
  const cutoff = Date.now() - args.olderThan * 86_400_000;
  say(`agent:env --gc ${args.dryRun ? "(dry run) " : ""}· idle threshold ${args.olderThan}d · free ${freeGb(primary).toFixed(0)}G`);
  // Any process (a dev server, a watcher) running inside a tree protects it.
  const busyDirs = new Set();
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      busyDirs.add(readlinkSync(`/proc/${pid}/cwd`));
    } catch {}
  }
  const inUse = (dir) => [...busyDirs].some((d) => d === dir || d.startsWith(`${dir}/`));
  const touched = (dir) =>
    Math.max(
      Number(trySh("git", ["log", "-1", "--format=%ct"], { cwd: dir }) ?? 0) * 1000,
      ...["index", "HEAD"].map((f) => {
        try {
          return statSync(resolve(dir, trySh("git", ["rev-parse", "--git-path", f], { cwd: dir }))).mtimeMs;
        } catch {
          return 0;
        }
      }),
    );
  // Every worktree of this repository (agent envs or not): idle + no process
  // inside -> its rebuildable outputs (target/, .next, ...) go.
  const worktrees = (trySh("git", ["worktree", "list", "--porcelain"], { cwd: primary }) ?? "")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice(9))
    .filter((w) => w !== primary);
  for (const w of worktrees) {
    if (!existsSync(w) || inUse(w) || touched(w) > cutoff) continue;
    for (const rel of cfg.rebuildable ?? []) {
      const p = join(w, rel);
      if (existsSync(p)) act(`idle-tree output`, p);
    }
  }
  for (const s of allStates()) {
    if (!existsSync(s.worktree)) {
      say(`  env ${s.name}: worktree is gone, releasing db/ports/url`);
      if (!args.dryRun) await destroy(s, { force: true, deleteBranch: false });
      continue;
    }
    const lastTouch = Math.max(
      Number(trySh("git", ["log", "-1", "--format=%ct"], { cwd: s.worktree }) ?? 0) * 1000,
      statSync(join(s.worktree)).mtimeMs,
      ...["index", "HEAD"].map((f) => {
        const p = trySh("git", ["rev-parse", "--git-path", f], { cwd: s.worktree });
        try {
          return statSync(resolve(s.worktree, p)).mtimeMs;
        } catch {
          return 0;
        }
      }),
    );
    if (lastTouch > cutoff || pidAlive(s.pid)) continue;
    say(`  env ${s.name}: idle since ${new Date(lastTouch).toISOString().slice(0, 10)}`);
    const layoutOutputs = cfg.rebuildable ?? [];
    for (const rel of layoutOutputs) {
      const p = join(s.worktree, rel);
      if (existsSync(p)) act("build output", p);
    }
  }
  // Machine-wide leftovers: Playwright/Chrome temp profiles older than a day.
  const tmp = process.env.TMPDIR || "/tmp";
  const profiles = [];
  for (const entry of readdirSync(tmp)) {
    if (!/^(playwright[-_]|playwright_chromiumdev_profile-|puppeteer_dev_chrome_profile-|\.org\.chromium\.Chromium\.)/.test(entry)) continue;
    const p = join(tmp, entry);
    try {
      if (statSync(p).mtimeMs < Date.now() - 86_400_000 && !inUse(p)) {
        profiles.push(p);
        const size = duBytes(p);
        freed += size;
        if (!args.dryRun) rmSync(p, { recursive: true, force: true });
      }
    } catch {}
  }
  if (profiles.length) say(`  ${args.dryRun ? "would remove" : "removed"} ${profiles.length} browser profiles older than a day in ${tmp}`);
  // Local turbo cache entries unused for 7 days.
  const turboDir = join(CACHE_ROOT, "turbo");
  if (existsSync(turboDir)) {
    for (const repo of readdirSync(turboDir)) {
      for (const f of readdirSync(join(turboDir, repo))) {
        const p = join(turboDir, repo, f);
        try {
          if (statSync(p).atimeMs < Date.now() - 7 * 86_400_000) {
            freed += statSync(p).size;
            if (!args.dryRun) rmSync(p, { force: true });
          }
        } catch {}
      }
    }
  }
  // Superseded template databases (keep the newest two per layout).
  if (cfg?.database && trySh("docker", ["inspect", "devflow-postgres"]) !== null) {
    const { staleTemplates, dropTemplate } = await import("./lib/pg.mjs");
    for (const t of staleTemplates(layout.name)) {
      say(`  ${args.dryRun ? "would drop" : "drop"} template db ${t}`);
      if (!args.dryRun) dropTemplate(t);
    }
  }
  say(`GC ${args.dryRun ? "WOULD FREE" : "FREED"} ${gb(freed)} · free now ${freeGb(primary).toFixed(0)}G`);
  process.exit(0);
}

// ---------------------------------------------------------------- create / refresh
const minFree = Number(process.env.DEVFLOW_MIN_FREE_GB || cfg.minFreeGb || 20);
const free = freeGb(primary);
const existing = readState(layout.name, args.name);
if (!existing && free < minFree) {
  say(`ENV REFUSED ${args.name}: only ${free.toFixed(1)}G free on ${primary} (< ${minFree}G). Run \`agent:env --gc\` or destroy idle envs (\`agent:envs\`).`);
  process.exit(3);
}

const step = async (label, fn) => {
  const t0 = Date.now();
  const detail = await fn();
  say(`  ${label.padEnd(10)} ${seconds(Date.now() - t0).padEnd(7)} ${detail ?? ""}`);
};

const worktreesDir = resolve(primary, cfg.worktreesDir ?? "../worktrees");
const worktree = existing?.worktree ?? join(worktreesDir, `${cfg.worktreePrefix ?? `${layout.name}-`}${args.name}`);
const branch = existing?.branch ?? args.branch ?? `${cfg.branchPrefix ?? "agent/"}${args.name}`;
const state = existing ?? { repo: layout.name, name: args.name, worktree, branch, createdAt: new Date().toISOString() };
const logDir = join(worktree, ".devflow");
say(`agent:env ${args.name} · ${layout.name} · ${existing ? "refresh" : "create"} · ${worktree}`);

// 1. worktree + branch
await step("worktree", async () => {
  if (existsSync(join(worktree, ".git"))) return "exists";
  const baseRef = args.base ?? (layout.baseRefs.find((r) => trySh("git", ["rev-parse", "--verify", "-q", r], { cwd: primary })) || "HEAD");
  const hasBranch = trySh("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: primary }) !== null;
  mkdirSync(worktreesDir, { recursive: true });
  sh("git", ["worktree", "add", ...(hasBranch ? [worktree, branch] : ["-b", branch, worktree, baseRef])], { cwd: primary });
  state.baseRef = baseRef;
  state.baseSha = trySh("git", ["rev-parse", baseRef], { cwd: primary });
  return `${hasBranch ? "checked out" : "new"} ${branch}${hasBranch ? "" : ` from ${baseRef}`}`;
});
mkdirSync(logDir, { recursive: true });
writeState(state);

// 2. deps
await step("deps", async () => {
  const install = cfg.install;
  if (install.kind === "npm-hardlink") return npmHardlinkInstall(worktree, install);
  const lock = install.lockfile ? join(worktree, install.lockfile) : null;
  const stamp = join(logDir, "deps.stamp");
  const lockHash = lock && existsSync(lock) ? createHash("sha256").update(readFileSync(lock)).digest("hex") : "none";
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === lockHash && existsSync(join(worktree, "node_modules"))) return "up to date";
  const res = await runLogged(install.run[0], install.run.slice(1), { cwd: worktree, env: env0, logFile: join(logDir, "install.log") });
  if (res.code !== 0) throw new Error(`install failed; see ${join(logDir, "install.log")}`);
  writeFileSync(stamp, lockHash);
  return install.run.join(" ");
});

// 2b. prepare: build outputs the server needs, restored from the shared turbo cache when possible
if (cfg.prepare?.length) {
  await step("prepare", async () => {
    const { turboCommand } = await import("./lib/turbo.mjs");
    const done = [];
    for (const [i, p] of cfg.prepare.entries()) {
      const logFile = join(logDir, `prepare-${i}.log`);
      let res;
      if (p.turbo) {
        const t = await turboCommand(layout, worktree, [].concat(p.turbo), p.packages ?? []);
        res = await runLogged(t.bin, t.args, { cwd: worktree, env: { ...env0, ...t.env }, logFile });
        await t.close();
        const cached = readFileSync(logFile, "utf8").match(/Cached:\s+(\d+) cached, (\d+) total/);
        done.push(`${[].concat(p.turbo).join("+")}${cached ? ` (${cached[1]}/${cached[2]} cached)` : ""}`);
      } else {
        res = await runLogged(p.run[0], p.run.slice(1), { cwd: join(worktree, p.cwd ?? "."), env: env0, logFile });
        done.push(p.run.join(" "));
      }
      if (res.code !== 0) throw new Error(`prepare step failed; see ${logFile}`);
    }
    return done.join("; ");
  });
}

// 3. ports
if (!state.ports) {
  const names = cfg.ports ?? ["web"];
  const ports = await allocatePorts(names.length);
  state.ports = Object.fromEntries(names.map((n, i) => [n, ports[i]]));
  state.webPort = names[0];
  state.httpsPort = ports[0] + 1000;
  writeState(state);
}
const port = state.ports[state.webPort];
state.tailnetHost ??= tailnetHost();
const ctx = {
  name: args.name,
  root: worktree,
  ports: state.ports,
  port,
  stateDir: join(CACHE_ROOT, "state", layout.name, args.name),
  tailnetHost: state.tailnetHost,
  httpsUrl: state.tailnetHost ? `https://${state.tailnetHost}:${state.httpsPort}` : null,
  localUrl: `http://localhost:${port}`,
  databaseUrl: null,
};
mkdirSync(ctx.stateDir, { recursive: true });
// Content-addressed state (published map artifacts) is shared by every env of
// this layout instead of copied per env; the database stays per env.
for (const sub of cfg.sharedState ?? []) {
  const shared = join(CACHE_ROOT, "state", layout.name, "_shared", sub);
  mkdirSync(shared, { recursive: true });
  const link = join(ctx.stateDir, sub);
  if (!existsSync(link)) symlinkSync(shared, link);
}

// 3b. layout hook: extra per-env setup that returns extra env vars
if (cfg.setup) Object.assign(ctx, { extraVars: await cfg.setup(ctx) });

// 4. database (template clone)
if (cfg.database) {
  await step("database", async () => {
    const pg = await import("./lib/pg.mjs");
    const pgState = await pg.ensurePostgres({ image: cfg.database.image });
    const hash = pg.inputsHash(worktree, cfg.database.inputs);
    const { template, built } = await pg.ensureTemplate(pgState, {
      layout: layout.name,
      hash,
      logDir,
      build: async (url) => {
        for (const [i, cmd] of [cfg.database.migrate, ...(cfg.database.seed ? [cfg.database.seed] : [])].entries()) {
          const res = await runLogged(cmd.run[0], cmd.run.slice(1), {
            cwd: join(worktree, cmd.cwd ?? "."),
            env: { ...env0, ...(cmd.env ?? {}), DATABASE_URL: url },
            logFile: join(logDir, `db-template-${i}.log`),
          });
          if (res.code !== 0) throw new Error(`template build step failed; see ${res.logFile}`);
        }
      },
    });
    const db = pg.safeDbName("env", `${layout.name}_${args.name}`);
    if (args.resetDb) pg.dropDatabase(db);
    const cloned = pg.cloneDatabase(template, db);
    state.database = db;
    ctx.databaseUrl = pg.urlFor(pgState, db);
    writeState(state);
    return `${db} ${cloned ? "cloned from" : "exists (from"} ${template}${cloned ? "" : ")"}${built ? " · template built" : ""}`;
  });
}

// 5. env file(s)
await step("env", async () => {
  let base = "";
  if (cfg.baseEnv) base = await baseEnvFile(cfg.baseEnv);
  const vars = { ...(cfg.vars ? cfg.vars(ctx) : {}), ...(ctx.extraVars ?? {}) };
  const lines = base.split("\n").filter((l) => {
    const key = l.split("=")[0]?.trim();
    return !(key && key in vars);
  });
  const body = `${lines.join("\n").trim()}\n\n# --- agent:env ${args.name} (generated; rerun agent:env to refresh) ---\n${Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
  for (const rel of cfg.envFiles ?? [".env.local"]) {
    mkdirSync(dirname(join(worktree, rel)), { recursive: true });
    writeFileSync(join(worktree, rel), body, { mode: 0o600 });
  }
  return (cfg.envFiles ?? [".env.local"]).join(", ");
});

// 6. server
let up = false;
if (args.start && cfg.start) {
  await step("server", async () => {
    if (pidAlive(state.pid) && (await httpUp(port))) {
      up = true;
      return `already up (pid ${state.pid})`;
    }
    await stopServer(state);
    const vars = { ...(cfg.vars ? cfg.vars(ctx) : {}), ...(ctx.extraVars ?? {}) };
    const serverEnv = { ...env0, ...vars, PORT: String(port), DEVFLOW_ENV: args.name };
    if (args.prod && cfg.prodBuild) {
      const b = cfg.prodBuild;
      const res = await runLogged(b.run[0], substitute(b.run.slice(1), ctx), { cwd: join(worktree, b.cwd ?? "."), env: serverEnv, logFile: join(logDir, "prod-build.log") });
      if (res.code !== 0) throw new Error(`prod build failed; see ${res.logFile}`);
    }
    const s = args.prod && cfg.prodStart ? cfg.prodStart : cfg.start;
    const out = openSync(join(logDir, "server.log"), "a");
    const child = spawn(s.run[0], substitute(s.run.slice(1), ctx), { cwd: join(worktree, s.cwd ?? "."), env: serverEnv, detached: true, stdio: ["ignore", out, out] });
    child.unref();
    closeSync(out);
    state.pid = child.pid;
    state.mode = args.prod ? "prod" : "dev";
    writeState(state);
    if (!args.wait) return `starting (${state.mode}, pid ${child.pid}) · log ${relative(worktree, join(logDir, "server.log"))}`;
    for (let i = 0; i < 240; i += 1) {
      if (await httpUp(port)) {
        up = true;
        break;
      }
      if (!pidAlive(child.pid)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return up ? `up (${state.mode}, pid ${child.pid})` : `NOT UP yet (pid ${child.pid}) · see ${join(logDir, "server.log")}`;
  });
}

// 7. tailnet HTTPS url
if (state.tailnetHost) {
  await step("https", async () => {
    const r = ensureServe(state.tailnetHost, state.httpsPort, port);
    state.httpsUrl = r.ok ? r.url : null;
    writeState(state);
    return r.ok ? r.url : `skipped: ${r.reason}`;
  });
}

const urls = cfg.urls ? cfg.urls({ ...ctx, httpsUrl: state.httpsUrl }) : {};
say("");
if (state.httpsUrl) say(`  URL       ${state.httpsUrl}`);
say(`  local     ${ctx.localUrl}`);
for (const [k, v] of Object.entries(urls)) if (v !== state.httpsUrl && v !== ctx.localUrl) say(`  ${k.padEnd(9)} ${v}`);
if (cfg.login) {
  const login = cfg.login(ctx);
  say(`  login     ${login.email} / ${login.password}`);
}
say(`  tree      ${worktree}  (branch ${branch})`);
if (ctx.databaseUrl) say(`  database  ${state.database}  (DATABASE_URL in ${(cfg.envFiles ?? [".env.local"])[0]})`);
say(`ENV READY ${args.name} time=${seconds(Date.now() - started)}${up ? "" : args.start && cfg.start ? " server=not-up" : ""} url=${state.httpsUrl ?? ctx.localUrl}`);

// ---------------------------------------------------------------- helpers
async function baseEnvFile(spec) {
  // Pulled environment (e.g. SSM) cached per machine for `ttlHours`, owner-only.
  const dir = join(CACHE_ROOT, "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${spec.cacheKey}.env`);
  const fresh = existsSync(file) && Date.now() - statSync(file).mtimeMs < (spec.ttlHours ?? 12) * 3_600_000;
  if (!fresh) {
    const tmp = `${file}.${process.pid}`;
    const res = await runLogged(spec.pull[0], substitute(spec.pull.slice(1), ctx).map((a) => a.replace("{out}", tmp)), {
      cwd: worktree,
      env: env0,
      logFile: join(logDir, "env-pull.log"),
    });
    if (res.code !== 0 || !existsSync(tmp)) {
      if (existsSync(file)) return readFileSync(file, "utf8"); // stale beats nothing
      throw new Error(`env pull failed; see ${res.logFile}`);
    }
    writeFileSync(file, readFileSync(tmp), { mode: 0o600 });
    rmSync(tmp, { force: true });
  }
  return readFileSync(file, "utf8");
}

// npm has no content-addressed store: keep one pristine copy of every
// node_modules dir per lockfile hash and hardlink it into each new worktree.
async function npmHardlinkInstall(dir, install) {
  const lock = join(dir, "package-lock.json");
  const key = createHash("sha256").update(readFileSync(lock)).digest("hex").slice(0, 16);
  const stamp = join(dir, ".devflow", "deps.stamp");
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === key && existsSync(join(dir, "node_modules"))) return "up to date";
  const cache = join(CACHE_ROOT, "node_modules", layout.name, key);
  const listFile = join(cache, ".dirs");
  if (!existsSync(listFile)) {
    const res = await runLogged("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir, env: env0, logFile: join(dir, ".devflow", "install.log") });
    if (res.code !== 0) throw new Error(`npm ci failed; see ${res.logFile}`);
    const dirs = sh("find", [".", "-name", "node_modules", "-type", "d", "-prune", "-not", "-path", "./.git/*"], { cwd: dir }).split("\n").filter(Boolean);
    const staging = `${cache}.${process.pid}`;
    for (const d of dirs) {
      mkdirSync(dirname(join(staging, d)), { recursive: true });
      sh("cp", ["-al", join(dir, d), join(staging, d)]);
    }
    writeFileSync(join(staging, ".dirs"), dirs.join("\n"));
    mkdirSync(dirname(cache), { recursive: true });
    try {
      sh("mv", ["-T", staging, cache]);
    } catch {
      rmSync(staging, { recursive: true, force: true }); // another env published it first
    }
    writeFileSync(stamp, key);
    for (const cmd of install.after ?? []) await runLogged(cmd[0], cmd.slice(1), { cwd: dir, env: env0, logFile: join(dir, ".devflow", "install-after.log") });
    return `npm ci (seeded shared copy ${key})`;
  }
  for (const d of readFileSync(listFile, "utf8").split("\n").filter(Boolean)) {
    const target = join(dir, d);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    sh("cp", ["-al", join(cache, d), target]);
  }
  writeFileSync(stamp, key);
  for (const cmd of install.after ?? []) await runLogged(cmd[0], cmd.slice(1), { cwd: dir, env: env0, logFile: join(dir, ".devflow", "install-after.log") });
  return `hardlinked node_modules from shared copy ${key}`;
}
