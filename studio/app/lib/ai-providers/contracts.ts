import { z } from "zod";

/**
 * Local AI provider configuration shared by the settings UI and the local
 * service. This module is imported by client components: no secrets, no
 * Node-only imports. Keys are write-only from the renderer's point of view;
 * the service reports only whether a key exists and where it is kept.
 */

export const AI_PROVIDER_IDS = ["anthropic", "meshy"] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

/** Which backend answers assistant, map AI search and scenario-intent requests. */
export const ASSISTANT_BACKENDS = ["anthropic", "simcloud"] as const;
export type AssistantBackend = (typeof ASSISTANT_BACKENDS)[number];

/** Where a stored provider key currently lives. `environment` is the service process env. */
export type AiCredentialSource = "os-vault" | "session" | "environment";

export type AiProviderKeyStatus = {
  configured: boolean;
  source: AiCredentialSource | null;
  /** Last four characters of the stored key so the user can recognise it. */
  keyHint: string | null;
};

/**
 * The SimCloud workspace the managed assistant runs in. The service stores
 * it per signed-in account and never carries it across sign-ins: the
 * selection lapses when a different account connects, so one person's
 * workspace is never silently billed for another's requests.
 */
export type AssistantWorkspaceSelection = {
  workspaceId: string;
  workspaceName: string;
};

export type AiAssistantStatus = {
  backend: AssistantBackend;
  anthropic: AiProviderKeyStatus & { model: string };
  simcloud: {
    connected: boolean;
    origin: string | null;
    user: string | null;
    /** Null until the user picks a workspace for this account. */
    workspace: AssistantWorkspaceSelection | null;
  };
  /** Whether the selected backend can actually serve a request right now. */
  available: boolean;
  /** Human-readable reason when unavailable; null when available. */
  reason: string | null;
};

export type AiAssetGenerationStatus = {
  meshy: AiProviderKeyStatus;
  available: boolean;
  reason: string | null;
};

export type AiProviderSettingsStatus = {
  /** How this machine persists user-entered keys. */
  keyStorage: "os-vault" | "session";
  assistant: AiAssistantStatus;
  assetGeneration: AiAssetGenerationStatus;
};

const ApiKeyPatchSchema = z
  .union([z.string().trim().min(8).max(512), z.null()])
  .optional();

/** PATCH body. A `null` key clears the stored key; omitted fields are untouched. */
export const UpdateAiProviderSettingsSchema = z.strictObject({
  assistantBackend: z.enum(ASSISTANT_BACKENDS).optional(),
  anthropicApiKey: ApiKeyPatchSchema,
  anthropicModel: z.union([z.string().trim().min(1).max(120), z.null()]).optional(),
  /** The SimCloud workspace for the managed assistant; `null` clears the selection. */
  simcloudWorkspace: z
    .union([
      z.strictObject({
        workspaceId: z.string().trim().min(1).max(120),
        workspaceName: z.string().trim().min(1).max(200),
      }),
      z.null(),
    ])
    .optional(),
  meshyApiKey: ApiKeyPatchSchema,
});
export type UpdateAiProviderSettings = z.infer<typeof UpdateAiProviderSettingsSchema>;

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

/** Message shown wherever a feature needs an LLM and none is configured. */
export const ASSISTANT_NOT_CONFIGURED_MESSAGE =
  "No AI model is configured. Add your Anthropic API key or connect SimCloud in Settings → AI providers.";

export const ASSET_GENERATION_NOT_CONFIGURED_MESSAGE =
  "3D asset generation needs a Meshy API key. Add one in Settings → AI providers.";

export const ASSISTANT_WORKSPACE_NOT_SELECTED_MESSAGE =
  "Choose the SimCloud workspace the assistant runs in (Settings → AI providers).";
