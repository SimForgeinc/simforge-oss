import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile as writeFileAsync } from "node:fs/promises";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AtomicEmitPlugin, makeWritesAtomic, withAtomicDevEmit } from "./dev-atomic-emit.mjs";

function outputFs() {
  return {
    writeFile: nodeFs.writeFile,
    rename: nodeFs.rename,
    unlink: nodeFs.unlink,
    stat: nodeFs.stat,
  };
}

test("a reader never sees a partially written chunk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atomic-emit-"));
  try {
    const target = join(dir, "worker.js");
    const before = Buffer.alloc(8 << 20, "a");
    const after = Buffer.alloc(8 << 20, "b");
    await writeFileAsync(target, before);
    const fs = makeWritesAtomic(outputFs());
    let done = false;
    const writes = (async () => {
      for (let round = 0; round < 6; round += 1) {
        await new Promise((resolve, reject) => fs.writeFile(target, round % 2 ? before : after, (error) => (error ? reject(error) : resolve())));
      }
      done = true;
    })();
    let reads = 0;
    while (!done) {
      const seen = await readFile(target);
      reads += 1;
      assert.equal(seen.length, before.length, `read ${reads} saw ${seen.length} bytes`);
      assert.ok(seen.equals(before) || seen.equals(after), `read ${reads} saw a mix`);
    }
    await writes;
    assert.ok(reads > 0);
    assert.deepEqual(await readdir(dir), ["worker.js"], "no temporary file is left behind");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("errors propagate and the temporary file is removed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atomic-emit-"));
  try {
    const fs = makeWritesAtomic(outputFs());
    const missing = join(dir, "no-such-dir", "chunk.js");
    const error = await new Promise((resolve) => fs.writeFile(missing, "x", resolve));
    assert.equal(error?.code, "ENOENT");
    const blocked = join(dir, "occupied");
    nodeFs.mkdirSync(join(blocked, "child"), { recursive: true });
    const renameError = await new Promise((resolve) => fs.writeFile(blocked, "x", resolve));
    assert.ok(renameError, "renaming a file over a non-empty directory fails");
    assert.deepEqual((await readdir(dir)).sort(), ["occupied"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("wrapping is idempotent and optional arguments pass through", async () => {
  const calls = [];
  const fs = {
    writeFile: (file, data, ...rest) => { calls.push([file, ...rest.slice(0, -1)]); rest.at(-1)(null); },
    rename: (from, to, callback) => { calls.push(["rename", from.startsWith(`${to}.`), to]); callback(null); },
  };
  makeWritesAtomic(fs);
  const wrapped = fs.writeFile;
  makeWritesAtomic(fs);
  assert.equal(fs.writeFile, wrapped);
  await new Promise((resolve) => fs.writeFile("/out/a.js", "x", { mode: 0o644 }, resolve));
  assert.match(calls[0][0], /^\/out\/a\.js\.\d+\.\d+\.tmp$/);
  assert.deepEqual(calls[0][1], { mode: 0o644 });
  assert.deepEqual(calls[1], ["rename", true, "/out/a.js"]);
});

test("only the development browser compiler is changed", () => {
  const server = withAtomicDevEmit({ plugins: [] }, { dev: true, isServer: true });
  assert.equal(server.plugins.length, 0);
  const production = withAtomicDevEmit({ plugins: [] }, { dev: false, isServer: false });
  assert.equal(production.plugins.length, 0);
  const client = withAtomicDevEmit({}, { dev: true, isServer: false });
  assert.equal(client.plugins.length, 1);
  assert.ok(client.plugins[0] instanceof AtomicEmitPlugin);

  const taps = [];
  const compiler = { outputFileSystem: outputFs(), hooks: { afterEnvironment: { tap: (name, fn) => taps.push(fn) } } };
  client.plugins[0].apply(compiler);
  assert.equal(compiler.outputFileSystem.__simforgeAtomicWrites, true);
  compiler.outputFileSystem = outputFs();
  taps.forEach((fn) => fn());
  assert.equal(compiler.outputFileSystem.__simforgeAtomicWrites, true, "a replaced output file system is wrapped too");
});
