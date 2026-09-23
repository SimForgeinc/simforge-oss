// Affected-crate selection for one Cargo workspace: the crates that own a
// changed file, plus every workspace crate that depends on them (transitively).
import { dirname, join, relative, sep } from "node:path";
import { sh } from "./util.mjs";

export function workspaceCrates(root, wsDir) {
  const meta = JSON.parse(
    sh("cargo", ["metadata", "--no-deps", "--format-version", "1", "--offline"], {
      cwd: join(root, wsDir),
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
  const crates = meta.packages.map((pkg) => ({
    name: pkg.name,
    dir: relative(root, dirname(pkg.manifest_path)).split(sep).join("/"),
    pathDeps: pkg.dependencies.filter((dep) => dep.path).map((dep) => relative(root, dep.path).split(sep).join("/")),
    targets: pkg.targets.map((t) => t.kind).flat(),
  }));
  return crates;
}

/**
 * @returns {{all: boolean, crates: string[]}} crates to build/test. `all` when a
 * workspace-level file (Cargo.toml, Cargo.lock, .cargo/, toolchain) changed.
 */
export function affectedCrates(crates, wsDir, changed) {
  const inWs = changed.filter((file) => file.startsWith(`${wsDir}/`));
  const byDir = [...crates].sort((a, b) => b.dir.length - a.dir.length);
  const owners = new Set();
  let all = false;
  for (const file of inWs) {
    const owner = byDir.find((crate) => file === crate.dir || file.startsWith(`${crate.dir}/`));
    if (owner) owners.add(owner.name);
    else if (!/\.(md|txt)$/.test(file)) all = true; // workspace manifest, lockfile, config, vendored patch
  }
  if (all) return { all: true, crates: crates.map((c) => c.name) };
  const dirToName = new Map(crates.map((c) => [c.dir, c.name]));
  const dependents = new Map(crates.map((c) => [c.name, new Set()]));
  for (const crate of crates) {
    for (const depDir of crate.pathDeps) {
      const dep = dirToName.get(depDir);
      if (dep) dependents.get(dep).add(crate.name);
    }
  }
  const out = new Set(owners);
  const queue = [...owners];
  while (queue.length) {
    for (const next of dependents.get(queue.pop()) ?? []) {
      if (!out.has(next)) {
        out.add(next);
        queue.push(next);
      }
    }
  }
  return { all: false, crates: [...out].sort() };
}
