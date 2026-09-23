import { ScenarioMapResolutionError } from "@simforge-oss/studio-host";
import type { Transaction } from "@/app/lib/db/data-api";

/**
 * A draft's map pin: one immutable map version plus the digest of its browser
 * closure (topology, signals, colliders, ... as published) and the asset
 * catalog version it was published with. Captured when the draft is created or
 * explicitly re-pinned; a revision commit uses exactly this pin and never
 * re-resolves to a newer publication (`docs/engineering/document-pinning.md`).
 */
export type ScenarioMapPin = {
  mapVersionId: string;
  mapClosureSha256: string;
  assetCatalogVersionId: string;
};

type PinRow = {
  id: string;
  closure_sha256: string | null;
  asset_catalog_version_id: string | null;
};

/** Read the pin a map version has right now, or null when it is retired or its closure is not available. */
export async function readScenarioMapPin(
  tx: Pick<Transaction, "queryOne">,
  mapVersionId: string,
): Promise<ScenarioMapPin | null> {
  const row = await tx.queryOne<PinRow>(
    `SELECT mv.id, bs.closure_sha256, mv.asset_catalog_version_id
     FROM simforge.map_versions mv
     JOIN simforge.browser_asset_sets bs ON bs.id = mv.browser_asset_set_id
       AND bs.map_version_id = mv.id AND bs.asset_set_state = 'available'
     WHERE mv.id = :map_version_id AND mv.retired_at IS NULL
     LIMIT 1`,
    { map_version_id: mapVersionId },
  );
  if (!row?.closure_sha256 || !row.asset_catalog_version_id) return null;
  return {
    mapVersionId: row.id,
    mapClosureSha256: row.closure_sha256,
    assetCatalogVersionId: row.asset_catalog_version_id,
  };
}

/**
 * The pin to write for a draft bound to `mapVersionId`. Refuses a version that
 * is retired or has no available closure: a document is never pinned to a map
 * nobody can load.
 */
export async function requireScenarioMapPin(
  tx: Pick<Transaction, "queryOne">,
  mapVersionId: string,
): Promise<ScenarioMapPin> {
  const pin = await readScenarioMapPin(tx, mapVersionId);
  if (!pin) {
    throw new ScenarioMapResolutionError(
      "scenario_map_version_unavailable",
      `Map version ${mapVersionId} is retired or its published closure is unavailable; a scenario cannot be pinned to it.`,
      mapVersionId,
    );
  }
  return pin;
}

/**
 * Verify a draft's pin before a revision freezes it. The pinned version must
 * still be published with the same closure digest and asset catalog; anything
 * else is an explicit error, never a silent substitution. A draft pinned
 * before closure digests were recorded (null digest) adopts the version's
 * current digest, which the one-time pinning migration also writes.
 */
export async function verifyScenarioMapPin(
  tx: Pick<Transaction, "queryOne">,
  pinned: { mapVersionId: string | null; mapClosureSha256?: string | null; assetCatalogVersionId?: string | null },
): Promise<ScenarioMapPin> {
  if (!pinned.mapVersionId) {
    throw new ScenarioMapResolutionError(
      "scenario_map_absent",
      "This scenario is not pinned to a map version; open it in the editor and choose a map before committing.",
      null,
    );
  }
  const current = await requireScenarioMapPin(tx, pinned.mapVersionId);
  if (pinned.mapClosureSha256 && pinned.mapClosureSha256 !== current.mapClosureSha256) {
    throw new ScenarioMapResolutionError(
      "scenario_map_pin_mismatch",
      `Map version ${pinned.mapVersionId} was republished with different content (closure ${current.mapClosureSha256.slice(0, 12)}, pinned ${pinned.mapClosureSha256.slice(0, 12)}). Move the scenario to a map version explicitly before committing.`,
      pinned.mapVersionId,
    );
  }
  if (pinned.assetCatalogVersionId && pinned.assetCatalogVersionId !== current.assetCatalogVersionId) {
    throw new ScenarioMapResolutionError(
      "scenario_map_pin_mismatch",
      `Map version ${pinned.mapVersionId} now names asset catalog ${current.assetCatalogVersionId}, not the pinned ${pinned.assetCatalogVersionId}. Move the scenario to a map version explicitly before committing.`,
      pinned.mapVersionId,
    );
  }
  return current;
}
