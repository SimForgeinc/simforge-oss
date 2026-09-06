type ScenarioLinkInput = {
  scenarioId: string;
  datasetId?: string | null;
  mapName?: string | null;
  absolute?: boolean;
};

function cleanParam(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function configuredDashboardOrigin(): string {
  const origin =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ??
    process.env.BETTER_AUTH_URL?.trim() ??
    "";
  if (!origin) return "";
  try {
    const url = new URL(origin);
    return url.hostname.endsWith(".amplifyapp.com") ? "" : url.origin;
  } catch {
    return "";
  }
}

export function absoluteDashboardHref(path: string): string {
  const origin =
    (typeof window !== "undefined" ? window.location.origin : null) ??
    configuredDashboardOrigin();
  return origin ? new URL(path, origin).toString() : path;
}

/**
 * The canonical v2 editor surface: a dataset, optionally opened on one of its
 * documents. Legacy scenario records have no document id and route to the
 * dataset alone.
 */
export function buildDashboardEditorHref(input: {
  datasetId?: string | null;
  documentId?: string | null;
}): string {
  const params = new URLSearchParams();
  const datasetId = cleanParam(input.datasetId);
  if (datasetId) params.set("dataset", datasetId);
  const documentId = cleanParam(input.documentId);
  if (documentId) params.set("document", documentId);
  return `/dashboard/scenario${params.size ? `?${params}` : ""}`;
}

export function buildDashboardScenarioHref(
  input: Pick<ScenarioLinkInput, "scenarioId" | "datasetId">,
): string {
  return buildDashboardEditorHref({ datasetId: input.datasetId });
}

export function buildDashboardScenarioEditorHref(input: ScenarioLinkInput): string {
  const href = buildDashboardEditorHref({ datasetId: input.datasetId });
  return input.absolute ? absoluteDashboardHref(href) : href;
}
