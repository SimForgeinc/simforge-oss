"use client";

import { X } from "lucide-react";
import type { EditorDocument } from "@simforge-oss/editor";
import { InvariantEditor } from "../authoring/InvariantEditor";
import { ParameterEditor } from "../authoring/ParameterEditor";
import { VariantEditor } from "../authoring/VariantEditor";
import { AuthoringDiagnostics } from "./AuthoringDiagnostics";
import * as stylex from "@stylexjs/stylex";
import { styles } from "./ScenarioToolsPanel.stylex";

/** Document-global authoring controls, hidden until explicitly requested. */
export function ScenarioToolsPanel({
  onClose,
  document,
}: {
  onClose: () => void;
  document: EditorDocument;
}) {
  return (
    <aside
      aria-label="Scenario tools"
      {...stylex.props(styles.fixedFlexCol)}
      data-testid="scenario-tools-panel"
    >
      <header {...stylex.props(styles.flexCenterTight)}>
        <div>
          <p {...stylex.props(styles.capsBold)}>Scenario tools</p>
          <p {...stylex.props(styles.xs)}>Global document configuration</p>
        </div>
        <button {...stylex.props(styles.gridCenteredPushRight)} aria-label="Close scenario tools" onClick={onClose} type="button">
          <X aria-hidden="true" className={stylex.props(styles.size4).className} />
        </button>
      </header>
      <div {...stylex.props(styles.fillScrollYShrinkable)}>
        <div {...stylex.props(styles.xs2)}>
          <AuthoringDiagnostics document={document} />
          <ParameterEditor document={document} />
          <InvariantEditor document={document} />
          <VariantEditor document={document} />
        </div>
      </div>
    </aside>
  );
}
