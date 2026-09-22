import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  status: { display: "inline-flex", alignItems: "center", borderWidth: stroke.hairline, borderStyle: "solid", borderColor: "transparent", paddingInline: space.s2, paddingBlock: space.s0_5, fontSize: text.sizeXs, lineHeight: text.lineXs, textTransform: "capitalize" },
  queued: { backgroundColor: colors.muted, color: colors.mutedForeground },
  /** `bg-blue-500/15 text-blue-600 dark:text-blue-400` — the shell is permanently dark, so the dark value is folded. */
  running: { backgroundColor: "rgba(59,130,246,.15)", color: "rgb(96,165,250)" },
  /** `bg-emerald-500/15 text-emerald-600 dark:text-emerald-400` — dark value folded. */
  complete: { backgroundColor: "rgba(16,185,129,.15)", color: colors.positive },
  failed: { backgroundColor: "rgba(239,68,68,.15)", color: colors.danger },
  message: { display: "flex", height: "10rem", alignItems: "center", justifyContent: "center", paddingInline: space.s4, textAlign: "center", fontSize: text.sizeSm, lineHeight: text.lineSm, color: colors.mutedForeground },
});
