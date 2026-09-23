/**
 * The optional external host attached to this Studio build.
 *
 * Studio builds as the local desktop host by default. A deployment that serves
 * Studio as something else (a hosted service with its own sign-in, storage and
 * pages) attaches a host directory by setting `SIMFORGE_STUDIO_HOST` to it.
 * Nothing is copied into this tree and nothing generated is committed. The
 * host plugs in through four seams, all declared here:
 *
 * 1. Module slots. `host-slots.json` lists the modules a host may replace.
 *    Slots are imported as `@/app/...` only, and the host's tsconfig resolves
 *    `@/*` to the host directory first and this directory second, so webpack,
 *    `tsc` and `tsx` all pick the host's module when it provides one.
 * 2. Route mounts. The hosted build's project directory is
 *    `<host>/.studio/root`, which links this app's files and adds the host's
 *    route trees as the route groups `app/(host)` and `app/dashboard/(host)`
 *    (pages without new URL segments, sharing the dashboard layout). This
 *    tree is never modified, so local and hosted builds can run side by side.
 * 3. Public assets are linked in as `public/_host`.
 * 4. A Next config hook (`nextConfig` in the descriptor) receives this app's
 *    config and returns the hosted one.
 *
 * The descriptor is `<host>/studio-host.json`:
 * `{ "schema": "simforge.studio-host/v1", "name", "app": "app",
 *    "routes": { "root": "app", "dashboard": "dashboard" },
 *    "public": "public", "nextConfig": "studio-host.mjs", "distDir": ".next" }`
 *
 * `distDir` is the host's own (default `<host>/.next`), so a deployment rooted
 * at the host directory finds the build where it expects it.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const studioDir = dirname(fileURLToPath(import.meta.url));
export const HOST_ENV = "SIMFORGE_STUDIO_HOST";
export const HOST_SCHEMA = "simforge.studio-host/v1";

/** Where a host may mount a route tree (route groups in the hosted project). */
export const ROUTE_MOUNTS = {
  root: "app/(host)",
  dashboard: "app/dashboard/(host)",
};

/** Slots a host may replace; everything else it ships must be new. */
export function readHostSlots() {
  const manifest = JSON.parse(readFileSync(join(studioDir, "host-slots.json"), "utf8"));
  return manifest.slots;
}

/** The attached host, or null for the default (local) build. */
export function loadStudioHost(env = process.env) {
  const raw = env[HOST_ENV]?.trim();
  if (!raw) return null;
  const dir = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  const descriptorPath = join(dir, "studio-host.json");
  if (!existsSync(descriptorPath)) throw new Error(`${HOST_ENV}=${raw}: no studio-host.json in ${dir}`);
  const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
  if (descriptor.schema !== HOST_SCHEMA) throw new Error(`${descriptorPath}: expected schema ${HOST_SCHEMA}`);
  const at = (path) => (path ? join(dir, path) : null);
  const routes = {};
  for (const [mount, path] of Object.entries(descriptor.routes ?? {})) {
    if (!(mount in ROUTE_MOUNTS)) throw new Error(`${descriptorPath}: unknown route mount "${mount}"`);
    routes[mount] = at(path);
  }
  return {
    dir,
    name: descriptor.name ?? "host",
    appDir: at(descriptor.app ?? "app"),
    routes,
    publicDir: at(descriptor.public),
    nextConfig: at(descriptor.nextConfig),
    // Relative to the host directory in the descriptor; Next wants it relative to this app.
    distDir: relative(join(dir, ".studio", "root"), join(dir, descriptor.distDir ?? ".next")),
    tsconfig: join(dir, ".studio", "tsconfig.json"),
    // This app's files a host build does not typecheck (paths relative to this app).
    typecheckExclude: descriptor.typecheckExclude ?? [],
  };
}

const ROOT_SKIP = new Set(["node_modules", "test-results", "tsconfig.tsbuildinfo", "next-env.d.ts", "next.config.compiled.js"]);

/** The Next project directory of a hosted build: see linkStudioHost. */
export function hostRootDir(host) {
  return join(host.dir, ".studio", "root");
}

/**
 * Make `target` a directory whose entries link to `source`'s, plus `extra`
 * (name -> path). Stale links go; real files in `target` are never touched.
 */
function syncLinks(target, source, { skip = [], extra = {} } = {}) {
  mkdirSync(target, { recursive: true });
  const wanted = new Map();
  for (const entry of readdirSync(source)) {
    if (skip.includes(entry) || entry.startsWith(".next") || ROOT_SKIP.has(entry)) continue;
    wanted.set(entry, join(source, entry));
  }
  for (const [name, path] of Object.entries(extra)) if (path) wanted.set(name, path);
  for (const entry of readdirSync(target)) {
    const path = join(target, entry);
    if (!lstatSync(path).isSymbolicLink()) continue;
    const want = wanted.get(entry);
    if (!want || readlinkSync(path) !== relative(target, want)) unlinkSync(path);
  }
  for (const [name, path] of wanted) {
    const link = join(target, name);
    if (!existsSync(link) && existsSync(path)) symlinkSync(relative(target, path), link);
  }
}

/**
 * Assemble the hosted build's project directory without touching this one:
 * `<host>/.studio/root` links every entry of this app, with the host's route
 * trees added as the route groups `app/(host)` and `app/dashboard/(host)`
 * (so its dashboard pages share the dashboard layout) and its public assets
 * as `public/_host`. The local build and a hosted build can therefore run in
 * the same checkout at the same time. Idempotent and cheap: run by
 * next.config.ts, by the host's scripts, and by its dev watcher when an
 * entry is added here.
 */
export function linkStudioHost(host) {
  // Mounts written into this tree by earlier versions are removed.
  for (const legacy of ["app/(host)", "app/dashboard/(host)", "public/_host"]) {
    const path = join(studioDir, legacy);
    try {
      if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
    } catch {
      // absent
    }
  }
  if (!host) return;
  const root = hostRootDir(host);
  syncLinks(root, studioDir, { skip: ["app", "public"], extra: { node_modules: join(studioDir, "node_modules") } });
  syncLinks(join(root, "app"), join(studioDir, "app"), { skip: ["dashboard"], extra: { "(host)": host.routes.root } });
  syncLinks(join(root, "app", "dashboard"), join(studioDir, "app", "dashboard"), { extra: { "(host)": host.routes.dashboard } });
  syncLinks(join(root, "public"), join(studioDir, "public"), { extra: { _host: host.publicDir } });
  writeHostTsconfig(host);
}

/**
 * The host's tsconfig: this app's, with every path rebased and `@/*` resolving
 * to the host first. Generated rather than committed so a path added here
 * never has to be copied into the host.
 */
export function writeHostTsconfig(host) {
  const own = JSON.parse(readFileSync(join(studioDir, "tsconfig.json"), "utf8"));
  const outDir = dirname(host.tsconfig);
  const rebase = (path) => relative(outDir, resolve(studioDir, path)) || ".";
  const paths = {};
  for (const [key, targets] of Object.entries(own.compilerOptions?.paths ?? {})) {
    paths[key] = targets.map(rebase);
  }
  paths["@/*"] = [`${relative(outDir, host.dir)}/*`, ...paths["@/*"]];
  // Host dashboard pages live in <host>/dashboard (mounted at app/dashboard/(host)).
  paths["@/app/dashboard/*"] = [`${relative(outDir, host.dir)}/dashboard/*`, `${relative(outDir, host.dir)}/app/dashboard/*`, `${rebase("app/dashboard")}/*`];
  const hostRel = relative(outDir, host.dir);
  const config = {
    "//": `Generated by ${relative(host.dir, join(studioDir, "host.config.mjs"))}; do not edit.`,
    extends: rebase("tsconfig.json"),
    compilerOptions: { paths },
    include: [
      ...own.include.filter((pattern) => !pattern.startsWith(".next")).map((pattern) => `${rebase(".")}/${pattern}`),
      `${relative(outDir, resolve(hostRootDir(host), host.distDir))}/types/**/*.ts`,
      // Side-by-side builds (NEXT_DIST_DIR, e.g. a production loop) under the host.
      `${relative(outDir, host.dir)}/.next*/types/**/*.ts`,
      `${relative(outDir, host.dir)}/.next*/dev/types/**/*.ts`,
      `${hostRel}/**/*.ts`,
      `${hostRel}/**/*.tsx`,
    ],
    exclude: [
      ...own.exclude.map((pattern) => `${rebase(".")}/${pattern}`),
      `${hostRel}/node_modules`,
      `${hostRel}/.studio`,
      `${hostRel}/**/__tests__/**`,
      `${hostRel}/**/*.test.ts`,
      `${hostRel}/**/*.test.tsx`,
      ...(host.typecheckExclude ?? []).map((pattern) => `${rebase(".")}/${pattern}`),
      // The hosted project directory only links files already included.
      `${hostRel}/.studio/root`,
      // This app's modules the host replaces (slots) are never part of the
      // hosted build; they are typechecked by the local build instead.
      ...readHostSlots().filter((slot) => existsSync(join(host.dir, slot))).map((slot) => rebase(slot)),
    ],
  };
  mkdirSync(outDir, { recursive: true });
  const text = `${JSON.stringify(config, null, 2)}\n`;
  if (!existsSync(host.tsconfig) || readFileSync(host.tsconfig, "utf8") !== text) writeFileSync(host.tsconfig, text);
}

/** The host's source trees that StyleX and Tailwind must compile and scan. */
export function hostStyleRoots(host) {
  if (!host) return [];
  return [...new Set([host.appDir, ...Object.values(host.routes)].filter(Boolean))];
}
