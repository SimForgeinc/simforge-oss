import type { ScenarioDocumentDto } from "./contracts";

/** Product messages for route error codes both hosts emit. */
export const STUDIO_HOST_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  dataset_name_taken: "A dataset with that name already exists in this workspace.",
  tag_label_taken: "A tag with that name already exists in this workspace.",
  dataset_action_denied: "You do not have permission to change this dataset.",
  dataset_not_found: "That dataset no longer exists.",
  document_not_found: "That scenario no longer exists.",
  tag_not_found: "That tag no longer exists.",
};

/**
 * A non-2xx answer from a host route.
 *
 * Carries the route's error code, not just a message: the postprocess form needs
 * to tell `parent_not_succeeded` (wait) from `source_artifact_unavailable` (pick
 * another file) from a 403 (you cannot write here), and a stringified message
 * cannot be branched on without matching prose.
 */
export class StudioHostRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string = STUDIO_HOST_ERROR_MESSAGES[code] ?? code,
  ) {
    super(message);
    this.name = "StudioHostRequestError";
  }
}

/** A typed 409 from a route that reports a name collision (`datasets`, `tags`). */
export class ScenarioNameConflict extends StudioHostRequestError {
  constructor(
    code: string,
    readonly field: string,
  ) {
    super(code, 409, STUDIO_HOST_ERROR_MESSAGES[code] ?? "That name is already taken in this workspace.");
    this.name = "ScenarioNameConflict";
  }
}

/**
 * A typed 409 from a document mutation.
 *
 * Carries the server's current document when the route supplied it so a caller
 * can rebase rather than re-fetch: the body is `ScenarioConflictDto`, and
 * `refetch: true` is the server's instruction, not a hint.
 */
export class ScenarioVersionConflict extends StudioHostRequestError {
  constructor(
    readonly currentDraftVersion: number | null,
    readonly current: ScenarioDocumentDto | null,
  ) {
    super("draft_version_conflict", 409, "This scenario changed in another tab or session. Reload before saving again.");
    this.name = "ScenarioVersionConflict";
  }
}
