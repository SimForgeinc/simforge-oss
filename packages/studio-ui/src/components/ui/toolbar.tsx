import * as React from "react";
import * as stylex from "@stylexjs/stylex";

import { mergeStyleProps } from "../stylex/surface";
import { toolbar as toolbarStyles } from "./layout.stylex";

type ToolbarStyle = stylex.StyleXStyles;
type ToolbarProps = React.HTMLAttributes<HTMLDivElement> & { xstyle?: ToolbarStyle };

export function Toolbar({ className, style, xstyle, ...props }: ToolbarProps) {
  return <div {...props} {...mergeStyleProps(stylex.props(toolbarStyles.root, xstyle), className, style)} />;
}

export function ToolbarGroup({ className, style, xstyle, ...props }: ToolbarProps) {
  return <div {...props} {...mergeStyleProps(stylex.props(toolbarStyles.group, xstyle), className, style)} />;
}
