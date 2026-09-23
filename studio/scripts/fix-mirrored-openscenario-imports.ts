/**
 * One-time repair of drafts written by the OpenSCENARIO importer before
 * b79130bb, which placed every actor mirrored north <-> south (F-01,
 * docs/engineering/openscenario-conformance.md). The detection and the repair
 * are `detectMirroredOpenScenarioImport` / `fixMirroredOpenScenarioImport`
 * (`@simforge-oss/scenario`); read their docblock for which roles are flipped
 * and the residual risks.
 *
 * For every live draft whose content carries `extensions.openScenarioImport`
 * and no `mirrorFix` marker, print the plan (document, workspace, draft version,
 * each moved role with its z before and after, the roles kept and why). With
 * `--apply`, write the repaired content, recompute `content_sha256` with the
 * canonical serializer and bump `draft_version`, under an optimistic
 * `draft_version` guard: a concurrent edit wins and is picked up by a re-run.
 * An editor that has the document open gets a version conflict on its next
 * save instead of silently writing the mirrored poses back.
 *
 * Immutable revisions are never touched; their counts are printed so a reviewer
 * knows which documents have committed mirrored revisions.
 *
 *   tsx studio/scripts/fix-mirrored-openscenario-imports.ts                    # dry run
 *   tsx studio/scripts/fix-mirrored-openscenario-imports.ts --document=uscn_…  # one document (repeatable)
 *   tsx studio/scripts/fix-mirrored-openscenario-imports.ts --apply            # write
 *
 * The database is whatever the Studio data layer is configured for
 * (`DATABASE_URL`, else the local database under `SIMFORGE_CLOUD_ROOT`), exactly
 * as for `pin-scenario-documents.ts`.
 *
 * Idempotent: a repaired draft carries `mirrorFix` and is skipped.
 */
import {
  fixMirroredOpenScenarioImport,
  parseTemplate,
  type MirroredImportDetection,
  type ScenarioTemplateV2,
} from "@simforge-oss/scenario";

import { canonicalContentSha256 } from "../app/lib/scenario/core";
import { queryRows, shutdownDatabase } from "@/app/lib/db/data-api";

type DraftRow = {
  document_id: string;
  workspace_id: string;
  draft_version: number | string;
  canonical_content: string | Record<string, unknown>;
  revision_count: number | string;
};

export type MirrorFixDocumentPlan = {
  documentId: string;
  workspaceId: string;
  draftVersion: number;
  revisions: number;
  status: MirroredImportDetection["status"] | "unparseable";
  roles: { id: string; zBefore: number; zAfter: number }[];
  kept: { id: string; reason: string }[];
  detail?: string;
};

export type MirrorFixSummary = {
  mode: "dry-run" | "apply";
  scanned: number;
  affected: number;
  written: number;
  alreadyFixed: number;
  fixedImporter: number;
  nothingToFix: number;
  ambiguous: string[];
  unparseable: string[];
  raced: string[];
  documents: MirrorFixDocumentPlan[];
};

/** Candidate drafts: live documents whose content has the import provenance block. */
const CANDIDATES_SQL = `
  SELECT d.document_id, d.workspace_id, d.draft_version, d.canonical_content::text AS canonical_content,
         (SELECT COUNT(*) FROM simforge.revisions r WHERE r.document_id = d.document_id) AS revision_count
    FROM simforge.drafts d
    JOIN simforge.documents doc ON doc.id = d.document_id AND doc.workspace_id = d.workspace_id
   WHERE doc.deleted_at IS NULL
     AND (d.canonical_content -> 'extensions' -> 'openScenarioImport') IS NOT NULL
     AND d.document_id > :after`;

export async function fixMirroredOpenScenarioImports(options: {
  apply: boolean;
  documentIds?: readonly string[];
  pageSize?: number;
  now?: Date;
  log?: (line: string) => void;
}): Promise<MirrorFixSummary> {
  const log = options.log ?? (() => {});
  const now = options.now ?? new Date();
  const only = options.documentIds?.length ? new Set(options.documentIds) : null;
  const summary: MirrorFixSummary = {
    mode: options.apply ? "apply" : "dry-run",
    scanned: 0, affected: 0, written: 0, alreadyFixed: 0, fixedImporter: 0, nothingToFix: 0,
    ambiguous: [], unparseable: [], raced: [], documents: [],
  };
  // Small pages: the Aurora Data API refuses a result over 1 MB, and a draft can be tens of KB.
  const pageSize = options.pageSize ?? 10;
  let after = "";
  for (;;) {
    const rows = await queryRows<DraftRow>(`${CANDIDATES_SQL} ORDER BY d.document_id LIMIT ${pageSize}`, { after });
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.document_id;
    for (const row of rows) {
      if (only && !only.has(row.document_id)) continue;
      summary.scanned += 1;
      const plan: MirrorFixDocumentPlan = {
        documentId: row.document_id,
        workspaceId: row.workspace_id,
        draftVersion: Number(row.draft_version),
        revisions: Number(row.revision_count),
        status: "not_imported",
        roles: [],
        kept: [],
      };
      summary.documents.push(plan);
      const raw: unknown = typeof row.canonical_content === "string" ? JSON.parse(row.canonical_content) : row.canonical_content;
      const result = fixMirroredOpenScenarioImport(raw, now);
      const detection = result.detection;
      plan.status = detection.status;
      if ("flips" in detection) plan.roles = detection.flips.map((flip) => ({ id: flip.id, zBefore: flip.before.z, zAfter: flip.after.z }));
      if ("skipped" in detection) plan.kept = detection.skipped.map(({ id, reason }) => ({ id, reason }));
      if (detection.status === "ambiguous") plan.detail = detection.reason;
      if (detection.status === "fixed_importer") plan.detail = `fixed-importer evidence: ${detection.evidence.join(", ")}`;

      if (result.changed) {
        try {
          parseTemplate(result.document);
        } catch (error) {
          plan.status = "unparseable";
          plan.detail = error instanceof Error ? error.message : String(error);
        }
      }
      printPlan(plan, log);

      switch (plan.status) {
        case "already_fixed": summary.alreadyFixed += 1; continue;
        case "fixed_importer": summary.fixedImporter += 1; continue;
        case "nothing_to_fix": summary.nothingToFix += 1; continue;
        case "ambiguous": summary.ambiguous.push(row.document_id); continue;
        case "unparseable": summary.unparseable.push(row.document_id); continue;
        case "not_imported": continue;
        case "affected": break;
      }
      summary.affected += 1;
      if (!options.apply || !result.changed) continue;
      const updated = await queryRows<{ document_id: string }>(
        `UPDATE simforge.drafts
            SET canonical_content = CAST(:content AS jsonb),
                content_sha256 = :content_sha256,
                draft_version = draft_version + 1,
                updated_at = NOW()
          WHERE document_id = :document_id AND workspace_id = :workspace_id
            AND draft_version = :draft_version
            AND (canonical_content -> 'extensions' -> 'openScenarioImport' -> 'mirrorFix') IS NULL
          RETURNING document_id`,
        {
          content: result.document as ScenarioTemplateV2,
          content_sha256: canonicalContentSha256(result.document as ScenarioTemplateV2),
          document_id: row.document_id,
          workspace_id: row.workspace_id,
          draft_version: plan.draftVersion,
        },
      );
      if (updated.length === 0) summary.raced.push(row.document_id);
      else summary.written += 1;
    }
  }
  return summary;
}

function printPlan(plan: MirrorFixDocumentPlan, log: (line: string) => void): void {
  log(
    `${plan.documentId}  workspace=${plan.workspaceId}  draft_version=${plan.draftVersion}  ` +
    `revisions=${plan.revisions} (immutable, not rewritten)  status=${plan.status}` +
    (plan.detail ? `  (${plan.detail})` : ""),
  );
  for (const role of plan.roles) log(`    flip ${role.id}: z ${role.zBefore} -> ${role.zAfter}`);
  for (const role of plan.kept) log(`    keep ${role.id}: ${role.reason}`);
}

function documentIdsFromArgs(argv: readonly string[]): string[] {
  return argv.filter((arg) => arg.startsWith("--document=")).map((arg) => arg.slice("--document=".length)).filter(Boolean);
}

async function main() {
  const apply = process.argv.includes("--apply");
  try {
    const { documents: _documents, ...summary } = await fixMirroredOpenScenarioImports({
      apply,
      documentIds: documentIdsFromArgs(process.argv.slice(2)),
      log: (line) => console.log(line),
    });
    console.log(JSON.stringify(summary, null, 2));
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
