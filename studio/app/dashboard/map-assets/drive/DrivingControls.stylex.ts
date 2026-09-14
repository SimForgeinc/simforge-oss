import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  // pointer-events-auto w-full shadow-xl
  drivingControlsCard: {
    pointerEvents: "auto",
    width: "100%",
    boxShadow: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
  },
  // space-y-3 p-3
  cardcontent: {
    padding: space.lg,
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
  },
  // flex flex-wrap items-center gap-2
  divFlex: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.md,
  },
  // flex rounded-md border border-border p-0.5
  drivingInputMode: {
    display: "flex",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.border,
    padding: space.xxs,
  },
  // flex-1
  div: {
    flex: "1 1 0%",
  },
  // grid grid-cols-3 gap-2 text-[10px] uppercase tracking-wide text-muted-foreground
  liveDrivingInput: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: space.md,
    fontSize: "10px",
    textTransform: "uppercase",
    letterSpacing: "0.025em",
    color: colors.mutedForeground,
  },
  // text-xs text-muted-foreground
  drivingPauseReason: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // text-xs text-destructive
  alert: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.danger,
  },
  // text-xs text-muted-foreground
  pXs: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // flex justify-between
  divFlex2: {
    display: "flex",
    justifyContent: "space-between",
  },
  // font-mono normal-case text-foreground
  spanMono: {
    fontFamily: text.fontMono,
    textTransform: "none",
    color: colors.text,
  },
  // relative mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted
  divRelative: {
    position: "relative",
    marginTop: space.xs,
    height: space.sm,
    width: "100%",
    overflow: "hidden",
    backgroundColor: colors.muted,
  },
  // absolute inset-y-0 left-1/2 w-px bg-border
  divAbsolute: {
    position: "absolute",
    top: "0",
    bottom: "0",
    left: "50%",
    width: "1px",
    backgroundColor: colors.border,
  },
  // absolute inset-y-0 bg-primary
  divAbsolute2: {
    position: "absolute",
    top: "0",
    bottom: "0",
    backgroundColor: colors.primary,
  },
  // text-xs text-destructive
  alert2: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.danger,
  },
  // space-y-3 text-xs
  divXs: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
  },
  // space-y-1
  div2: {
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
  },
  // h-8 text-xs
  selectmenuXs: {
    height: space.xxxl,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // text-muted-foreground
  p: {
    color: colors.mutedForeground,
  },
  // space-y-2
  wheelBindings: {
    display: "flex",
    flexDirection: "column",
    gap: space.md,
  },
  // flex items-center gap-1
  labelFlex: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
  },
  // space-y-1 rounded-md border border-border p-2
  wheelCalibration: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.border,
    padding: space.md,
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
  },
  // font-medium text-foreground
  pMedium: {
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  // font-mono text-muted-foreground
  raw: {
    fontFamily: text.fontMono,
    color: colors.mutedForeground,
  },
  // flex gap-2
  divFlex3: {
    display: "flex",
    gap: space.md,
  },
  // font-mono text-[10px] text-muted-foreground
  wheelRaw: {
    fontFamily: text.fontMono,
    fontSize: "10px",
    color: colors.mutedForeground,
  },
  // flex flex-wrap items-center gap-2
  divFlex4: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.md,
  },
  // w-16 font-medium text-foreground
  spanMedium: {
    width: "4rem",
    fontWeight: text.weightMedium,
    color: colors.text,
  },
  // w-14 font-mono text-muted-foreground
  spanMono2: {
    width: "3.5rem",
    fontFamily: text.fontMono,
    color: colors.mutedForeground,
  },
  // flex items-center gap-1 text-muted-foreground
  deadzone: {
    display: "flex",
    alignItems: "center",
    gap: space.xs,
    color: colors.mutedForeground,
  },
  // h-1.5 w-16 cursor-pointer appearance-none rounded-full bg-muted accent-primary
  input: {
    height: space.sm,
    width: "4rem",
    cursor: "pointer",
    appearance: "none",
    backgroundColor: colors.muted,
    accentColor: colors.primary,
  },
  // font-mono
  spanMono3: {
    fontFamily: text.fontMono,
  },
});
