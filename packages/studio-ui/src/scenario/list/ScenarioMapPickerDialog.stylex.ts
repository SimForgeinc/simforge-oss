import * as stylex from "@stylexjs/stylex";
import { colors, layers, motion, shadows, space, stroke, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // fixed inset-0 z-[100] flex items-center justify-center
  divFixedFlex: {
    position: "fixed",
    inset: "0",
    zIndex: layers.dropdown,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  // absolute inset-0 bg-black/55 backdrop-blur-md
  closeMapPickerButton: {
    position: "absolute",
    inset: "0",
    backgroundColor: "rgb(0 0 0 / 0.55)",
    backdropFilter: motion.blurGlass,
  },
  // relative flex h-[80vh] w-[80vw] flex-col overflow-hidden border border-border bg-background shadow-2xl
  selectMap: {
    position: "relative",
    display: "flex",
    height: "80vh",
    width: "80vw",
    flexDirection: "column",
    overflow: "hidden",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    boxShadow: shadows.elevation2xl,
  },
  // flex shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-6 py-4
  divFlex: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s4,
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.bg,
    paddingInline: space.s6,
    paddingBlock: space.s4,
  },
  // min-w-0
  div: {
    minWidth: 0,
  },
  // font-heavy text-base font-bold uppercase tracking-meta-narrow text-foreground
  selectMap2: {
    fontFamily: text.fontHeavy,
    fontSize: text.sizeBase,
    lineHeight: text.lineBase,
    fontWeight: text.weightBold,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaNarrow,
    color: colors.text,
  },
  // mt-0.5 text-xs text-muted-foreground
  pXs: {
    marginTop: space.s0_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // flex min-w-0 items-center gap-3
  divFlex2: {
    display: "flex",
    minWidth: 0,
    alignItems: "center",
    gap: space.s3,
  },
  // relative w-[min(360px,40vw)]
  divRelative: {
    position: "relative",
    width: "min(360px,40vw)",
  },
  // pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground
  searchAbsoluteIcon: {
    pointerEvents: "none",
    position: "absolute",
    left: space.s3,
    top: "50%",
    width: space.s4,
    height: space.s4,
    transform: "translateY(-50%)",
    color: colors.mutedForeground,
  },
  // size-5
  xIcon: {
    width: "1.25rem",
    height: "1.25rem",
  },
  // min-h-0 flex-1 overflow-y-auto px-6 py-6
  div2: {
    minHeight: 0,
    flex: "1 1 0%",
    overflowY: "auto",
    paddingInline: space.s6,
    paddingBlock: space.s6,
  },
  // flex h-full items-center justify-center text-sm text-muted-foreground
  divFlexSm: {
    display: "flex",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    color: colors.mutedForeground,
  },
  // mx-auto grid max-w-7xl gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4
  divGrid: {
    marginInline: "auto",
    display: "grid",
    maxWidth: "80rem",
    gap: space.s4,
    gridTemplateColumns: { default: null, "@media (min-width: 640px)": "repeat(2, minmax(0, 1fr))", "@media (min-width: 1024px)": "repeat(3, minmax(0, 1fr))", "@media (min-width: 1280px)": "repeat(4, minmax(0, 1fr))" },
  },
  // relative aspect-[4/3] w-full overflow-hidden bg-muted/30
  divRelative2: {
    position: "relative",
    aspectRatio: "4 / 3",
    width: "100%",
    overflow: "hidden",
    backgroundColor: "hsl(var(--muted) / 0.3)",
  },
  // h-full w-full bg-gradient-to-br from-muted via-muted/60 to-muted/30
  div3: {
    height: "100%",
    width: "100%",
    backgroundImage: `linear-gradient(to bottom right, ${colors.muted}, hsl(var(--muted) / 0.6), hsl(var(--muted) / 0.3))`,
  },
  // absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent
  divAbsolute: {
    position: "absolute",
    inset: "0",
    backgroundImage: `linear-gradient(to top, rgb(0 0 0 / 0.85), rgb(0 0 0 / 0.3), transparent)`,
  },
  // absolute right-3 top-3 flex items-center gap-1.5 bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground
  divAbsoluteFlexXs: {
    position: "absolute",
    right: space.s3,
    top: space.s3,
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    backgroundColor: colors.primary,
    paddingInline: space.s3,
    paddingBlock: space.s1,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightSemibold,
    color: colors.primaryForeground,
  },
  // size-3.5
  currentCheck: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // absolute inset-x-0 bottom-0 p-4
  divAbsolute2: {
    position: "absolute",
    left: "0",
    right: "0",
    bottom: "0",
    padding: space.s4,
  },
  // mb-1 flex items-center gap-1.5
  divFlex3: {
    marginBottom: space.s1,
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
  },
  // size-3 shrink-0 text-white/70
  mappinIcon: {
    width: space.s3,
    height: space.s3,
    flexShrink: 0,
    color: colors.inkSecondary,
  },
  // truncate text-xs text-white/70
  pTruncateXs: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.inkSecondary,
  },
  // line-clamp-2 text-base font-bold leading-tight text-white
  pBaseBold: {
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    fontSize: text.sizeBase,
    lineHeight: text.lineTight,
    fontWeight: text.weightBold,
    color: colors.ink,
  },
  // px-4 py-3
  div4: {
    paddingInline: space.s4,
    paddingBlock: space.s3,
  },
});
