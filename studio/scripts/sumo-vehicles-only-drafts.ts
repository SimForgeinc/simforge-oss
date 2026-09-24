/**
 * One-time repair: SUMO drafts that still ask for pedestrians or cyclists
 * (see `sumoVehiclesOnlyStoredDocument` and docs/engineering/no-silent-fallbacks.md).
 *
 * The editor records a vehicles-only profile whenever SUMO is chosen; drafts
 * saved before that carry a preset's road-user shares and fail server
 * simulation with `sumo_road_user_share_unsupported`. For each such draft this
 * writes `pedestrianShare: 0, cyclistShare: 0` into its stored profile,
 * recomputes `content_sha256` with the canonical serializer and bumps
 * `draft_version`, so open editors refetch instead of saving over it. Every
 * change is listed (document id and the shares it removed). Immutable
 * revisions are never touched.
 *
 *   tsx studio/scripts/sumo-vehicles-only-drafts.ts            # dry run: lists what would change
 *   tsx studio/scripts/sumo-vehicles-only-drafts.ts --apply    # write
 *
 * Idempotent: a repaired draft is unchanged on the next run. Each write is
 * guarded by `draft_version`, so a concurrent edit wins and a re-run retries.
 */
import { canonicalContentSha256 } from "../app/lib/scenario/core";
import { sumoVehiclesOnlyStoredDocument } from "../app/lib/scenario/sumo-vehicles-only";
import { queryRows, shutdownDatabase } from "@/app/lib/db/data-api";

type DraftRow = { document_id: string; workspace_id: string; draft_version: number; canonical_content: string | Record<string, unknown> };

export type SumoVehiclesOnlySummary = {
  scanned: number;
  unchanged: number;
  updated: { documentId: string; pedestrianShare: number; cyclistShare: number }[];
  invalidAmbientProfile: string[];
  unparseable: string[];
  raced: string[];
};

export async function sumoVehiclesOnlyDrafts(options: { apply: boolean; pageSize?: number }): Promise<SumoVehiclesOnlySummary> {
  const summary: SumoVehiclesOnlySummary = { scanned: 0, unchanged: 0, updated: [], invalidAmbientProfile: [], unparseable: [], raced: [] };
  // Small pages: the Aurora Data API refuses a result over 1 MB.
  const pageSize = options.pageSize ?? 10;
  let after = "";
  for (;;) {
    const rows = await queryRows<DraftRow>(
      `SELECT document_id, workspace_id, draft_version, canonical_content::text AS canonical_content
         FROM simforge.drafts
        WHERE document_id > :after
        ORDER BY document_id
        LIMIT ${pageSize}`,
      { after },
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      summary.scanned += 1;
      const raw = typeof row.canonical_content === "string" ? JSON.parse(row.canonical_content) : row.canonical_content;
      const outcome = sumoVehiclesOnlyStoredDocument(raw);
      if (outcome.kind === "unchanged") { summary.unchanged += 1; continue; }
      if (outcome.kind === "unparseable") { summary.unparseable.push(row.document_id); continue; }
      if (outcome.kind === "invalid_ambient_profile") { summary.invalidAmbientProfile.push(row.document_id); continue; }
      if (options.apply) {
        const written = await queryRows<{ document_id: string }>(
          `UPDATE simforge.drafts
              SET canonical_content = CAST(:content AS jsonb),
                  content_sha256 = :content_sha256,
                  draft_version = draft_version + 1,
                  updated_at = NOW()
            WHERE document_id = :document_id AND workspace_id = :workspace_id
              AND draft_version = :draft_version
            RETURNING document_id`,
          {
            content: outcome.content,
            content_sha256: canonicalContentSha256(outcome.content),
            document_id: row.document_id,
            workspace_id: row.workspace_id,
            draft_version: Number(row.draft_version),
          },
        );
        if (written.length === 0) { summary.raced.push(row.document_id); continue; }
      }
      summary.updated.push({ documentId: row.document_id, pedestrianShare: outcome.pedestrianShare, cyclistShare: outcome.cyclistShare });
    }
    after = rows[rows.length - 1]!.document_id;
  }
  return summary;
}

async function main() {
  const apply = process.argv.includes("--apply");
  try {
    const summary = await sumoVehiclesOnlyDrafts({ apply });
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...summary }, null, 2));
  } finally {
    await shutdownDatabase();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
