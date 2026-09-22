import { ScenarioMapResolutionError } from "@simforge-oss/studio-host";
import type { Transaction } from "@/app/lib/db/data-api";

/**
 * A draft's map pin: one immutable map version, the digest of the SIMULATION
 * members of its published closure (see `SIMULATION_CLOSURE_MEMBERS_SQL`), and
 * the asset catalog version it was published with. Captured when the draft is
 * created or explicitly re-pinned; a revision commit uses exactly this pin and
 * never re-resolves to a newer publication (`docs/engineering/document-pinning.md`).
 *
 * The pin covers what a simulation reads (OpenDRIVE, topology, derived index,
 * locations, signals, static colliders), not the whole browser closure: a
 * republication that only adds derived members (a SUMO network, an ambient
 * turn-verdict table, new texture tiers) must not strand every pinned draft.
 */
export type ScenarioMapPin = {
  mapVersionId: string;
  mapClosureSha256: string;
  assetCatalogVersionId: string;
};

/**
 * `simforge.map-pin-closure/v1`: sha256 over `"<relative path> <sha256>\n"`
 * lines, in byte order of path, for the simulation members of an asset set.
 * `:set` names the asset set.
 */
export const SIMULATION_CLOSURE_SHA256_SQL = `(
  SELECT encode(sha256(convert_to(string_agg(pin_m.relative_path || ' ' || pin_b.sha256 || E'\\n', '' ORDER BY pin_m.relative_path COLLATE "C"), 'UTF8')), 'hex')
    FROM simforge.browser_asset_members pin_m
    JOIN simforge.browser_asset_blobs pin_b ON pin_b.id = pin_m.blob_id
   WHERE pin_m.asset_set_id = %SET%
     AND (pin_m.relative_path IN ('map.xodr', 'topology-index.json.gz', 'signals.geojson.gz',
                                  'derived/topology-derived.json.gz', 'derived/locations.json.gz')
          OR pin_m.relative_path LIKE '3d/variants/static-colliders%')
)`;

const simulationClosureOf = (setColumn: string) => SIMULATION_CLOSURE_SHA256_SQL.replace("%SET%", setColumn);

type PinRow = {
  id: string;
  simulation_closure_sha256: string | null;
  asset_catalog_version_id: string | null;
  /** Browser closure digests of this version's publications with the same simulation members (legacy pins). */
  equivalent_browser_closures: string[] | string | null;
};

type ReadPin = ScenarioMapPin & { equivalentLegacyPins: readonly string[] };

/** Read the pin a map version has right now, or null when it is retired or its closure is not available. */
export async function readScenarioMapPin(
  tx: Pick<Transaction, "queryOne">,
  mapVersionId: string,
): Promise<ReadPin | null> {
  const row = await tx.queryOne<PinRow>(
    `WITH current_pin AS (
       SELECT mv.id, mv.asset_catalog_version_id, ${simulationClosureOf("bs.id")} AS simulation_closure_sha256
         FROM simforge.map_versions mv
         JOIN simforge.browser_asset_sets bs ON bs.id = mv.browser_asset_set_id
           AND bs.map_version_id = mv.id AND bs.asset_set_state = 'available'
        WHERE mv.id = :map_version_id AND mv.retired_at IS NULL
        LIMIT 1
     )
     SELECT p.id, p.simulation_closure_sha256, p.asset_catalog_version_id,
       (SELECT COALESCE(json_agg(other.closure_sha256), '[]'::json)
          FROM simforge.browser_asset_sets other
         WHERE other.map_version_id = p.id
           AND ${simulationClosureOf("other.id")} = p.simulation_closure_sha256) AS equivalent_browser_closures
       FROM current_pin p`,
    { map_version_id: mapVersionId },
  );
  if (!row?.simulation_closure_sha256 || !row.asset_catalog_version_id) return null;
  const legacy = typeof row.equivalent_browser_closures === "string"
    ? JSON.parse(row.equivalent_browser_closures) as string[]
    : row.equivalent_browser_closures ?? [];
  return {
    mapVersionId: row.id,
    mapClosureSha256: row.simulation_closure_sha256,
    assetCatalogVersionId: row.asset_catalog_version_id,
    equivalentLegacyPins: legacy,
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
  const read = await readScenarioMapPin(tx, mapVersionId);
  const pin = read && { mapVersionId: read.mapVersionId, mapClosureSha256: read.mapClosureSha256, assetCatalogVersionId: read.assetCatalogVersionId };
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
  const current = await readScenarioMapPin(tx, pinned.mapVersionId);
  if (!current) {
    throw new ScenarioMapResolutionError(
      "scenario_map_version_unavailable",
      `Map version ${pinned.mapVersionId} is retired or its published closure is unavailable; a scenario cannot be pinned to it.`,
      pinned.mapVersionId,
    );
  }
  // A pin written before pins covered only the simulation members holds a
  // browser-closure digest: it still matches when that publication carried
  // the same simulation members as today's.
  const matches = !pinned.mapClosureSha256
    || pinned.mapClosureSha256 === current.mapClosureSha256
    || current.equivalentLegacyPins.includes(pinned.mapClosureSha256);
  if (!matches) {
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
  return { mapVersionId: current.mapVersionId, mapClosureSha256: current.mapClosureSha256, assetCatalogVersionId: current.assetCatalogVersionId };
}
