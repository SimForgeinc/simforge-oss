/** One process = one database session: commits a revision of `argv[2]` at draft version `argv[3]`, at wall-clock `argv[4]`. */
import "./pg-env";

import { LOCAL_ORGANIZATION_ID, LOCAL_USER_ID, LOCAL_WORKSPACE_ID } from "@/app/lib/auth/session";
import type { AppContext } from "@/app/lib/db/app-context";
import { shutdownDatabase } from "@/app/lib/db/data-api";
import { EMPTY_AMBIENT_CONFIG_SHA256, EMPTY_AMBIENT_RESULT_SHA256 } from "../../contracts";
import { createScenarioRevision } from "../../document-store";

const context = { userId: LOCAL_USER_ID, workspaceId: LOCAL_WORKSPACE_ID, organizationId: LOCAL_ORGANIZATION_ID } as AppContext;
const [documentId, version, goAt] = process.argv.slice(2);
// Every worker loads first, then all commit at the same instant.
await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(goAt) - Date.now())));
try {
  const result = await createScenarioRevision(context, documentId!, {
    expectedVersion: Number(version),
    ambient: { mode: "disabled", ambientConfig: {}, configSha256: EMPTY_AMBIENT_CONFIG_SHA256, resultSha256: EMPTY_AMBIENT_RESULT_SHA256 },
  });
  process.stdout.write(JSON.stringify({ kind: result.kind, revisionId: result.kind === "created" ? result.revision.id : null }));
} catch (error) {
  process.stdout.write(JSON.stringify({ kind: "error", message: error instanceof Error ? error.message : String(error) }));
} finally {
  await shutdownDatabase();
}
