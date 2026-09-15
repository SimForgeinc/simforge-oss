import type { ScenarioMapDescriptorDto } from "@simforge-oss/studio-host";
import type { MapProfile } from "./map-registry";
import richmond from "./bundled/richmond-field-station.json";

/**
 * Public maps this installation knows without asking SimCloud.
 *
 * A fresh install needs the free Richmond Field Station map before it has an
 * account, and the Cloud's anonymous catalog is not something a first run
 * should depend on. The descriptor and both profile plans were captured from
 * the publishing Cloud verbatim (`bundled/richmond-field-station.json`); the
 * bytes come straight from the public map registry's CDN, addressed by the
 * member digest the plan already carries, so every download is still verified
 * against the same closure identity SimCloud would have handed out.
 *
 * Refresh the fixture when the registry promotes a new Richmond version:
 * `GET /api/simforge/maps` and `GET /api/simforge/maps/cache-plan?profile=…`
 * from a Cloud that still serves it anonymously.
 */

export type BundledPlanAsset = {
  relativePath: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  required: boolean;
};

export type BundledPlan = {
  mapVersionId: string;
  closureSha256: string;
  assets: BundledPlanAsset[];
  registryReleaseDigest: string | null;
  canonicalDigest: string | null;
  registryVersion: number | null;
  logicalMapId: string | null;
  visibility: "public";
};

export type BundledMap = {
  descriptor: ScenarioMapDescriptorDto & { visibility: "public"; logicalMapId: string | null };
  plans: Record<MapProfile, BundledPlan>;
  /** `<blobBaseUrl>/<xx>/<sha256>`: the registry's content-addressed member layout. */
  blobBaseUrl: string;
};

type Fixture = {
  blobBaseUrl: string;
  descriptor: BundledMap["descriptor"];
  plans: Record<MapProfile, Omit<BundledPlan, "assets" | "mapVersionId"> & {
    /** `[relativePath, sha256, byteLength, mediaType?]`; the media type defaults to octet-stream. */
    assets: Array<[string, string, number] | [string, string, number, string]>;
  }>;
};

function inflate(fixture: Fixture): BundledMap {
  const mapVersionId = fixture.descriptor.mapVersionId;
  const plan = (profile: MapProfile): BundledPlan => ({
    mapVersionId,
    closureSha256: fixture.plans[profile].closureSha256,
    registryReleaseDigest: fixture.plans[profile].registryReleaseDigest ?? null,
    canonicalDigest: fixture.plans[profile].canonicalDigest ?? null,
    registryVersion: fixture.plans[profile].registryVersion ?? null,
    logicalMapId: fixture.plans[profile].logicalMapId ?? null,
    visibility: "public",
    assets: fixture.plans[profile].assets.map(([relativePath, sha256, byteLength, mediaType]) => ({
      relativePath,
      sha256,
      byteLength,
      mediaType: mediaType ?? "application/octet-stream",
      required: true,
    })),
  });
  return {
    descriptor: fixture.descriptor,
    plans: { browser: plan("browser"), semantic: plan("semantic") },
    blobBaseUrl: fixture.blobBaseUrl,
  };
}

const BUNDLED: Record<string, BundledMap> = {};
for (const map of [inflate(richmond as unknown as Fixture)]) BUNDLED[map.descriptor.mapVersionId] = map;

export const BUNDLED_MAPS: readonly BundledMap[] = Object.values(BUNDLED);

export function bundledMap(mapVersionId: string): BundledMap | null {
  return BUNDLED[mapVersionId] ?? null;
}

/** Anonymous, immutable delivery URL for one member of a bundled map. */
export function bundledMemberUrl(map: BundledMap, sha256: string): string {
  return `${map.blobBaseUrl}/${sha256.slice(0, 2)}/${sha256}`;
}
