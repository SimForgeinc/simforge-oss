import * as stylex from "@stylexjs/stylex";
import { colors, motion, shadows, space, stroke, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-4 backdrop-blur
  fixedFlexCenter: {
    position: "fixed",
    inset: 0,
    zIndex: "50",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "hsl(var(--background) / 0.9)",
    padding: space.s4,
    backdropFilter: motion.blurMd,
  },
  // flex h-[85vh] w-full max-w-[1200px] flex-col overflow-hidden border border-border bg-card shadow-2xl
  flexColBordered: {
    display: "flex",
    height: "85vh",
    width: "100%",
    maxWidth: "1200px",
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: stroke.hairline,
    borderColor: colors.hairline,
    backgroundColor: colors.card,
    boxShadow: shadows.elevation2xl,
  },
  // flex items-center gap-3 border-b border-border px-5 py-3
  flexCenterRuleB: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    borderBottomWidth: stroke.hairline,
    borderColor: colors.hairline,
    paddingLeft: space.s5,
    paddingRight: space.s5,
    paddingTop: space.s3,
    paddingBottom: space.s3,
  },
  // min-w-0 flex-1
  fillNarrowable: {
    minWidth: "0px",
    flex: "1 1 0%",
  },
  // truncate text-micro uppercase tracking-meta text-muted-foreground
  capsMicroMuted: {
    color: colors.mutedForeground,
  },
  // truncate text-sm font-semibold text-card-foreground
  smSemiboldTruncate: {
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
    color: "hsl(var(--card-foreground))",
  },
  // size-4
  size4: {
    width: "1rem",
    height: "1rem",
  },
  // relative min-h-0 flex-1 bg-background
  relFillShrinkable: {
    position: "relative",
    minHeight: "0px",
    flex: "1 1 0%",
    backgroundColor: colors.bg,
  },
  // grid size-full place-items-center text-meta uppercase tracking-meta text-muted-foreground
  gridCenteredCaps: {
    display: "grid",
    width: "100%",
    height: "100%",
    placeItems: "center",
    color: colors.mutedForeground,
  },
  // size-full object-contain
  fullContain: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
});
