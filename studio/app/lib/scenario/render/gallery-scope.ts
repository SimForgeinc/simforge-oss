import {
  SCENARIO_RENDER_JOB_MODES,
  type ScenarioRenderJobMode,
} from "@simforge-oss/studio-host";

/**
 * What a gallery read is scoped to. `revisionId` and `documentId` are not two
 * independent filters — a document's renders span its revisions — so the scope
 * is one of three things rather than a bag of optional predicates, and the
 * "both were supplied" case is resolved once here instead of at each caller.
 *
 * Pure, and deliberately in its own module with no database imports: this is
 * the parsing step that decides which query runs, and it is worth being able
 * to test it without standing up a data root.
 */
export type GalleryScope =
  | { kind: "revision"; revisionId: string }
  | { kind: "document"; documentId: string }
  | { kind: "workspace"; jobMode: ScenarioRenderJobMode | null };

/**
 * Read a gallery scope out of a query string.
 *
 * `revisionId` wins over `documentId`, being the narrower of the two. An
 * unrecognised `jobMode` degrades to "no filter" rather than failing the read:
 * the value is parameterised in SQL either way, so this is normalisation and
 * not a safety boundary, and a stale client must not be able to 400 a list.
 *
 * The accepted vocabulary is the protocol's own `SCENARIO_RENDER_JOB_MODES`,
 * never a copy. A hand-spelled copy here previously omitted `browser_render`,
 * so `?jobMode=browser_render` — a value `ListGalleryQuery` can legally carry —
 * was dropped as unrecognised and the route answered with the whole unfiltered
 * workspace gallery instead of a filtered one.
 */
export function galleryScope(params: URLSearchParams): GalleryScope {
  const revisionId = params.get("revisionId");
  if (revisionId) return { kind: "revision", revisionId };
  const documentId = params.get("documentId");
  if (documentId) return { kind: "document", documentId };
  const jobMode = params.get("jobMode");
  return { kind: "workspace", jobMode: isRenderJobMode(jobMode) ? jobMode : null };
}

function isRenderJobMode(value: string | null): value is ScenarioRenderJobMode {
  return value !== null && (SCENARIO_RENDER_JOB_MODES as readonly string[]).includes(value);
}
