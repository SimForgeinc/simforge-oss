import { createHttpStudioHost } from "@simforge-oss/studio-host";

/**
 * The local Studio host: same-origin `/api/simforge/*` routes over the fixed
 * local owner identity. Every shared screen reaches persistence, artifacts,
 * jobs and runtime capabilities through this one instance.
 */
export const studioHost = createHttpStudioHost();
