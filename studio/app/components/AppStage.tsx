"use client";

import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { SkyCloudBackdrop } from "@simforge-oss/studio-ui/components/SkyCloudBackdrop";
import { useRouteHeader } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { styles } from "./AppStage.stylex";

/** Bounded utility frame. Only the body scrolls; the shared top bar owns its heading. */
export function AppStage({ eyebrow, title, description, actions, children, testId, xstyle }: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
  xstyle?: stylex.StyleXStyles;
}) {
  useRouteHeader({ title, context: eyebrow, actions });
  return <div {...stylex.props(styles.stage, xstyle)} data-testid={testId} data-app-stage={title}>
    <SkyCloudBackdrop />
    <div {...stylex.props(styles.frame)}>
      <div {...stylex.props(styles.body)} data-testid="app-stage-body">
        {description ? <p {...stylex.props(styles.description)}>{description}</p> : null}
        {children}
      </div>
    </div>
  </div>;
}
