// One local Postgres container per machine; one database per agent env,
// cloned in about a second from a template database that already holds the
// migrated schema and the seeded QA data. The template is keyed by the hash of
// the migrations and seed inputs, so a new migration builds a new template once
// and every env after that clones it.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_ROOT, runLogged, sh, trySh } from "./util.mjs";

const CONTAINER = process.env.DEVFLOW_PG_CONTAINER || "devflow-postgres";
const STATE = join(CACHE_ROOT, "postgres.json");

function docker(args, opts = {}) {
  return sh("docker", args, { timeout: 120_000, ...opts });
}

export function psql(sql, { db = "postgres" } = {}) {
  return docker(["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql]);
}

/** Starts (or creates) the shared container. Returns { host, port, password }. */
export async function ensurePostgres({ image = "postgres:16" } = {}) {
  mkdirSync(CACHE_ROOT, { recursive: true });
  let state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : null;
  const status = trySh("docker", ["inspect", "-f", "{{.State.Status}}", CONTAINER]);
  if (!status) {
    state = { host: "127.0.0.1", port: Number(process.env.DEVFLOW_PG_PORT || 55432), password: randomBytes(18).toString("base64url"), image };
    writeFileSync(STATE, JSON.stringify(state, null, 2), { mode: 0o600 });
    docker([
      "run", "-d", "--name", CONTAINER, "--restart", "unless-stopped",
      "-p", `${state.host}:${state.port}:5432`,
      "-e", `POSTGRES_PASSWORD=${state.password}`,
      "-v", `${CONTAINER}-data:/var/lib/postgresql/data`,
      "--shm-size", "1g",
      image,
      // Throwaway dev data: trade durability for speed.
      "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off", "-c", "max_connections=400",
    ]);
  } else if (status !== "running") {
    docker(["start", CONTAINER]);
  }
  if (!state) throw new Error(`container ${CONTAINER} exists but ${STATE} is missing; remove the container to recreate it`);
  for (let i = 0; i < 60; i += 1) {
    if (trySh("docker", ["exec", CONTAINER, "pg_isready", "-U", "postgres"]) !== null) return state;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("postgres did not become ready");
}

export const urlFor = (state, db) => `postgres://postgres:${encodeURIComponent(state.password)}@${state.host}:${state.port}/${db}`;

export function dbExists(name) {
  return psql(`SELECT 1 FROM pg_database WHERE datname = '${name}'`) === "1";
}

export function safeDbName(prefix, name) {
  return `${prefix}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`.slice(0, 60);
}

/** Hash of every file under the given paths (relative to root). */
export function inputsHash(root, paths) {
  const hash = createHash("sha256");
  const walk = (rel) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const entry of readdirSync(abs).sort()) walk(join(rel, entry));
    } else {
      hash.update(rel);
      hash.update(readFileSync(abs));
    }
  };
  paths.forEach(walk);
  return hash.digest("hex").slice(0, 12);
}

async function withLock(name, fn) {
  const dir = join(CACHE_ROOT, "locks", name);
  mkdirSync(join(CACHE_ROOT, "locks"), { recursive: true });
  for (let i = 0; ; i += 1) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(process.pid));
      break;
    } catch {
      const pid = Number(trySh("cat", [join(dir, "pid")]) ?? 0);
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {}
      if (pid && !alive) rmSync(dir, { recursive: true, force: true });
      else await new Promise((r) => setTimeout(r, 1000));
      if (i === 900) throw new Error(`timed out waiting for lock ${name}`);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Ensures template `tpl_<layout>_<hash>` exists, building it with
 * `build(databaseUrl)` (migrate + seed) when missing. Returns its name.
 */
export async function ensureTemplate(state, { layout, hash, build, logDir }) {
  const template = `tpl_${layout.replace(/[^a-z0-9]+/g, "_")}_${hash}`;
  if (dbExists(template)) return { template, built: false };
  return withLock(`pg-${template}`, async () => {
    if (dbExists(template)) return { template, built: false };
    const staging = `${template}_build`;
    psql(`DROP DATABASE IF EXISTS "${staging}" WITH (FORCE)`);
    psql(`CREATE DATABASE "${staging}"`);
    await build(urlFor(state, staging), logDir);
    psql(`ALTER DATABASE "${staging}" RENAME TO "${template}"`);
    psql(`ALTER DATABASE "${template}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
    return { template, built: true };
  });
}

export function cloneDatabase(template, db) {
  if (dbExists(db)) return false;
  psql(`CREATE DATABASE "${db}" TEMPLATE "${template}"`);
  return true;
}

export function dropDatabase(db) {
  psql(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
}

/** Old templates of this layout, newest first after the `keep` most recent. */
export function staleTemplates(layout, keep = 2) {
  const prefix = `tpl_${layout.replace(/[^a-z0-9]+/g, "_")}_`;
  const rows = psql(
    `SELECT datname FROM pg_database WHERE datname LIKE '${prefix}%' AND datname NOT LIKE '%_build' ORDER BY (pg_stat_file('base/'||oid||'/PG_VERSION')).modification DESC`,
  )
    .split("\n")
    .filter(Boolean);
  return rows.slice(keep);
}

export function dropTemplate(name) {
  psql(`ALTER DATABASE "${name}" WITH IS_TEMPLATE false`);
  psql(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}

export { runLogged };
