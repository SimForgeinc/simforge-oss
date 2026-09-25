import { NextResponse } from "next/server";

import {
  requireScenarioContext,
  requireScenarioMutableRevisionContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";
import { getScenarioPackageExport } from "@/app/lib/scenario/scenario-package/export.server";
import { SCENARIO_PACKAGE_EXPORT_DISABLED_REASON, scenarioPackageExportEnabled } from "@/app/lib/scenario/scenario-package/flag";

type Context = { params: Promise<{ revisionId: string; exportId: string }> };

/**
 * One "Export for CLI" of a revision: its state, and once the verified
 * container is stored, a fresh expiring download link. A job whose runner
 * stopped reporting is answered `failed` (`package_job_lost`), never left running.
 */
export async function GET(_request: Request, route: Context) {
  if (!scenarioPackageExportEnabled()) {
    return NextResponse.json(
      { error: "scenario_package_export_disabled", message: SCENARIO_PACKAGE_EXPORT_DISABLED_REASON },
      { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS },
    );
  }
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { revisionId, exportId } = await route.params;
  const access = await requireScenarioMutableRevisionContext(auth.context, revisionId, "read");
  if (access.response) return access.response;
  const exported = await getScenarioPackageExport(auth.context.workspaceId, revisionId, exportId);
  if (!exported) {
    return NextResponse.json({ error: "package_export_not_found" }, { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  }
  return NextResponse.json(exported, { headers: SCENARIO_PRIVATE_CACHE_HEADERS });
}
