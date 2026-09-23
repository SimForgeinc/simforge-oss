import assert from "node:assert/strict";
import { test } from "node:test";
import { SecretVaultError, secretVaultOpener } from "../vault";

/**
 * The vault must never wedge the server. On Linux, a write to a locked Secret
 * Service collection returns an unlock prompt that nobody answers on a
 * headless or SSH session; through the synchronous keyring API that blocked
 * the event loop forever, and one authenticated page load (which reads the
 * SimCloud connector status) stopped every route of the process. These fakes
 * stand in for that daemon: a binding whose synchronous API throws if touched,
 * and whose asynchronous API never answers.
 */

const TIMEOUT_MS = 50;

type Store = Map<string, string>;

function syncEntryTrap() {
  return class {
    constructor() {
      throw new Error("synchronous keyring call on the event loop");
    }
  };
}

function workingKeyring(store: Store, calls: string[] = []) {
  return {
    Entry: syncEntryTrap(),
    AsyncEntry: class {
      constructor(private readonly service: string, private readonly account: string) {}
      private get key() { return `${this.service}\0${this.account}`; }
      async setPassword(password: string) { calls.push("set"); store.set(this.key, password); }
      async getPassword() { calls.push("get"); return store.get(this.key); }
      async deletePassword() { calls.push("delete"); return store.delete(this.key); }
    },
  };
}

/** A daemon that holds every call open, like a Secret Service waiting on an unlock prompt. */
function silentKeyring(calls: string[] = []) {
  const never = () => new Promise<never>(() => undefined);
  return {
    Entry: syncEntryTrap(),
    AsyncEntry: class {
      async setPassword() { calls.push("set"); return never(); }
      async getPassword() { calls.push("get"); return never(); }
      async deletePassword() { calls.push("delete"); return never(); }
    },
  };
}

/** Counts event-loop turns while `work` runs; a blocked loop counts none. */
async function loopTurnsDuring<T>(work: () => Promise<T>): Promise<{ result: T; turns: number }> {
  let turns = 0;
  const ticker = setInterval(() => { turns += 1; }, 5);
  try {
    const result = await work();
    return { result, turns };
  } finally {
    clearInterval(ticker);
  }
}

test("a keyring that never answers the probe yields a session vault that names why, without blocking the loop", async () => {
  const calls: string[] = [];
  const open = secretVaultOpener({ loadModule: async () => silentKeyring(calls), timeoutMs: TIMEOUT_MS });
  // Resolving at all is the point: the old synchronous probe never returned.
  const { result: vault, turns } = await loopTurnsDuring(() => open("simforge-studio"));
  assert.ok(turns > 0, "the event loop kept turning while the vault was silent");
  assert.equal(vault.persistence, "session");
  assert.match(vault.unavailableReason ?? "", /did not answer the availability probe within 50 ms/);
  assert.deepEqual(calls, ["set"], "the probe stopped at the first unanswered call");
  // The session vault still works, in memory.
  await vault.set("cloud:https://simforge.ai", "secret");
  assert.equal(await vault.get("cloud:https://simforge.ai"), "secret");
});

test("a working keyring is used through its asynchronous API only", async () => {
  const store: Store = new Map();
  const open = secretVaultOpener({ loadModule: async () => workingKeyring(store), timeoutMs: TIMEOUT_MS });
  const vault = await open("simforge-studio");
  assert.equal(vault.persistence, "os-vault");
  assert.equal(vault.unavailableReason, null);
  assert.equal(store.size, 0, "the probe entry is removed");
  await vault.set("cloud:origin", "token");
  assert.equal(await vault.get("cloud:origin"), "token");
  assert.equal(await vault.delete("cloud:origin"), true);
  assert.equal(await vault.get("cloud:origin"), null);
});

test("a keyring that goes silent after the probe fails loudly, then is never called again", async () => {
  const calls: string[] = [];
  const store: Store = new Map();
  let silent = false;
  const working = workingKeyring(store, calls);
  const quiet = silentKeyring(calls);
  const open = secretVaultOpener({
    loadModule: async () => ({
      AsyncEntry: class {
        private readonly live: InstanceType<typeof working.AsyncEntry>;
        private readonly dead = new quiet.AsyncEntry();
        constructor(service: string, account: string) { this.live = new working.AsyncEntry(service, account); }
        setPassword(password: string) { return silent ? this.dead.setPassword() : this.live.setPassword(password); }
        getPassword() { return silent ? this.dead.getPassword() : this.live.getPassword(); }
        deletePassword() { return silent ? this.dead.deletePassword() : this.live.deletePassword(); }
      },
    }),
    timeoutMs: TIMEOUT_MS,
  });
  const vault = await open("simforge-studio");
  assert.equal(vault.persistence, "os-vault");
  silent = true;
  calls.length = 0;
  await assert.rejects(vault.get("cloud:origin"), (error: unknown) =>
    error instanceof SecretVaultError && error.code === "vault_unresponsive" && /did not answer a read/.test(error.message));
  assert.deepEqual(calls, ["get"]);
  // Latched: later calls fail at once and pin no more pool threads on the daemon.
  await assert.rejects(vault.set("cloud:origin", "token"), SecretVaultError);
  await assert.rejects(vault.delete("cloud:origin"), SecretVaultError);
  assert.deepEqual(calls, ["get"], "the binding was not called again");
});

test("a binding that fails to load, or offers no asynchronous API, is reported rather than used", async () => {
  const missing = await secretVaultOpener({
    loadModule: async () => { throw new Error("Cannot find module '@napi-rs/keyring-linux-x64-gnu'"); },
  })("simforge-studio");
  assert.equal(missing.persistence, "session");
  assert.match(missing.unavailableReason ?? "", /could not be loaded: Cannot find module/);

  const syncOnly = await secretVaultOpener({ loadModule: async () => ({ Entry: syncEntryTrap() }) })("simforge-studio");
  assert.equal(syncOnly.persistence, "session");
  assert.match(syncOnly.unavailableReason ?? "", /no asynchronous entry API/);
});
