import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { reserveDependencyScope, tracedDependencySources } from "./stage-dependencies.mjs";

test("traced roots use original workspace resolution rather than copied junction targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "simforge-stage-dependencies-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const traced = join(root, "standalone", "node_modules");
  const studio = join(root, "studio", "node_modules");
  const repository = join(root, "node_modules");
  const keyring = join(studio, "@fixture", "keyring");
  const hoisted = join(repository, "hoisted");
  await Promise.all([
    mkdir(join(traced, "@fixture"), { recursive: true }),
    mkdir(keyring, { recursive: true }),
    mkdir(join(repository, "@fixture", "keyring"), { recursive: true }),
    mkdir(hoisted, { recursive: true }),
  ]);
  await Promise.all([keyring, join(repository, "@fixture", "keyring"), hoisted]
    .map((directory) => writeFile(join(directory, "package.json"), "{}")));
  await symlink(join(root, "missing-keyring"), join(traced, "@fixture", "keyring"), "junction");
  await symlink(join(root, "missing-hoisted"), join(traced, "hoisted"), "junction");
  const sources = new Map(await tracedDependencySources(traced, join(root, "studio", "package.json")));
  assert.equal(sources.get("@fixture/keyring"), await realpath(keyring));
  assert.equal(sources.get("hoisted"), await realpath(hoisted));
});

function installation() {
  const root = resolve("stage-test", "node_modules");
  const placed = new Map();
  const reserved = new Map();
  return {
    root,
    install(name, key, scopes) {
      const index = reserveDependencyScope(name, key, scopes, placed, reserved);
      const location = join(scopes[index], name);
      const fresh = !placed.has(location);
      placed.set(location, key);
      return { location, fresh, scopes: [join(location, "node_modules"), ...scopes.slice(index)] };
    },
    resolve(name, scopes) {
      for (const scope of scopes) {
        const key = placed.get(join(scope, name));
        if (key !== undefined) return key;
      }
      return undefined;
    },
  };
}

test("compatible reservations reuse an ancestor for repeated and nested requests", () => {
  const tree = installation();
  const a = tree.install("a", "a@1", [tree.root]);
  const x = tree.install("x", "x@1", a.scopes);
  const repeated = tree.install("x", "x@1", a.scopes);
  const nestedScopes = [join(a.location, "node_modules", "c", "node_modules"), ...a.scopes];
  const nested = tree.install("x", "x@1", nestedScopes);
  assert.equal(repeated.location, x.location);
  assert.equal(repeated.fresh, false);
  assert.equal(nested.location, x.location);
  assert.equal(nested.fresh, false);
  assert.equal(tree.resolve("x", nestedScopes), "x@1");
});

test("a different nested version cannot shadow a dependency already resolved above it", () => {
  const tree = installation();
  const a = tree.install("a", "a@1", [tree.root]);
  tree.install("c", "c@1", [tree.root]);
  tree.install("x", "x@1", a.scopes);
  const c = tree.install("c", "c@2", a.scopes);
  tree.install("x", "x@2", c.scopes);
  assert.equal(tree.resolve("x", a.scopes), "x@1");
  assert.equal(tree.resolve("x", c.scopes), "x@2");
  assert.throws(() => tree.install("x", "x@2", a.scopes));
  assert.equal(tree.resolve("x", a.scopes), "x@1");
});

test("a dependency cycle reuses an already staged package", () => {
  const tree = installation();
  const a = tree.install("a", "a@1", [tree.root]);
  const b = tree.install("b", "b@1", a.scopes);
  const repeatedA = tree.install("a", "a@1", b.scopes);
  assert.equal(repeatedA.location, a.location);
  assert.equal(repeatedA.fresh, false);
  assert.equal(tree.resolve("b", a.scopes), "b@1");
  assert.equal(tree.resolve("a", b.scopes), "a@1");
});
