import "server-only";

import { ChatAnthropic } from "@langchain/anthropic";
import { cloudRequest } from "@/app/lib/cloud/connection";
import { DEFAULT_ANTHROPIC_MODEL } from "@/app/lib/ai-providers/contracts";
import {
  getAiProviderSettingsStatus,
  getAnthropicModel,
  getAssistantBackend,
  resolveProviderKey,
} from "@/app/lib/ai-providers/settings";

export { DEFAULT_ANTHROPIC_MODEL };

/**
 * Managed SimCloud path: the Anthropic SDK's Messages API, reverse-proxied by
 * Cloud under the desktop session. The local service never holds a Cloud
 * model key; `cloudRequest` attaches the user's session bearer.
 */
export const SIMCLOUD_ANTHROPIC_PROXY_PATH = "/api/desktop/ai/anthropic";

/**
 * Thrown when an LLM feature is requested but no backend can serve it.
 * `message` is user-facing and already names the fix.
 */
export class AssistantUnavailableError extends Error {
  override name = "AssistantUnavailableError";
}

export function isAnthropicThinkingEnabled(): boolean {
  return process.env.ANTHROPIC_THINKING_ENABLED?.trim().toLowerCase() === "true";
}

/** Resolve without constructing a model; `reason` is the user-facing message. */
export async function assistantAvailability(): Promise<{ available: boolean; reason: string | null }> {
  const status = await getAiProviderSettingsStatus();
  return { available: status.assistant.available, reason: status.assistant.reason };
}

/**
 * The chat model behind every assistant-style feature (editor assistant, map
 * AI search, scenario-intent parsing). Resolved per request so a key entered
 * in Settings applies immediately. Throws {@link AssistantUnavailableError}
 * when nothing is configured; callers surface that message verbatim.
 */
export async function createChatModel(): Promise<ChatAnthropic> {
  const thinkingEnabled = isAnthropicThinkingEnabled();
  const common = {
    model: await getAnthropicModel(),
    // Anthropic rejects `temperature` alongside extended thinking.
    ...(thinkingEnabled ? {} : { temperature: 0.2 }),
    maxTokens: 4096,
    thinking: thinkingEnabled ? ({ type: "enabled", budget_tokens: 2048 } as const) : undefined,
  };

  const backend = await getAssistantBackend();
  if (backend === "simcloud") {
    const status = await getAiProviderSettingsStatus();
    if (!status.assistant.available) {
      throw new AssistantUnavailableError(status.assistant.reason ?? "SimCloud is not connected.");
    }
    return new ChatAnthropic({
      ...common,
      // The SDK requires a key string; the proxy authenticates by session bearer and ignores it.
      apiKey: "simcloud-session",
      anthropicApiUrl: `https://simcloud.invalid${SIMCLOUD_ANTHROPIC_PROXY_PATH}`,
      clientOptions: { fetch: simcloudAnthropicFetch },
    });
  }

  const resolved = await resolveProviderKey("anthropic");
  if (!resolved) {
    const status = await getAiProviderSettingsStatus();
    throw new AssistantUnavailableError(status.assistant.reason ?? "No Anthropic API key is configured.");
  }
  return new ChatAnthropic({ ...common, apiKey: resolved.apiKey });
}

/**
 * Route the Anthropic SDK's requests through the authenticated Cloud
 * connector. Only the path under the proxy prefix is forwarded; the SDK's
 * placeholder `x-api-key` is dropped so no client-side credential is sent.
 */
async function simcloudAnthropicFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  headers.delete("x-api-key");
  headers.delete("authorization");
  return cloudRequest(`${url.pathname}${url.search}`, { ...init, headers }, { signal: init?.signal ?? undefined });
}
