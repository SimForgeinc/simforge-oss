"use client";

import * as stylex from "@stylexjs/stylex";
import { CloudSmoke } from "./CloudSmoke";
import { mergeStyleProps, type XStyle } from "./stylex/surface";
import { styles } from "./SkyCloudBackdrop.stylex";

export function SkyCloudBackdrop({
  className,
  xstyle,
  animated = true,
  assetBase,
}: {
  /**
   * Caller-supplied classes. Reserved for global class names the cascade
   * owns — the loading coordinator's `scene-loader-cloud-*` transition hooks.
   * A caller's own StyleX travels as `xstyle`: two atomic rules for the same
   * property are resolved by stylesheet order, not by argument order, so
   * `position` passed as a class name would be decided by an accident of
   * alphabetical atom ordering.
   */
  className?: string;
  /** Caller StyleX styles, composed after this surface's own so they win. */
  xstyle?: XStyle;
  animated?: boolean;
  assetBase?: string;
}) {
  return (
    <div
      aria-hidden="true"
      {...mergeStyleProps(stylex.props(styles.root, xstyle), className)}
      data-testid="sky-cloud-backdrop"
    >
      <CloudSmoke animated={animated} assetBase={assetBase} />
    </div>
  );
}
