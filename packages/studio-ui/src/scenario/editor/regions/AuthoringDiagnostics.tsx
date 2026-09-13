"use client";

import type { EditorDocument } from "@simforge-oss/editor";
import { Readout } from "./Readout";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./AuthoringDiagnostics.stylex";

/**
 * OWNS: the document's validation summary.
 *
 * It reports counts *and* the first issue's text, because a count alone tells
 * an author that something is wrong without telling them what — and the export
 * path refuses invalid documents, so this is the only place the reason appears
 * before a failed export.
 */
export function AuthoringDiagnostics({ document }: { document: EditorDocument }) {
  const issues = document.validation.issues;
  const errors = issues.filter((issue) => issue.severity === "error").length;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  const portable = document.data.roles.filter(
    (role) => role.kind !== "scene_absolute",
  ).length;
  const mapBound = document.data.roles.length - portable;
  const first = issues[0];

  return (
    <section {...stylex.props(styles.xsRuleT)}>
      <h3 {...stylex.props(styles.capsMutedSemibold)}>
        Authoring diagnostics
      </h3>
      <dl {...stylex.props(styles.gridCols2Gap2)}>
        <Readout label="Errors" value={String(errors)} />
        <Readout label="Warnings" value={String(warnings)} />
        <Readout label="Portable roles" value={String(portable)} />
        <Readout label="Map-bound roles" value={String(mapBound)} />
      </dl>
      <div {...stylex.props(styles.flexWrapMuted)}>
        <span>{Object.keys(document.data.params).length} parameters</span>
        <span>{document.data.variants.length} variants</span>
        <span>{document.data.invariants.length} invariants</span>
      </div>
      {first ? (
        <p
          aria-live="polite"
          {...stylex.props(styles.firstIssue, errors ? styles.firstIssueError : styles.firstIssueWarning)}
          role={errors ? "alert" : "status"}
        >
          {first.message}
        </p>
      ) : (
        <p
          aria-live="polite"
          {...stylex.props(styles.inkBorderedPad2)}
          role="status"
        >
          Document is structurally valid.
        </p>
      )}
    </section>
  );
}
