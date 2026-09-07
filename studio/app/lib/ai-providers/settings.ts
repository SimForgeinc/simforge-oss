import "server-only";

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LOCAL_CLOUD_ROOT } from "@/app/lib/db/config";
import { getCloudStatus } from "@/app/lib/cloud/connection";
import { openSecretVault } from "@/app/lib/cloud/vault";
import {
  ASSET_GENERATION_NOT_CONFIGURED_MESSAGE,
  ASSISTANT_NOT_CONFIGURED_MESSAGE,
  DEFAULT_ANTHROPIC_MODEL,
  type AiCredentialSource,
  type AiProviderId,
  type AiProviderKeyStatus,
  type AiProviderSettingsStatus,
  type AssistantBackend,
  type UpdateAiProviderSettings,
} from "./contracts";

/**
 * Local AI provider configuration for the studio service.
 *
 * Secrets: user-entered keys live in the OS vault (`simforge-studio` /
 * `ai-provider:<id>`), or in process memory when this machine has no usable
 * vault. `ANTHROPIC_API_KEY` / `MESHY_API_KEY` in the service environment are
 * honoured as a lower-priority source so a developer or CI shell keeps
 * working without the settings UI. Nothing here is ever returned to the
 * renderer beyond a four-character hint.
 *
 * Preferences (backend choice, model name) are not secrets and live in a
 * small JSON file under the local data root.
 */

const VAULT_SERVICE = "simforge-studio";
const PREFERENCES_FILE = join(LOCAL_CLOUD_ROOT, "ai-providers.json");

const ENV_KEYS: Record<AiProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  meshy: "MESHY_API_KEY",
};

type Preferences = {
  assistantBackend: AssistantBackend;
  anthropicModel: string | null;
};

const DEFAULT_PREFERENCES: Preferences = { assistantBackend: "anthropic", anthropicModel: null };

function vaultAccount(provider: AiProviderId): string {
  return `ai-provider:${provider}`;
}

function envKey(provider: AiProviderId): string | null {
  const value = process.env[ENV_KEYS[provider]];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

async function readPreferences(): Promise<Preferences> {
  let raw: string;
  try {
    raw = await readFile(PREFERENCES_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_PREFERENCES };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      assistantBackend: parsed.assistantBackend === "simcloud" ? "simcloud" : "anthropic",
      anthropicModel:
        typeof parsed.anthropicModel === "string" && parsed.anthropicModel.trim()
          ? parsed.anthropicModel.trim()
          : null,
    };
  } catch {
    // A corrupt preferences file must not lock the user out of the settings page.
    return { ...DEFAULT_PREFERENCES };
  }
}

async function writePreferences(preferences: Preferences): Promise<void> {
  await mkdir(LOCAL_CLOUD_ROOT, { recursive: true });
  const temporary = `${PREFERENCES_FILE}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, PREFERENCES_FILE);
}

export type ResolvedProviderKey = { apiKey: string; source: AiCredentialSource };

/** Vault/session first, then the service environment. Never logged. */
export async function resolveProviderKey(provider: AiProviderId): Promise<ResolvedProviderKey | null> {
  const store = await openSecretVault(VAULT_SERVICE);
  const stored = await store.get(vaultAccount(provider));
  if (stored) {
    return { apiKey: stored, source: store.persistence === "os-vault" ? "os-vault" : "session" };
  }
  const fromEnv = envKey(provider);
  return fromEnv ? { apiKey: fromEnv, source: "environment" } : null;
}

function keyStatus(resolved: ResolvedProviderKey | null): AiProviderKeyStatus {
  return {
    configured: resolved !== null,
    source: resolved?.source ?? null,
    keyHint: resolved ? resolved.apiKey.slice(-4) : null,
  };
}

export async function getAssistantBackend(): Promise<AssistantBackend> {
  return (await readPreferences()).assistantBackend;
}

export async function getAnthropicModel(): Promise<string> {
  const preferences = await readPreferences();
  return preferences.anthropicModel ?? process.env.ANTHROPIC_MODEL?.trim() ?? DEFAULT_ANTHROPIC_MODEL;
}

export async function getAiProviderSettingsStatus(): Promise<AiProviderSettingsStatus> {
  const [preferences, anthropic, meshy, cloud, store] = await Promise.all([
    readPreferences(),
    resolveProviderKey("anthropic"),
    resolveProviderKey("meshy"),
    getCloudStatus(),
    openSecretVault(VAULT_SERVICE),
  ]);
  const cloudConnected = cloud.state === "connected";
  const model = preferences.anthropicModel ?? process.env.ANTHROPIC_MODEL?.trim() ?? DEFAULT_ANTHROPIC_MODEL;

  let assistantReason: string | null = null;
  if (preferences.assistantBackend === "anthropic" && !anthropic) {
    assistantReason = ASSISTANT_NOT_CONFIGURED_MESSAGE;
  } else if (preferences.assistantBackend === "simcloud" && !cloudConnected) {
    assistantReason =
      cloud.state === "expired"
        ? "Your SimCloud session expired. Sign in again to use the SimCloud assistant."
        : "Connect SimCloud to use the managed assistant, or switch to your own Anthropic key.";
  }

  return {
    keyStorage: store.persistence,
    assistant: {
      backend: preferences.assistantBackend,
      anthropic: { ...keyStatus(anthropic), model },
      simcloud: {
        connected: cloudConnected,
        origin: cloud.origin || null,
        user: cloud.user?.email ?? cloud.user?.name ?? null,
      },
      available: assistantReason === null,
      reason: assistantReason,
    },
    assetGeneration: {
      meshy: keyStatus(meshy),
      available: meshy !== null,
      reason: meshy ? null : ASSET_GENERATION_NOT_CONFIGURED_MESSAGE,
    },
  };
}

export async function updateAiProviderSettings(
  patch: UpdateAiProviderSettings,
): Promise<AiProviderSettingsStatus> {
  const store = await openSecretVault(VAULT_SERVICE);
  if (patch.anthropicApiKey !== undefined) {
    if (patch.anthropicApiKey === null) await store.delete(vaultAccount("anthropic"));
    else await store.set(vaultAccount("anthropic"), patch.anthropicApiKey);
  }
  if (patch.meshyApiKey !== undefined) {
    if (patch.meshyApiKey === null) await store.delete(vaultAccount("meshy"));
    else await store.set(vaultAccount("meshy"), patch.meshyApiKey);
  }
  if (patch.assistantBackend !== undefined || patch.anthropicModel !== undefined) {
    const current = await readPreferences();
    await writePreferences({
      assistantBackend: patch.assistantBackend ?? current.assistantBackend,
      anthropicModel:
        patch.anthropicModel === undefined ? current.anthropicModel : patch.anthropicModel,
    });
  }
  return getAiProviderSettingsStatus();
}
