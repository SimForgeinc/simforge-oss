const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/**
 * Returns a human-readable relative time string (e.g. "3 days ago", "just now").
 * Uses Intl.RelativeTimeFormat — no external dependency required.
 */
export function formatRelativeTime(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const abs = Math.abs(diffSec);

  if (abs < 60) return rtf.format(diffSec, "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 2592000) return rtf.format(Math.round(diffSec / 86400), "day");
  if (abs < 31536000) return rtf.format(Math.round(diffSec / 2592000), "month");
  return rtf.format(Math.round(diffSec / 31536000), "year");
}

/**
 * Converts an S3 URI (s3://bucket/key) to a same-origin proxy URL for a map asset artifact.
 */
export function s3UriToMapAssetProxyUrl(
  uri: string,
  mapAssetId: string
): string | null {
  if (!uri.startsWith("s3://")) return null;
  const withoutScheme = uri.slice("s3://".length);
  const slashIdx = withoutScheme.indexOf("/");
  if (slashIdx === -1) return null;
  const key = withoutScheme.slice(slashIdx + 1);
  return `/api/map-assets/${mapAssetId}/media?key=${encodeURIComponent(key)}`;
}

/**
 * Same-origin URL for one recording artifact of a scenario.
 *
 * The route it names (`/api/scenarios/[scenarioId]/media`) resolves the key
 * against the artifacts actually linked to that scenario before presigning it,
 * so a key is a name and not a capability. This is the only place the URL
 * shape is written — a second spelling of it is how the shape came to be
 * handed to browsers while no route module answered it.
 */
export function scenarioMediaProxyUrl(scenarioId: string, key: string): string {
  return `/api/scenarios/${encodeURIComponent(scenarioId)}/media?key=${encodeURIComponent(key)}`;
}
