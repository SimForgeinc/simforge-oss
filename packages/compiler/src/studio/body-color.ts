/**
 * Studio body paint on concrete actors: the presentation-only tag the native
 * materializer emits for `studio.presentation.bodyColor` on a role.
 *
 * Fresh materialization stamps the tag itself. This helper reconciles the
 * authored paint onto an already-materialized input — an editor replaying a
 * stored base input while changing presentation metadata — and, like
 * `parked-cars.ts`, is dependency-free so the browser worker and the compiler
 * service share one implementation.
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

interface TaggedActorsCarrier {
  readonly actors: readonly { readonly tags: readonly string[] }[];
}

interface PaintedRolesCarrier {
  readonly roles: readonly {
    readonly id: string;
    readonly extensions?: Readonly<Record<string, unknown>> | undefined;
  }[];
}

/**
 * Reconcile authored Studio paint onto an already-materialized input: every
 * `role:<id>` actor carries exactly the tag its role's paint implies, and stale
 * paint tags are dropped. Returns the same object when nothing changes.
 */
export function withStudioBodyColorTags<T extends TaggedActorsCarrier>(input: T, template: PaintedRolesCarrier): T {
  const colors: Record<string, string> = {};
  for (const role of template.roles) {
    const color = normalizeStudioBodyColor(role.extensions?.[STUDIO_BODY_COLOR_EXTENSION_KEY]);
    if (color) colors[role.id] = color;
  }

  let changed = false;
  const actors = input.actors.map((actor) => {
    const roleTag = actor.tags.find((tag) => tag.startsWith("role:"));
    const color = roleTag ? colors[roleTag.slice("role:".length)] : undefined;
    const tags = actor.tags.filter((tag) => !tag.startsWith(STUDIO_BODY_COLOR_TAG_PREFIX));
    if (color) tags.push(`${STUDIO_BODY_COLOR_TAG_PREFIX}${color}`);
    if (tags.length === actor.tags.length && tags.every((tag, index) => tag === actor.tags[index])) return actor;
    changed = true;
    return { ...actor, tags };
  });
  return changed ? { ...input, actors } : input;
}
