"use client";

import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { SkyCloudBackdrop } from "@simforge-oss/studio-ui/components/SkyCloudBackdrop";
import { useSetPageTitle } from "@simforge-oss/studio-ui/components/TopBarSlot";
import { styles } from "@/app/components/AppStage.stylex";

/**
 * A utility route rendered as an app-switcher surface rather than a document.
 *
 * The switcher's own backdrop (`SkyCloudBackdrop`, which follows the graphics
 * level) and its centred hairline column, with one rule the switcher's dialog
 * did not need: the stage is exactly as tall as the dashboard's main area and
 * `children` is the only scroller. Settings, Render Settings and SimCloud are
 * therefore the same shape as a tab — you never scroll the page, you scroll a
 * pane inside it.
 */
export function AppStage({
  eyebrow,
  title,
  description,
  actions,
  children,
  ownsHeading = false,
  testId,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  /** Controls that belong to the surface as a whole; sits opposite the title. */
  actions?: ReactNode;
  children: ReactNode;
  /**
   * The surface already carries its own heading, so the stage omits its
   * header and gives the whole frame to `children`. Render Settings does
   * this: it reuses `RenderSelectionPanel`, a complete single-page panel with
   * its own title, and two titles would be one too many.
   */
  ownsHeading?: boolean;
  testId: string;
}) {
  useSetPageTitle(title);

  return (
    <div {...stylex.props(styles.stage)} data-testid={testId} data-app-stage={title}>
      <SkyCloudBackdrop />
      <div {...stylex.props(styles.frame, ownsHeading && styles.frameBare)}>
        {ownsHeading ? null : (
        <header {...stylex.props(styles.head)}>
          <div {...stylex.props(styles.headText)}>
            <p {...stylex.props(styles.eyebrow)}>{eyebrow}</p>
            <h1 {...stylex.props(styles.title)}>{title}</h1>
            {description === undefined ? null : (
              <p {...stylex.props(styles.description)}>{description}</p>
            )}
          </div>
          {actions === undefined ? null : (
            <div {...stylex.props(styles.headAside)}>{actions}</div>
          )}
        </header>
        )}
        <div {...stylex.props(styles.body)} data-testid="app-stage-body">
          {children}
        </div>
      </div>
    </div>
  );
}
