/**
 * Secret storage for the local service.
 *
 * Secrets live in the operating-system credential vault through
 * `@napi-rs/keyring` (Secret Service / Keychain / Windows Credential Manager).
 * When the vault is unavailable — headless session without a Secret Service,
 * missing native binding, locked keyring — the vault reports `persistence:
 * "session"` and keeps secrets in process memory only. There is deliberately
 * no plaintext file fallback: a restart then requires signing in again, and
 * the status surface tells the user so.
 */
export type SecretVault = {
  readonly persistence: "os-vault" | "session";
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<boolean>;
};

type KeyringEntry = {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
};

type KeyringModule = {
  Entry: new (service: string, account: string) => KeyringEntry;
};

const PROBE_ACCOUNT = "__simforge_vault_probe__";

/** Process-wide memory for the session-only fallback; shared by every service name. */
const sessionSecrets = new Map<string, string>();

let keyringLoad: Promise<KeyringModule | null> | null = null;

async function loadKeyring(): Promise<KeyringModule | null> {
  keyringLoad ??= (async () => {
    try {
      // Dynamic on purpose: the native binding is platform-specific and its
      // absence (unsupported target, stripped package) must degrade to the
      // reported session-only vault instead of failing module evaluation.
      const module = (await import("@napi-rs/keyring")) as unknown as KeyringModule;
      if (typeof module?.Entry !== "function") return null;
      // Probe the real platform vault: the binding can load while the daemon is
      // absent or locked, which surfaces only on the first operation.
      const probe = new module.Entry("simforge-studio", PROBE_ACCOUNT);
      probe.setPassword("ok");
      const readBack = probe.getPassword();
      probe.deletePassword();
      return readBack === "ok" ? module : null;
    } catch {
      return null;
    }
  })();
  return keyringLoad;
}

class SessionVault implements SecretVault {
  readonly persistence = "session" as const;
  constructor(private readonly service: string) {}
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

class OsVault implements SecretVault {
  readonly persistence = "os-vault" as const;
  constructor(private readonly keyring: KeyringModule, private readonly service: string) {}
  async get(account: string) {
    try {
      return new this.keyring.Entry(this.service, account).getPassword();
    } catch {
      return null;
    }
  }
  async set(account: string, secret: string) {
    new this.keyring.Entry(this.service, account).setPassword(secret);
  }
  async delete(account: string) {
    try {
      return new this.keyring.Entry(this.service, account).deletePassword();
    } catch {
      return false;
    }
  }
}

/**
 * Open the vault for one service name. Accounts are caller-scoped strings such
 * as `cloud:<origin>`; callers never see other services' entries.
 */
export async function openSecretVault(service: string): Promise<SecretVault> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(service)) throw new Error("invalid_vault_service");
  const keyring = await loadKeyring();
  return keyring ? new OsVault(keyring, service) : new SessionVault(service);
}
