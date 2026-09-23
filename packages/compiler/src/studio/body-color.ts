/**
 * Studio body paint on concrete actors: the presentation-only tag the native
 * materializer emits for `studio.presentation.bodyColor` on a role.
 *
 * Fresh materialization stamps the tag itself; reconciling authored paint onto
 * an already-materialized input is native (`EngineRuntime.studioConcreteInput`,
 * `simforge_compiler::studio_refinements`). This module keeps the authoring-side
 * normalizer the editor uses to validate a paint before it is saved.
 */

export const STUDIO_BODY_COLOR_TAG_PREFIX = "studio:body-color:";
export const STUDIO_BODY_COLOR_EXTENSION_KEY = "studio.presentation.bodyColor";

/** `#rrggbb` for a hex or `rgb(r, g, b)` string; `null` for anything else. */
export function normalizeStudioBodyColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value.trim().toLowerCase();
  if (!text) return null;
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  if (/^#[0-9a-f]{3}$/.test(text)) {
    return `#${[...text.slice(1)].map((channel) => channel + channel).join("")}`;
  }
  if (text.startsWith("rgb(") && text.endsWith(")")) text = text.slice(4, -1);
  const channels = text.split(",");
  if (channels.length !== 3) return null;
  const bytes: number[] = [];
  for (const channel of channels) {
    const parsed = Number(channel.trim());
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) return null;
    bytes.push(parsed);
  }
  return `#${bytes.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
