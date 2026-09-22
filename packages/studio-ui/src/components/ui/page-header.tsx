"use client";

import type { CSSProperties, ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { useRouteHeader } from "../TopBarSlot";
import { mergeStyleProps } from "../stylex/surface";
import { pageHeader as pageHeaderStyles } from "./layout.stylex";

/** Declares route chrome; only supporting copy belongs in the route body. */
export function PageHeader({ title, description, eyebrow, actions, className, style, xstyle }: {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
  className?: string;
  style?: CSSProperties;
  xstyle?: stylex.StyleXStyles;
}) {
  useRouteHeader({ title, context: eyebrow, actions });
  return description ? <p {...mergeStyleProps(stylex.props(pageHeaderStyles.description, xstyle), className, style)}>{description}</p> : null;
}
