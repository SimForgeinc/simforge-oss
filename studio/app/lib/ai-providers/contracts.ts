import { z } from "zod";

/**
 * Local AI provider configuration shared by the settings UI and the local
 * service. This module is imported by client components: no secrets, no
 * Node-only imports. Keys are write-only from the renderer's point of view;
 * the service reports only whether a key exists and where it is kept.
 */

export const AI_PROVIDER_IDS = ["meshy"] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

/** Where a stored provider key currently lives. `environment` is the service process env. */
export type AiCredentialSource = "os-vault" | "session" | "environment";

export type AiProviderKeyStatus = {
  configured: boolean;
  source: AiCredentialSource | null;
  /** Last four characters of the stored key so the user can recognise it. */
  keyHint: string | null;
};

export type AiAssetGenerationStatus = {
  meshy: AiProviderKeyStatus;
  available: boolean;
  reason: string | null;
};

export type AiProviderSettingsStatus = {
  /** How this machine persists user-entered keys. */
  keyStorage: "os-vault" | "session";
  assetGeneration: AiAssetGenerationStatus;
};

const ApiKeyPatchSchema = z
  .union([z.string().trim().min(8).max(512), z.null()])
  .optional();

/** PATCH body. A `null` key clears the stored key; omitted fields are untouched. */
export const UpdateAiProviderSettingsSchema = z.strictObject({
  meshyApiKey: ApiKeyPatchSchema,
});
export type UpdateAiProviderSettings = z.infer<typeof UpdateAiProviderSettingsSchema>;

export const ASSET_GENERATION_NOT_CONFIGURED_MESSAGE =
  "3D asset generation needs a Meshy API key. Add one in Settings → AI providers.";
