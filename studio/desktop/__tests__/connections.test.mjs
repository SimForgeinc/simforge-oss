// Regressions for desktop/connections.mjs: the target rules the chooser
// enforces, where tokens go, and how pairing exchanges a code.
//
//   node --test studio/desktop/__tests__/connections.test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  connectLink,
  CONNECTIONS_FILE,
  forgetRemoteHost,
  openConnectionStore,
  openShellVault,
  pairRemoteHost,
  parseConnectLink,
  parseHostOrigin,
  resolveRemoteTarget,
  SHELL_TOKEN_FILE,
} from "../connections.mjs";

/**
 * A fake Electron `safeStorage`. The seal is reversible by the test and
 * recognisable in a file, which is the point: the assertions are that the
 * plaintext token never reaches disk and that an unsealable platform never
 * writes one at all.
 * @param {{ available?: boolean; backend?: string }} [options]
 */
function fakeStorage({ available = true, backend = "gnome_libsecret" } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (plain) => Buffer.concat([Buffer.from("sealed:"), Buffer.from(plain, "utf8")]),
    decryptString: (buffer) => {
      const text = buffer.toString("utf8");
      if (!text.startsWith("sealed:")) throw new Error("not sealed by this key");
      return text.slice("sealed:".length);
    },
  };
}

describe("host origin rules", () => {
  it("accepts an exact http(s) origin and tells loopback from the network", () => {
    assert.deepEqual(parseHostOrigin("http://100.64.0.10:5421"), { origin: "http://100.64.0.10:5421", plaintextNetwork: true });
    assert.deepEqual(parseHostOrigin("https://gpu.example.net"), { origin: "https://gpu.example.net", plaintextNetwork: false });
    assert.deepEqual(parseHostOrigin("http://127.0.0.1:5199/"), { origin: "http://127.0.0.1:5199", plaintextNetwork: false });
  });
  it("refuses anything that is not a bare origin", () => {
    for (const bad of ["100.64.0.10:5421", "ftp://x", "http://user:pw@h:1", "http://h:1/dashboard", "http://h:1/?x", "http://h:1/#f", ""]) {
      assert.throws(() => parseHostOrigin(bad), Error, bad);
    }
  });
  it("reads a connect link and never expects a token in it", () => {
    const link = connectLink("http://100.64.0.10:5421", "ABCD-EFGH");
    assert.equal(link, "simforge://connect?origin=http%3A%2F%2F100.64.0.10%3A5421&code=ABCD-EFGH");
    assert.deepEqual(parseConnectLink(link), { origin: "http://100.64.0.10:5421", code: "ABCDEFGH" });
    assert.throws(() => parseConnectLink("https://simforge.ai/connect?origin=x&code=y"));
    assert.throws(() => parseConnectLink("simforge://connect?origin=http://h:1"));
  });
});

describe("reading a saved connections file", () => {
  /**
   * The file is on the user's disk and survives downgrades, hand edits and
   * half-written upgrades. Every entry is re-validated on read, because a
   * bad origin here becomes the origin a token is sent to.
   */
  it("drops entries it cannot validate and never selects one that is gone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "simforge-connections-file-"));
    try {
      await writeFile(join(dir, CONNECTIONS_FILE), JSON.stringify({
        schema: "simforge.desktop-connections/v1",
        selected: "ghost",
        remotes: [
          { id: "good", origin: "https://gpu.example.net/", label: "  GPU box  ", plaintextAcknowledged: true },
          { id: "dupe", origin: "https://gpu.example.net", label: "second row for one origin" },
          { id: "junk", origin: "not a url" },
          { id: "pathy", origin: "https://gpu.example.net/dashboard" },
          { origin: "https://no-id.example" },
          "nonsense",
        ],
      }));
      const store = await openConnectionStore(dir);
      assert.deepEqual(store.remotes().map((remote) => remote.id), ["good"]);
      assert.equal(store.remotes()[0].label, "GPU box");
      assert.equal(store.remotes()[0].origin, "https://gpu.example.net");
      assert.equal(store.selected(), null, "a selection naming a dropped row must not survive");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores a file from another schema entirely", async () => {
    const dir = await mkdtemp(join(tmpdir(), "simforge-connections-schema-"));
    try {
      await writeFile(join(dir, CONNECTIONS_FILE), JSON.stringify({
        schema: "simforge.desktop-connections/v2",
        selected: "x",
        remotes: [{ id: "x", origin: "https://gpu.example.net" }],
      }));
      const store = await openConnectionStore(dir);
      assert.deepEqual(store.remotes(), []);
      assert.equal(store.selected(), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("saved targets and their tokens", () => {
  let dir;
  let storage;
  let store;
  let vault;
  /** @type {ReturnType<typeof createServer>} */
  let host;
  let hostOrigin;
  const claims = [];
  const liveCodes = new Set(["ABCDEFGH", "ZZZZ2222"]);

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "simforge-connections-"));
    storage = fakeStorage();
    store = await openConnectionStore(dir);
    vault = await openShellVault({ dir, storage });
    host = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      claims.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      const code = JSON.parse(raw || "{}").code;
      const ok = liveCodes.delete(code);
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { controlToken: `token-for-${code}` } : { error: "pairing_code_invalid" }));
    });
    await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
    hostOrigin = `http://127.0.0.1:${host.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => host.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it("keys sealed tokens in its own namespace, one account per host origin", async () => {
    assert.equal(vault.persistence, "os-sealed");
    await vault.set("http://a.example:1", "TOKEN-AAAA");
    await vault.set("http://b.example:1", "TOKEN-BBBB");
    assert.equal(await vault.get("http://a.example:1"), "TOKEN-AAAA");
    assert.equal(await vault.get("http://b.example:1"), "TOKEN-BBBB");
    // One account per origin: two daemons cannot share an entry, which is
    // exactly what the product's Cloud-origin-keyed vault cannot promise.
    const written = JSON.parse(await readFile(join(dir, SHELL_TOKEN_FILE), "utf8"));
    assert.equal(written.schema, "simforge.desktop-host-tokens/v1");
    assert.deepEqual(Object.keys(written.tokens).sort(), ["remote-host:http://a.example:1", "remote-host:http://b.example:1"]);
    const raw = await readFile(join(dir, SHELL_TOKEN_FILE), "utf8");
    assert.ok(!raw.includes("TOKEN-"), "no control token may reach the file in the clear");
    assert.equal(Buffer.from(written.tokens["remote-host:http://a.example:1"], "base64").toString("utf8"), "sealed:TOKEN-AAAA");
    // A reopened vault reads the same file back through the OS store.
    const reopened = await openShellVault({ dir, storage });
    assert.equal(await reopened.get("http://a.example:1"), "TOKEN-AAAA");
    assert.equal(await reopened.get("http://never-paired.example:1"), null);
  });

  it("returns null rather than throwing when a sealed token cannot be opened", async () => {
    const other = await openShellVault({ dir, storage: { ...fakeStorage(), decryptString: () => { throw new Error("wrong key"); } } });
    assert.equal(await other.get("http://a.example:1"), null);
  });

  it("pairs by exchanging the code once, in a body, and keeps the token out of the file", async () => {
    const remote = await pairRemoteHost({ store, vault, origin: hostOrigin, code: "abcd-efgh", label: "Box", plaintextAcknowledged: false });
    assert.equal(remote.origin, hostOrigin);
    assert.equal(remote.label, "Box");
    assert.equal(claims.length, 1);
    assert.equal(claims[0].method, "POST");
    assert.equal(claims[0].url, "/api/simforge/host/pair");
    assert.equal(claims[0].headers.authorization, undefined);
    assert.deepEqual(JSON.parse(claims[0].body), { code: "ABCDEFGH" });
    assert.equal(await vault.get(hostOrigin), "token-for-ABCDEFGH");
    const file = await readFile(join(dir, "connections.json"), "utf8");
    assert.ok(!file.includes("token-for"), "token must not be persisted in the connections file");
    assert.ok(!file.includes("ABCDEFGH"), "the code is one-use and not kept either");
    // The code died on use: presenting it again is refused by the host.
    await assert.rejects(
      pairRemoteHost({ store, vault, origin: hostOrigin, code: "ABCD-EFGH", plaintextAcknowledged: false }),
      /not accepted/,
    );
  });

  it("re-pairing the same origin replaces the row instead of duplicating it", async () => {
    const again = await pairRemoteHost({ store, vault, origin: hostOrigin, code: "ZZZZ2222", plaintextAcknowledged: false });
    assert.equal(store.remotes().length, 1);
    assert.equal(again.label, "Box", "an unnamed re-pair keeps the earlier name");
    assert.equal(await vault.get(hostOrigin), "token-for-ZZZZ2222");
  });

  it("refuses a plain-HTTP network origin before any request is made", async () => {
    const before = claims.length;
    await assert.rejects(
      pairRemoteHost({ store, vault, origin: "http://100.64.0.10:5421", code: "ABCDEFGH", plaintextAcknowledged: false }),
      (error) => error.name === "PlaintextRefused" && /private tailnet/.test(error.message),
    );
    assert.equal(claims.length, before, "no pairing request may leave before the acknowledgement");
  });

  it("stores the acknowledgement with the target and re-checks it on every resolve", async () => {
    const reopened = await openConnectionStore(dir);
    const remote = await reopened.add({ origin: "http://100.64.0.10:5421", plaintextAcknowledged: true });
    await vault.set(remote.origin, "tok");
    assert.equal((await resolveRemoteTarget({ store: reopened, vault, id: remote.id })).kind, "ready");
    const silent = await reopened.add({ origin: "http://100.64.0.11:5421", plaintextAcknowledged: false });
    await vault.set(silent.origin, "tok");
    const refused = await resolveRemoteTarget({ store: reopened, vault, id: silent.id });
    assert.equal(refused.kind, "refused");
    // A loopback or HTTPS origin needs no acknowledgement.
    const tls = await reopened.add({ origin: "https://gpu.example.net", plaintextAcknowledged: false });
    assert.equal((await resolveRemoteTarget({ store: reopened, vault, id: tls.id })).kind, "unpaired");
  });

  it("remembers the selection across reopen and clears it when the target is forgotten", async () => {
    const reopened = await openConnectionStore(dir);
    const [first] = reopened.remotes();
    await reopened.select(first.id);
    assert.equal((await openConnectionStore(dir)).selected(), first.id);
    await forgetRemoteHost({ store: reopened, vault, id: first.id });
    assert.equal(await vault.get(first.origin), null, "forgetting removes the token too");
    assert.equal((await openConnectionStore(dir)).selected(), null);
    await assert.rejects(reopened.select("nope"));
  });

  it("degrades to memory, never a file, when the platform cannot seal a secret", async () => {
    for (const storage of [
      // No keyring daemon: Chromium's key is a constant in the binary, so a
      // "sealed" token on disk would be a plaintext token with extra steps.
      fakeStorage({ backend: "basic_text" }),
      fakeStorage({ available: false }),
      undefined,
    ]) {
      const empty = await mkdtemp(join(tmpdir(), "simforge-unsealable-"));
      try {
        const memory = await openShellVault({ dir: empty, storage });
        assert.equal(memory.persistence, "session");
        await memory.set("http://h:1", "t");
        assert.equal(await memory.get("http://h:1"), "t");
        assert.deepEqual(await readdir(empty), [], "nothing may be written when the token cannot be sealed");
      } finally {
        await rm(empty, { recursive: true, force: true });
      }
    }
  });
});
