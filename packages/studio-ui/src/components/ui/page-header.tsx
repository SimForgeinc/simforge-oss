import type { CSSProperties, ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";

import { mergeStyleProps } from "../stylex/surface";
import { pageHeader as pageHeaderStyles } from "./layout.stylex";

type PageHeaderStyle = stylex.StyleXStyles;

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className,
  style,
  xstyle,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
  className?: string;
  style?: CSSProperties;
  xstyle?: PageHeaderStyle;
}) {
  return (
    <header {...mergeStyleProps(stylex.props(pageHeaderStyles.root, xstyle), className, style)}>
      <div {...stylex.props(pageHeaderStyles.row)}>
        <div {...stylex.props(pageHeaderStyles.content)}>
          {eyebrow ? <p {...stylex.props(pageHeaderStyles.eyebrow)}>{eyebrow}</p> : null}
          <h1 {...stylex.props(pageHeaderStyles.title)}>{title}</h1>
          {description ? <p {...stylex.props(pageHeaderStyles.description)}>{description}</p> : null}
        </div>
        {actions ? <div {...stylex.props(pageHeaderStyles.actions)}>{actions}</div> : null}
      </div>
    </header>
  );
}
