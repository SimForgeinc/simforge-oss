import type { CSSProperties, ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { mergeStyleProps } from "../stylex/surface";
import { styles } from "./empty-state.stylex";

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  style,
  xstyle,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  style?: CSSProperties;
  xstyle?: stylex.StyleXStyles;
}) {
  const root = stylex.props(styles.root, xstyle);
  return (
    <div {...mergeStyleProps(root, className, style)}>
      {icon ? <div {...stylex.props(styles.icon)}>{icon}</div> : null}
      <h2 {...stylex.props(styles.title)}>{title}</h2>
      {description ? <p {...stylex.props(styles.description)}>{description}</p> : null}
      {action ? <div {...stylex.props(styles.action)}>{action}</div> : null}
    </div>
  );
}
