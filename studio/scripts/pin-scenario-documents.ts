/**
 * One-time document pinning (docs/engineering/document-pinning.md).
 *
 * For every stored draft without a `simulation` block, write:
 *   - `simulation: { seed: <the template id it resolves to today>, dtS: 0.02 }`;
 *   - the legacy ambient default (City, `ambient-1`) where it names no profile;
 * then recompute `content_sha256` with the canonical serializer and bump
 * `draft_version`, so open editors refetch the pinned content instead of saving
 * over it. The resolved simulation input of every pinned draft is unchanged.
 * Immutable revisions are never touched.
 *
 * Run it only against a host whose code already reads the `simulation` block:
 * an older server or compiler rejects a pinned document as an unknown key.
 *
 *   tsx studio/scripts/pin-scenario-documents.ts            # dry run: counts only
 *   tsx studio/scripts/pin-scenario-documents.ts --apply    # write
 *
 * Idempotent: a pinned draft is skipped. Each draft is written under an
 * optimistic `draft_version` guard, so a concurrent edit wins and is retried by
 * a re-run.
 */
import { pinStoredDocument } from "../app/lib/scenario/document-pinning";
import { canonicalContentSha256 } from "../app/lib/scenario/core";
import { queryRows, shutdownDatabase } from "../app/lib/db/data-api";

type DraftRow = { document_id: string; workspace_id: string; draft_version: number; canonical_content: string | Record<string, unknown> };

export type PinSummary = {
  scanned: number;
  alreadyPinned: number;
  pinned: number;
  addedAmbientProfile: number;
  invalidAmbientProfile: string[];
  unparseable: string[];
  raced: string[];
};

export async function pinScenarioDocuments(options: { apply: boolean; pageSize?: number }): Promise<PinSummary> {
  const summary: PinSummary = { scanned: 0, alreadyPinned: 0, pinned: 0, addedAmbientProfile: 0, invalidAmbientProfile: [], unparseable: [], raced: [] };
  // Small pages: the Aurora Data API refuses a result over 1 MB, and a draft can be tens of KB.
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
      const outcome = pinStoredDocument(raw);
      if (outcome.kind === "unchanged") { summary.alreadyPinned += 1; continue; }
      if (outcome.kind === "unparseable") { summary.unparseable.push(row.document_id); continue; }
      if (outcome.kind === "invalid_ambient_profile") { summary.invalidAmbientProfile.push(row.document_id); continue; }
      summary.pinned += 1;
      if (outcome.addedAmbientProfile) summary.addedAmbientProfile += 1;
      if (!options.apply) continue;
      const updated = await queryRows<{ document_id: string }>(
        `UPDATE simforge.drafts
            SET canonical_content = CAST(:content AS jsonb),
                content_sha256 = :content_sha256,
                draft_version = draft_version + 1,
                updated_at = NOW()
          WHERE document_id = :document_id AND workspace_id = :workspace_id
            AND draft_version = :draft_version
            AND NOT (canonical_content ? 'simulation')
          RETURNING document_id`,
        {
          content: outcome.content,
          content_sha256: canonicalContentSha256(outcome.content),
          document_id: row.document_id,
          workspace_id: row.workspace_id,
          draft_version: Number(row.draft_version),
        },
      );
      if (updated.length === 0) summary.raced.push(row.document_id);
    }
    after = rows[rows.length - 1]!.document_id;
  }
  return summary;
}

async function main() {
  const apply = process.argv.includes("--apply");
  try {
    const summary = await pinScenarioDocuments({ apply });
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

