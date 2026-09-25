import { after, NextResponse } from "next/server";
import { z } from "zod";

import {
  readJson,
  requireScenarioContext,
  requireScenarioMutableRevisionContext,
  SCENARIO_PRIVATE_CACHE_HEADERS,
} from "@/app/lib/scenario/http";
import { ScenarioPackageExportError } from "@/app/lib/scenario/scenario-package/errors";
import { exportScenarioPackage, runFullScenarioPackageExport } from "@/app/lib/scenario/scenario-package/export.server";
import { SCENARIO_PACKAGE_EXPORT_DISABLED_REASON, scenarioPackageExportEnabled } from "@/app/lib/scenario/scenario-package/flag";

/** The full form's job runs after the response, within this function's lifetime. */
export const maxDuration = 300;

type Context = { params: Promise<{ revisionId: string }> };

const ExportPackageSchema = z
  .object({
    form: z.enum(["thin", "full"]).default("thin"),
    /** Full form only: embed the map's texture members (default) or leave them out. */
    textures: z.enum(["include", "exclude"]).optional(),
  })
  .strict();

function scenarioPackageErrorResponse(error: unknown): NextResponse | null {
  if (!(error instanceof ScenarioPackageExportError)) return null;
  return NextResponse.json(
    { error: error.code, message: error.message, ...error.detail },
    { status: error.status, headers: SCENARIO_PRIVATE_CACHE_HEADERS },
  );
}

/**
 * "Export for CLI": `POST { form?: "thin" | "full", textures?: "include" | "exclude" }`.
 *
 * Thin (default) is written, verified and stored in the request: 201 with the
 * download link, file name and CLI one-liner. Full is a background job: 202
 * with the export id; `GET ./package/<exportId>` reports it and carries the
 * link once the verified container is stored. A revision without a stored
 * simulation, render timeline or OpenSCENARIO export is refused (409) with a
 * code naming what is missing; nothing partial is ever written.
 */
export async function POST(request: Request, route: Context) {
  if (!scenarioPackageExportEnabled()) {
    return NextResponse.json(
      { error: "scenario_package_export_disabled", message: SCENARIO_PACKAGE_EXPORT_DISABLED_REASON },
      { status: 404, headers: SCENARIO_PRIVATE_CACHE_HEADERS },
    );
  }
  const auth = await requireScenarioContext();
  if (auth.response) return auth.response;
  const { revisionId } = await route.params;
  const parsed = ExportPackageSchema.safeParse((await readJson(request)) ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_package_export", details: parsed.error.flatten() },
      { status: 400, headers: SCENARIO_PRIVATE_CACHE_HEADERS },
    );
  }
  if (parsed.data.form === "thin" && parsed.data.textures !== undefined) {
    return NextResponse.json(
      { error: "invalid_package_export", message: "`textures` applies to the full form only" },
      { status: 400, headers: SCENARIO_PRIVATE_CACHE_HEADERS },
    );
  }
  // Exporting is derived work over content the caller may already read, as for
  // the OpenSCENARIO export: `read` is the required action.
  const access = await requireScenarioMutableRevisionContext(auth.context, revisionId, "read");
  if (access.response) return access.response;
  try {
    const exported = await exportScenarioPackage(auth.context, revisionId, parsed.data);
    if (exported.form === "full") {
      const workspaceId = auth.context.workspaceId;
      after(() => runFullScenarioPackageExport(workspaceId, exported.exportId));
      return NextResponse.json(exported, { status: 202, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
    }
    return NextResponse.json(exported, { status: 201, headers: SCENARIO_PRIVATE_CACHE_HEADERS });
  } catch (error) {
    const response = scenarioPackageErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
