import * as stylex from "@stylexjs/stylex";
import { styles } from "./Readout.stylex";
/**
 * A labelled, non-editable value. The inspector's placement figures and the
 * diagnostics counts are both this shape.
 *
 * A definition list rather than two divs: a screen reader then announces
 * "X, 12.40" as one pair instead of two unrelated strings.
 */
export function Readout({
  label,
  value,
  xstyle,
}: {
  label: string;
  value: string;
  /**
   * Caller styles, applied last so they win — the composition seam the StyleX
   * primitives use. It exists because a readout is often a row in a stack, and
   * the stack's spacing has to reach the row: StyleX has no sibling selector,
   * so the margin `space-y-*` used to hand down belongs on the child.
   */
  xstyle?: stylex.StyleXStyles;
}) {
  return (
    <div {...stylex.props(styles.borderedPad2, xstyle)}>
      <dt {...stylex.props(styles.capsMicroMuted)}>
        {label}
      </dt>
      <dd {...stylex.props(styles.monoTruncate)}>{value}</dd>
    </div>
  );
}
