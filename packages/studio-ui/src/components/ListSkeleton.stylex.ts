import * as stylex from "@stylexjs/stylex";
import { colors, space } from "../stylex/tokens.stylex";
const pulse = stylex.keyframes({ "0%, 100%": { opacity: 0.45 }, "50%": { opacity: 1 } });
export const styles = stylex.create({
  root: { minWidth: 0, minHeight: 0, overflow: "hidden", padding: space.xl },
  row: { display: "grid", gap: space.md, paddingBlock: space.lg, animationName: { default: pulse, "@media (prefers-reduced-motion: reduce)": "none" }, animationDuration: "1.5s", animationIterationCount: "infinite" },
  title: { width: "75%", height: space.xl, backgroundColor: colors.chip },
  detail: { width: "45%", height: space.md, backgroundColor: colors.glassRaised },
});
