/**
 * Secret storage for the local service.
 *
 * Secrets live in the operating-system credential vault through
 * `@napi-rs/keyring` (Secret Service / Keychain / Windows Credential Manager).
 * When the vault is unavailable — headless session without a Secret Service,
 * missing native binding, locked keyring — the vault reports `persistence:
 * "session"`, names why in `unavailableReason`, and keeps secrets in process
 * memory only. There is deliberately no plaintext file fallback: a restart
 * then requires signing in again, and the status surface tells the user so.
 *
 * Every keyring call is asynchronous and bounded. The synchronous `Entry` API
 * runs on the event loop, and on Linux a write to a locked Secret Service
 * collection returns an unlock prompt that nobody answers on a headless or
 * SSH session: the call then never returns and the whole server stops
 * answering, every route at once. `AsyncEntry` runs on the libuv pool and the
 * deadline turns a silent vault into an explicit error. After one deadline
 * miss the vault is treated as unresponsive for the rest of the process, so a
 * stuck keyring pins at most the pool threads already waiting on it.
 *
 * Known limit: a pool thread still inside the daemon call is joined when the
 * process exits, so exiting waits until the keyring answers (or the process is
 * killed). Only a disposable child process would lift that; the server itself
 * keeps answering either way. A cloud host never gets here — see
 * `requireLocalConnector` in `./connection`.
 */
export type SecretVault = {
  readonly persistence: "os-vault" | "session";
  /** Why the OS vault is not in use; `null` when it is (or nothing was probed). */
  readonly unavailableReason?: string | null;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<boolean>;
};

export type SecretVaultErrorCode = "vault_unresponsive" | "vault_failed";

export class SecretVaultError extends Error {
  constructor(readonly code: SecretVaultErrorCode, message: string) {
    super(message);
    this.name = "SecretVaultError";
  }
}

type AsyncKeyringEntry = {
  getPassword(signal?: AbortSignal | null): Promise<string | null | undefined>;
  setPassword(password: string, signal?: AbortSignal | null): Promise<void>;
  deletePassword(signal?: AbortSignal | null): Promise<boolean>;
};

type KeyringModule = {
  AsyncEntry: new (service: string, account: string) => AsyncKeyringEntry;
};

/**
 * How long one keyring call may take. Generous for a daemon round trip,
 * far short of a request timeout; an unlock prompt a person is actually
 * answering on a desktop is the only legitimate reason to come close.
 */
export const VAULT_OPERATION_TIMEOUT_MS = 10_000;

const PROBE_ACCOUNT = "__simforge_vault_probe__";

/** Process-wide memory for the session-only fallback; shared by every service name. */
const sessionSecrets = new Map<string, string>();

class SessionVault implements SecretVault {
  readonly persistence = "session" as const;
  constructor(private readonly service: string, readonly unavailableReason: string | null) {}
  async get(account: string) {
    return sessionSecrets.get(`${this.service}\0${account}`) ?? null;
  }
  async set(account: string, secret: string) {
    sessionSecrets.set(`${this.service}\0${account}`, secret);
  }
  async delete(account: string) {
    return sessionSecrets.delete(`${this.service}\0${account}`);
  }
}

type KeyringLoad = { keyring: KeyringModule; reason: null } | { keyring: null; reason: string };

export type SecretVaultOpenerOptions = {
  /** Resolves the binding; the default imports `@napi-rs/keyring`. */
  loadModule: () => Promise<unknown>;
  timeoutMs?: number;
};

/**
 * Build an `openSecretVault` over one keyring binding. Each opener owns its
 * probe and its unresponsive latch; the module-level {@link openSecretVault}
 * is the one the service uses.
 */
export function secretVaultOpener(options: SecretVaultOpenerOptions): (service: string) => Promise<SecretVault> {
  const timeoutMs = options.timeoutMs ?? VAULT_OPERATION_TIMEOUT_MS;
  let load: Promise<KeyringLoad> | null = null;
  /** Set once a keyring call misses its deadline; later calls fail without reaching the binding. */
  let unresponsive: string | null = null;

  async function bounded<T>(operation: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (unresponsive) throw new SecretVaultError("vault_unresponsive", unresponsive);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = run(controller.signal);
    // A call that settles after its deadline has nobody left to tell.
    pending.catch(() => undefined);
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        unresponsive ??= `The OS credential vault did not answer ${operation} within ${timeoutMs} ms `
          + "(on Linux, usually a locked keyring waiting for an unlock prompt); it is not used again until Studio restarts.";
        controller.abort();
        reject(new SecretVaultError("vault_unresponsive", unresponsive));
      }, timeoutMs);
    });
    try {
      return await Promise.race([pending, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  function loadKeyring(): Promise<KeyringLoad> {
    load ??= (async (): Promise<KeyringLoad> => {
      let module: Partial<KeyringModule> | null;
      try {
        // Dynamic on purpose: the native binding is platform-specific and its
        // absence (unsupported target, stripped package) must degrade to the
        // reported session-only vault instead of failing module evaluation.
        module = (await options.loadModule()) as Partial<KeyringModule> | null;
      } catch (error) {
        return { keyring: null, reason: `The OS credential vault binding could not be loaded: ${messageOf(error)}` };
      }
      if (typeof module?.AsyncEntry !== "function") {
        return { keyring: null, reason: "The OS credential vault binding has no asynchronous entry API." };
      }
      const keyring = module as KeyringModule;
      // Probe the real platform vault: the binding can load while the daemon is
      // absent or locked, which surfaces only on the first operation.
      try {
        const readBack = await bounded("the availability probe", async (signal) => {
          const probe = new keyring.AsyncEntry("simforge-studio", PROBE_ACCOUNT);
          await probe.setPassword("ok", signal);
          const value = await probe.getPassword(signal);
          await probe.deletePassword(signal);
          return value;
        });
        if (readBack !== "ok") {
          return { keyring: null, reason: "The OS credential vault did not return what was stored in it." };
        }
        return { keyring, reason: null };
      } catch (error) {
        return {
          keyring: null,
          reason: error instanceof SecretVaultError ? error.message : `The OS credential vault is unavailable: ${messageOf(error)}`,
        };
      }
    })();
    return load;
  }

  class OsVault implements SecretVault {
    readonly persistence = "os-vault" as const;
    readonly unavailableReason = null;
    constructor(private readonly keyring: KeyringModule, private readonly service: string) {}
    private entry(account: string) {
      return new this.keyring.AsyncEntry(this.service, account);
    }
    async get(account: string) {
      try {
        return (await bounded("a read", (signal) => this.entry(account).getPassword(signal))) ?? null;
      } catch (error) {
        if (error instanceof SecretVaultError) throw error;
        return null;
      }
    }
    async set(account: string, secret: string) {
      await bounded("a write", (signal) => this.entry(account).setPassword(secret, signal));
    }
    async delete(account: string) {
      try {
        return await bounded("a delete", (signal) => this.entry(account).deletePassword(signal));
      } catch (error) {
        if (error instanceof SecretVaultError) throw error;
        return false;
      }
    }
  }

  return async (service: string) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(service)) throw new Error("invalid_vault_service");
    const loaded = await loadKeyring();
    return loaded.keyring ? new OsVault(loaded.keyring, service) : new SessionVault(service, loaded.reason);
  };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Open the vault for one service name. Accounts are caller-scoped strings such
 * as `cloud:<origin>`; callers never see other services' entries.
 */
export const openSecretVault = secretVaultOpener({ loadModule: () => import("@napi-rs/keyring") });
