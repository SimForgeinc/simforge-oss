import { RENDER_PRESETS, type RenderPreset } from "@simforge-oss/scenario";
import { renderConfigIssues, type RenderConfigIssue } from "@simforge-oss/render/native";

/** The preset a native render resolves to when the submission names none. */
export const DEFAULT_RENDER_PRESET: RenderPreset = "showcase";

/**
 * `RenderConfig` keys a platform render cannot honor as asked. Accepting them
 * would be a silent no-op, so the submission is refused and says why.
 */
const PLATFORM_FIXED_KEYS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^textures\./, "the texture tier is chosen by renderProfile (render: uastc-full, ml: bc7-512)"],
  [/^output\./, "platform renders encode their videos from the render spec's video settings; output.* applies only to the renderer's own CLI jobs"],
];

export type RenderRequestIssue = Omit<RenderConfigIssue, "code"> & {
  code: RenderConfigIssue["code"] | "render_request_unsupported";
};

/** A submission's `render` the renderer would refuse; the route answers 422 with every issue. */
export class RenderRequestInvalidError extends Error {
  constructor(readonly issues: readonly RenderRequestIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "RenderRequestInvalidError";
  }
}

export type ResolvedRenderRequest = {
  /** The preset the job renders with: recorded as `render_jobs.render_preset`. */
  preset: RenderPreset;
  set: Readonly<Record<string, unknown>>;
  /**
   * What the immutable intent carries as `render`. Absent for the default
   * (showcase, no overrides): `RenderIntentV1` documents an absent `render` as
   * exactly that, so default jobs keep their intent bytes and every worker
   * that predates presets can still lease them. Anything else is pinned in the
   * intent and only leased to a worker that announces
   * `intent.render-request` (`workerCanParseIntent`).
   */
  intent: { preset: RenderPreset; set?: Record<string, unknown> } | undefined;
};

/**
 * Resolves and checks a submission's `render` (`{ preset?, set? }`) against
 * the renderer's `RenderConfig` key list. Returns null for a non-native job
 * that asks for none (a preset is a native renderer setting). Throws
 * `RenderRequestInvalidError` with every issue; never corrects a value.
 */
export function resolveRenderRequest(engine: string, render: Readonly<Record<string, unknown>> | undefined): ResolvedRenderRequest | null {
  if (engine !== "native") {
    if (render === undefined) return null;
    throw new RenderRequestInvalidError([{
      code: "render_request_unsupported",
      key: "render",
      message: `render presets and overrides apply to the native engine only, not ${engine}`,
    }]);
  }
  const issues: RenderRequestIssue[] = [];
  for (const field of Object.keys(render ?? {})) {
    if (field !== "preset" && field !== "set") {
      issues.push({ code: "render_request_unsupported", key: `render.${field}`, message: `render.${field} is not accepted here (render takes preset and set)` });
    }
  }
  const rawSet = render?.set;
  if (rawSet !== undefined && (typeof rawSet !== "object" || rawSet === null || Array.isArray(rawSet))) {
    issues.push({ code: "native_render_config_invalid", key: "set", message: "render.set must be an object of dotted RenderConfig keys" });
  }
  const set = issues.length === 0 && rawSet ? rawSet as Record<string, unknown> : {};
  issues.push(...renderConfigIssues({ preset: render?.preset, set }));
  for (const key of Object.keys(set)) {
    const fixed = PLATFORM_FIXED_KEYS.find(([pattern]) => pattern.test(key));
    if (fixed && !issues.some((issue) => issue.key === key)) {
      issues.push({ code: "render_request_unsupported", key, message: `${key} cannot be set on a platform render: ${fixed[1]}` });
    }
  }
  if (issues.length > 0) throw new RenderRequestInvalidError(issues);
  const preset = (render?.preset as RenderPreset | undefined) ?? DEFAULT_RENDER_PRESET;
  const overrides = Object.keys(set).length > 0;
  return {
    preset,
    set,
    intent: preset === DEFAULT_RENDER_PRESET && !overrides ? undefined : { preset, ...(overrides ? { set: { ...set } } : {}) },
  };
}

export function isRenderPreset(value: unknown): value is RenderPreset {
  return typeof value === "string" && (RENDER_PRESETS as readonly string[]).includes(value);
}
