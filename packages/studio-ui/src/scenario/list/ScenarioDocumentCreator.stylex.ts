import * as stylex from "@stylexjs/stylex";
import { colors, layers, shadows, space, stroke, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // ml-4 border-l border-primary/30
  div: {
    marginLeft: space.s4,
    borderLeftWidth: stroke.hairline,
    borderLeftStyle: "solid",
    borderColor: colors.accentLineSubtle,
  },
  // flex min-h-0 min-w-0 flex-1 flex-col
  divFlex: {
    display: "flex",
    minHeight: 0,
    minWidth: 0,
    flex: "1 1 0%",
    flexDirection: "column",
  },
  // border-b border-border px-3 py-3
  div2: {
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderColor: colors.hairline,
    paddingInline: space.s3,
    paddingBlock: space.s3,
  },
  // border-l border-primary/60 pl-3 text-xs text-foreground
  thisIsASharedOrReadOnlyDatas: {
    borderLeftWidth: stroke.hairline,
    borderLeftStyle: "solid",
    borderColor: colors.accentLine,
    paddingLeft: space.s3,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.text,
  },
  /** The column's scroller (`scroll.y`): the list moves, the column header above it does not. */
  scenarioDocumentList: {
    minHeight: 0,
    flex: "1 1 0%",
  },
  // border-b border-white/10 px-3 py-4 text-sm text-muted-foreground
  divSm: {
    borderBottomWidth: stroke.hairline,
    borderBottomStyle: "solid",
    borderColor: colors.hairline,
    paddingInline: space.s3,
    paddingBlock: space.s4,
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    color: colors.mutedForeground,
  },
  // space-y-0
  div3: {
    display: "flex",
    flexDirection: "column",
    gap: "0",
  },
  // border-t border-white/10 p-3
  div4: {
    borderTopWidth: stroke.hairline,
    borderTopStyle: "solid",
    borderColor: colors.hairline,
    padding: space.s3,
  },
  // min-w-0
  div5: {
    minWidth: 0,
  },
  // truncate text-sm font-semibold text-foreground
  divTruncateSmSemibold: {
    fontSize: text.sizeSm,
    lineHeight: text.lineSm,
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // mt-1 font-meta text-micro uppercase tracking-meta-widest text-white/70
  divMetaMicroUppercase: {
    marginTop: space.s1,
    color: colors.inkSecondary,
  },
  // size-4
  chevrondownIcon: {
    width: space.s4,
    height: space.s4,
  },
  // space-y-0 border-t border-white/10
  div6: {
    borderTopWidth: stroke.hairline,
    borderTopStyle: "solid",
    borderColor: colors.hairline,
    display: "flex",
    flexDirection: "column",
    gap: "0",
  },
  // space-y-3
  div7: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
  },
  // relative space-y-1.5
  sectionRelative: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
  },
  // flex items-center justify-between gap-2
  divFlex2: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
  },
  // flex items-center gap-2 font-meta text-micro uppercase tracking-meta-widest text-muted-foreground
  divFlexMetaMicro: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    color: colors.mutedForeground,
  },
  // size-3.5 text-primary
  tagsIcon: {
    width: "0.875rem",
    height: "0.875rem",
    color: colors.primary,
  },
  // size-3
  plusIcon: {
    width: space.s3,
    height: space.s3,
  },
  // absolute right-0 top-8 z-30 w-full space-y-1.5 border border-primary/40 bg-popover p-1.5 shadow-lg
  scenarioTagCreateForm: {
    position: "absolute",
    right: "0",
    top: space.s8,
    zIndex: layers.sticky,
    width: "100%",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.accentLineSubtle,
    backgroundColor: colors.popover,
    padding: space.s1_5,
    boxShadow: shadows.elevationLg,
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
  },
  // flex gap-1.5
  divFlex3: {
    display: "flex",
    gap: space.s1_5,
  },
  // space-y-1.5
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
  },
  // font-meta text-micro uppercase tracking-meta-widest text-muted-foreground
  divMetaMicroUppercase2: {
    color: colors.mutedForeground,
  },
  // text-meta leading-4 text-muted-foreground
  pMeta: {
    fontSize: text.sizeMeta,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // flex flex-col gap-1.5
  divFlex4: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
  },
  // border border-dashed border-border px-2 py-3 text-xs text-muted-foreground
  divXs: {
    borderWidth: stroke.hairline,
    borderStyle: "dashed",
    borderColor: colors.hairline,
    paddingInline: space.s2,
    paddingBlock: space.s3,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.mutedForeground,
  },
  // h-6 min-w-0 flex-1 border border-primary/50 bg-background px-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  renameTheInput: {
    height: space.s6,
    minWidth: 0,
    flex: "1 1 0%",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.accentLine,
    backgroundColor: colors.bg,
    paddingInline: space.s1_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.text,
  },
  // min-w-0 flex-1 truncate text-left
  buttonTruncate: {
    minWidth: 0,
    flex: "1 1 0%",
    textAlign: "left",
  },
  // relative
  divRelative: {
    position: "relative",
  },
  // flex size-6 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  tagActionsForButton: {
    display: "flex",
    width: space.s6,
    height: space.s6,
    alignItems: "center",
    justifyContent: "center",
    color: { default: colors.mutedForeground, ":hover": colors.text },
  },
  // size-3.5
  morehorizontalIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // absolute right-0 top-7 z-40 w-32 space-y-1 border border-border bg-popover p-1 text-popover-foreground shadow-lg
  divAbsolute: {
    position: "absolute",
    right: "0",
    top: "1.75rem",
    zIndex: layers.overlay,
    width: "8rem",
    backgroundColor: colors.popover,
    padding: space.s1,
    color: "hsl(var(--popover-foreground))",
    boxShadow: shadows.elevationLg,
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  // flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  buttonFlexXs: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s2,
    paddingInline: space.s2,
    paddingBlock: space.s1_5,
    textAlign: "left",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.text,
    backgroundColor: { default: null, ":hover": colors.hoverWash },
  },
  // size-3
  renamePencil: {
    width: space.s3,
    height: space.s3,
  },
  // flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  buttonFlexXs2: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.s2,
    paddingInline: space.s2,
    paddingBlock: space.s1_5,
    textAlign: "left",
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    color: colors.danger,
    backgroundColor: { default: null, ":hover": colors.criticalWash },
  },
  // size-3
  deleteTrash2: {
    width: space.s3,
    height: space.s3,
  },
  // font-meta text-micro uppercase tracking-meta text-muted-foreground
  showing: {
    color: colors.mutedForeground,
  },
  // flex flex-wrap gap-1
  group: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.s1,
  },
});
