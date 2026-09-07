/**
 * Secret storage for the Hugging Face access token.
 *
 * Same discipline as the Studio cloud sign-in vault: the secret lives in the
 * operating-system credential store through `@napi-rs/keyring` (Secret
 * Service / Keychain / Windows Credential Manager), and when that is
 * unavailable — headless session with no Secret Service, missing native
 * binding, locked keyring — it is held in process memory only. There is
 * deliberately **no plaintext file fallback**: the user signs in again after
 * a restart and the reported `persistence` says so.
 *
 * This lives in the model-store package rather than in the Studio app so the
 * `simforge models` CLI and the desktop host use one implementation and one
 * keychain entry. A token stored by either is visible to the other.
 *
 * Only one secret is ever stored here, and only a gated sidecar repository
 * ever receives it. The account NAME is kept alongside it so the UI can say
 * whose token is in use; the token value is never returned by any API, never
 * written to an install record, never logged, and never placed in a job
 * payload or a worker environment.
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

export const MODEL_VAULT_SERVICE = "simforge-models";
export const HF_TOKEN_ACCOUNT = "hf:huggingface.co";
export const HF_IDENTITY_ACCOUNT = "hf:huggingface.co:name";

const PROBE_ACCOUNT = "__simforge_model_vault_probe__";

/** Process-wide memory for the session-only fallback. */
const sessionSecrets = new Map<string, string>();

let keyringLoad: Promise<KeyringModule | null> | null = null;

async function loadKeyring(): Promise<KeyringModule | null> {
  keyringLoad ??= (async () => {
    try {
      const module = (await import("@napi-rs/keyring")) as unknown as KeyringModule;
      if (typeof module?.Entry !== "function") return null;
      // Presence of the binding is not availability: a locked or absent
      // Secret Service throws only when an entry is actually touched, so the
      // probe writes and removes a value before we claim OS persistence.
      const probe = new module.Entry(MODEL_VAULT_SERVICE, PROBE_ACCOUNT);
      probe.setPassword("probe");
      probe.deletePassword();
      return module;
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
    return sessionSecrets.get(`${this.service}/${account}`) ?? null;
  }
  async set(account: string, secret: string) {
    sessionSecrets.set(`${this.service}/${account}`, secret);
  }
  async delete(account: string) {
    return sessionSecrets.delete(`${this.service}/${account}`);
  }
}

class OsVault implements SecretVault {
  readonly persistence = "os-vault" as const;
  constructor(
    private readonly keyring: KeyringModule,
    private readonly service: string,
  ) {}
  async get(account: string) {
    try {
      return new this.keyring.Entry(this.service, account).getPassword() ?? null;
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

export async function openModelVault(service: string = MODEL_VAULT_SERVICE): Promise<SecretVault> {
  const keyring = await loadKeyring();
  return keyring ? new OsVault(keyring, service) : new SessionVault(service);
}
