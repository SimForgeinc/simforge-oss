"use client";

import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { AlertTriangle, Ban, Info } from "lucide-react";
import { cn } from "../../lib/utils";
import { DRIVING_REQUIREMENT_LABELS, type DrivingInputRequirement } from "../input-kinds";
import { styles as s } from "./evaluation-components.stylex";

const TONE_STYLES = {
  refusal: { container: s.refusal, icon: s.iconDestructive },
  warn: { container: s.warn, icon: s.iconWarn },
  info: { container: s.info, icon: s.textMuted },
} as const;

export function RefusalNotice({
  tone = "refusal", title, reasons = [], missing = [], missingFieldPaths = [], children, action, className,
}: {
  tone?: keyof typeof TONE_STYLES;
  title: string;
  reasons?: readonly string[];
  missing?: readonly DrivingInputRequirement[];
  missingFieldPaths?: readonly string[];
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const toneStyles = TONE_STYLES[tone];
  const Icon = tone === "refusal" ? Ban : tone === "warn" ? AlertTriangle : Info;
  const root = stylex.props(s.border, s.p4, toneStyles.container);
  return (
    <div role={tone === "info" ? undefined : "alert"} className={cn(root.className, className)} style={root.style} data-testid="refusal-notice">
      <div {...stylex.props(s.flexNoAlignGap3)}>
        <Icon aria-hidden="true" {...stylex.props(s.icon, toneStyles.icon)} />
        <div {...stylex.props(s.min0, s.flex1, s.stack2)}>
          <p {...stylex.props(s.textSm, s.fontSemibold)}>{title}</p>
          {reasons.length > 0 ? <ul {...stylex.props(s.section1, s.textSm, s.leading6, s.textMuted)}>{reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul> : null}
          {missing.length > 0 ? <div {...stylex.props(s.textSm, s.leading6, s.textMuted)}><p>This input is missing:</p><ul {...stylex.props(s.mt1, s.list, s.stack05)}>{missing.map((requirement) => <li key={requirement}>{DRIVING_REQUIREMENT_LABELS[requirement]}</li>)}</ul><p>Nothing is substituted for missing driving inputs — a fabricated camera view, ego pose or label would make the numbers meaningless.</p></div> : null}
          {missingFieldPaths.length > 0 ? <div {...stylex.props(s.textSm, s.leading6, s.textMuted)}><p>The run reported these fields missing from the input:</p><ul {...stylex.props(s.mt1, s.list, s.stack05, s.mono, s.textXs)}>{missingFieldPaths.map((path) => <li key={path}>{path}</li>)}</ul></div> : null}
          {children}
          {action ? <div style={{ paddingTop: "0.25rem" }}>{action}</div> : null}
        </div>
      </div>
    </div>
  );
}
