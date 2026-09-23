"use client";

import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { PaneErrorState } from "../../components/state-frames";
import { DRIVING_REQUIREMENT_LABELS, type DrivingInputRequirement } from "../input-kinds";
import { styles as s } from "./evaluation-components.stylex";
import { hairline } from "../../stylex/recipes.stylex";


export function RefusalNotice({
  tone = "refusal", title, reasons = [], missing = [], missingFieldPaths = [], children, action, xstyle,
}: {
  tone?: "refusal" | "warn" | "info";
  title: string;
  reasons?: readonly string[];
  missing?: readonly DrivingInputRequirement[];
  missingFieldPaths?: readonly string[];
  children?: ReactNode;
  action?: ReactNode;
  xstyle?: stylex.StyleXStyles;
}) {
  const description = <>
          {reasons.length > 0 ? <ul {...stylex.props(s.section1, s.textSm, s.leading6, s.textMuted)}>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
          {missing.length > 0 ? <div {...stylex.props(s.textSm, s.leading6, s.textMuted)}><p>This input is missing:</p><ul {...stylex.props(s.mt1, s.list, s.stack05)}>{missing.map((requirement) => <li key={requirement}>{DRIVING_REQUIREMENT_LABELS[requirement]}</li>)}</ul><p>Nothing is substituted for missing driving inputs — a fabricated camera view, ego pose or label would make the numbers meaningless.</p></div> : null}
          {missingFieldPaths.length > 0 ? <div {...stylex.props(s.textSm, s.leading6, s.textMuted)}><p>The run reported these fields missing from the input:</p><ul {...stylex.props(s.mt1, s.list, s.stack05, s.mono, s.textXs)}>{missingFieldPaths.map((path) => <li key={path}>{path}</li>)}</ul></div> : null}
          {children}
          {action}
  </>;
  return <div data-testid="refusal-notice">
    {tone === "info" ? <section {...stylex.props(hairline.all, s.p4, s.info, xstyle)}>
      <h2 {...stylex.props(s.textSm, s.fontSemibold)}>{title}</h2>
      {description}
    </section> : <PaneErrorState xstyle={xstyle} title={title} description={description} />}
  </div>;
}
