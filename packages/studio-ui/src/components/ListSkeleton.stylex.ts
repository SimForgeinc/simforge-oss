import * as stylex from "@stylexjs/stylex";
import { colors, layout, space } from "../stylex/tokens.stylex";
const pulse = stylex.keyframes({ "0%, 100%": { opacity: 0.45 }, "50%": { opacity: 1 } });
export const styles = stylex.create({
  root: { minWidth: 0, minHeight: 0, overflow: "hidden", padding: space.s4 },
  row: { display: "grid", gap: space.s2, paddingBlock: space.s3, animationName: { default: pulse, [layout.reducedMotion]: "none" }, animationDuration: "1.5s", animationIterationCount: "infinite" },
  title: { width: "75%", height: space.s4, backgroundColor: colors.fillStrong },
  detail: { width: "45%", height: space.s2, backgroundColor: colors.glassRaised },
});
