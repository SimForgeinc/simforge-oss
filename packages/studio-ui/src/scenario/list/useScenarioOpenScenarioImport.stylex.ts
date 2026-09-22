import * as stylex from "@stylexjs/stylex";
import { colors, layers, space, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // fixed inset-0 z-50 flex items-center justify-center px-4
  divFixedFlex: {
    position: "fixed",
    inset: "0",
    zIndex: layers.popover,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingInline: space.s4,
  },
  // absolute inset-0 bg-black/70 backdrop-blur-sm
  closeOpenSCENARIODialogButton: {
    position: "absolute",
    inset: "0",
    backgroundColor: "rgb(0 0 0 / 0.7)",
    backdropFilter: "blur(4px)",
  },
  // relative z-10 max-h-[88vh] w-full max-w-2xl space-y-4 overflow-y-auto border border-border bg-background p-6 shadow-2xl
  xoscImportDialog: {
    position: "relative",
    zIndex: layers.raised,
    maxHeight: "88vh",
    width: "100%",
    maxWidth: "42rem",
    overflowY: "auto",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    padding: space.s6,
    boxShadow: "0 25px 50px -12px rgb(0 0 0 / 0.25)",
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
  },
  // text-lg font-semibold text-foreground
  xoscImportTitle: {
    fontSize: text.sizeLg,
    lineHeight: "1.75rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // mt-1 text-sm text-muted-foreground
  createANewScenarioFromThePar: {
    marginTop: space.s1,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: colors.mutedForeground,
  },
  // hidden
  chooseOpenSCENARIOFileInput: {
    display: "none",
  },
  // size-4
  fileupIcon: {
    width: space.s4,
    height: space.s4,
  },
  // border border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive
  alert: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--destructive) / 0.6)",
    backgroundColor: "hsl(var(--destructive) / 0.1)",
    padding: space.s3,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    color: colors.danger,
  },
  // space-y-4
  xoscImportReport: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
  },
  // grid gap-2 border border-border bg-surface-deep p-3 text-sm sm:grid-cols-2
  divGridSm: {
    display: "grid",
    gap: space.s2,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.surfaceDeep,
    padding: space.s3,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    gridTemplateColumns: { default: null, "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))" },
  },
  // text-muted-foreground
  format: {
    color: colors.mutedForeground,
  },
  // text-muted-foreground
  size: {
    color: colors.mutedForeground,
  },
  // sm:col-span-2 break-all
  div: {
    gridColumn: { default: null, "@media (min-width: 640px)": "span 2 / span 2" },
    wordBreak: "break-all",
  },
  // text-muted-foreground
  sha256: {
    color: colors.mutedForeground,
  },
  // space-y-2
  div2: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
  },
  // flex items-center gap-2 text-sm font-medium
  divFlexSmMedium: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightMedium,
  },
  // size-4 text-emerald-500
  checkcircle2Icon: {
    width: space.s4,
    height: space.s4,
    color: "rgb(16 185 129 / 1)",
  },
  // size-4 text-amber-500
  alerttriangleIcon: {
    width: space.s4,
    height: space.s4,
    color: "rgb(245 158 11 / 1)",
  },
  // block text-sm
  labelSm: {
    display: "block",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
  },
  // mb-1 block text-muted-foreground
  map: {
    marginBottom: space.s1,
    display: "block",
    color: colors.mutedForeground,
  },
  // h-10 w-full border border-input bg-background px-3
  resolvedMapSelect: {
    height: "2.5rem",
    width: "100%",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--input))",
    backgroundColor: colors.bg,
    paddingInline: space.s3,
  },
  // text-xs text-amber-600
  multipleMapsMatchedNoMapWasS: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(217 119 6 / 1)",
  },
  // text-xs text-amber-600
  noKnownMapMatchedSelectTheIn: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: "rgb(217 119 6 / 1)",
  },
  // text-xs text-destructive
  theFileContainsContradictory: {
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.danger,
  },
  // border border-border p-3
  xoscConversionSummary: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.border,
    padding: space.s3,
  },
  // text-sm font-semibold
  whatWillBeConverted: {
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
  },
  // mt-2 space-y-1 text-xs
  ulXs: {
    marginTop: space.s2,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  // mt-3 flex items-start gap-2 text-xs
  labelFlexXs: {
    marginTop: space.s3,
    display: "flex",
    alignItems: "flex-start",
    gap: space.s2,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // mt-0.5 size-4
  xoscUnsupportedAcknowledgemeInput: {
    marginTop: space.s0_5,
    width: space.s4,
    height: space.s4,
  },
  // cursor-pointer text-sm font-medium
  technicalConversionDetails: {
    cursor: "pointer",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightMedium,
  },
  // mt-2 space-y-2
  openscenarioImportDiagnostic: {
    marginTop: space.s2,
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
  },
  // border border-border p-2 text-xs
  liXs: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.border,
    padding: space.s2,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
  },
  // font-mono
  divMono: {
    fontFamily: text.fontMono,
  },
  // mt-1 text-muted-foreground
  div3: {
    marginTop: space.s1,
    color: colors.mutedForeground,
  },
  // flex justify-end gap-2
  divFlex: {
    display: "flex",
    justifyContent: "flex-end",
    gap: space.s2,
  },
});
