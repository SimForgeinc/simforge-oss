"use client";

import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";

import { SkyCloudBackdrop } from "../SkyCloudBackdrop";
import { useRouteHeader } from "../TopBarSlot";
import { type PlacementStyle } from "../stylex/surface";
import { styles } from "./page-shell.stylex";

export interface PageShellProps {
  /** Shown beside the title in the top bar. */
  eyebrow?: string;
  /** The route's name; the shared top bar renders it. */
  title: string;
  description?: string;
  /** Route actions, rendered in the top bar. */
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
  /**
   * A fixed instrument instead of a document: the body never scrolls, its
   * one row is the frame's height, and the page composes bounded panes that
   * scroll their own lists inside it.
   */
  fill?: boolean;
  xstyle?: PlacementStyle;
}

/**
 * PageShell: the frame of a utility route (Assets, Exports, Settings): the
 * app switcher's cloud backdrop, a bounded centred frame, and one scroller.
 * The shared top bar owns the heading, so the title and actions are
 * published to it rather than rendered here.
 *
 * Nothing inside can make the document scroll: `body` is the only scroller,
 * and its `minmax(0, 1fr)` track lets a pane with an unbreakable row shrink
 * instead of widening the frame past the viewport (the frame clips).
 */
export function PageShell({ eyebrow, title, description, actions, children, testId, fill = false, xstyle }: PageShellProps) {
  useRouteHeader({ title, context: eyebrow, actions });
  return (
    <div {...stylex.props(styles.stage, xstyle)} data-testid={testId} data-app-stage={title}>
      <SkyCloudBackdrop />
      <div {...stylex.props(styles.frame)}>
        <div {...stylex.props(styles.body, fill && styles.bodyFill)} data-testid="app-stage-body">
          {description ? <p {...stylex.props(styles.description)}>{description}</p> : null}
          {children}
        </div>
      </div>
    </div>
  );
}
