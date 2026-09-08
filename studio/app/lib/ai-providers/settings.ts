import "server-only";

import { openSecretVault } from "@/app/lib/cloud/vault";
import {
  ASSET_GENERATION_NOT_CONFIGURED_MESSAGE,
  type AiCredentialSource,
  type AiProviderId,
  type AiProviderKeyStatus,
  type AiProviderSettingsStatus,
  type UpdateAiProviderSettings,
} from "./contracts";

/**
 * Local AI provider configuration for the studio service.
 *
 * Secrets: user-entered keys live in the OS vault (`simforge-studio` /
 * `ai-provider:<id>`), or in process memory when this machine has no usable
 * vault. `MESHY_API_KEY` in the service environment is honoured as a
 * lower-priority source so a developer or CI shell keeps working without the
 * settings UI. Nothing here is ever returned to the renderer beyond a
 * four-character hint.
 */

const VAULT_SERVICE = "simforge-studio";

const ENV_KEYS: Record<AiProviderId, string> = {
  meshy: "MESHY_API_KEY",
};

function vaultAccount(provider: AiProviderId): string {
  return `ai-provider:${provider}`;
}

function envKey(provider: AiProviderId): string | null {
  const value = process.env[ENV_KEYS[provider]];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
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

export async function getAiProviderSettingsStatus(): Promise<AiProviderSettingsStatus> {
  const [meshy, store] = await Promise.all([
    resolveProviderKey("meshy"),
    openSecretVault(VAULT_SERVICE),
  ]);
  return {
    keyStorage: store.persistence,
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
  if (patch.meshyApiKey !== undefined) {
    if (patch.meshyApiKey === null) await store.delete(vaultAccount("meshy"));
    else await store.set(vaultAccount("meshy"), patch.meshyApiKey);
  }
  return getAiProviderSettingsStatus();
}
