import * as stylex from "@stylexjs/stylex";
import { colors, layers, space, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // ml-4 border-l border-primary/30
  div: {
    marginLeft: space.xl,
    borderLeftWidth: "1px",
    borderLeftStyle: "solid",
    borderColor: "hsl(var(--primary) / 0.3)",
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
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: colors.border,
    paddingInline: space.lg,
    paddingBlock: space.lg,
  },
  // border-l border-primary/60 pl-3 text-xs text-foreground
  thisIsASharedOrReadOnlyDatas: {
    borderLeftWidth: "1px",
    borderLeftStyle: "solid",
    borderColor: "hsl(var(--primary) / 0.6)",
    paddingLeft: space.lg,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.text,
  },
  // min-h-0 flex-1 overflow-y-auto
  scenarioDocumentList: {
    minHeight: 0,
    flex: "1 1 0%",
    overflowY: "auto",
  },
  // border-b border-white/10 px-3 py-4 text-sm text-muted-foreground
  divSm: {
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    paddingInline: space.lg,
    paddingBlock: space.xl,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
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
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    padding: space.lg,
  },
  // min-w-0
  div5: {
    minWidth: 0,
  },
  // truncate text-sm font-semibold text-foreground
  divTruncateSmSemibold: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
    color: colors.text,
  },
  // mt-1 font-meta text-micro uppercase tracking-meta-widest text-white/70
  divMetaMicroUppercase: {
    marginTop: space.xs,
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWidest,
    color: "rgb(255 255 255 / 0.7)",
  },
  // size-4
  chevrondownIcon: {
    width: space.xl,
    height: space.xl,
  },
  // space-y-0 border-t border-white/10
  div6: {
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderColor: "rgb(255 255 255 / 0.1)",
    display: "flex",
    flexDirection: "column",
    gap: "0",
  },
  // space-y-3
  div7: {
    display: "flex",
    flexDirection: "column",
    gap: space.lg,
  },
  // relative space-y-1.5
  sectionRelative: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
  },
  // flex items-center justify-between gap-2
  divFlex2: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
  },
  // flex items-center gap-2 font-meta text-micro uppercase tracking-meta-widest text-muted-foreground
  divFlexMetaMicro: {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWidest,
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
    width: space.lg,
    height: space.lg,
  },
  // absolute right-0 top-8 z-30 w-full space-y-1.5 border border-primary/40 bg-popover p-1.5 shadow-lg
  scenarioTagCreateForm: {
    position: "absolute",
    right: "0",
    top: space.xxxl,
    zIndex: layers.sticky,
    width: "100%",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--primary) / 0.4)",
    backgroundColor: colors.popover,
    padding: space.sm,
    boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
  },
  // flex gap-1.5
  divFlex3: {
    display: "flex",
    gap: space.sm,
  },
  // space-y-1.5
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
  },
  // font-meta text-micro uppercase tracking-meta-widest text-muted-foreground
  divMetaMicroUppercase2: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWidest,
    color: colors.mutedForeground,
  },
  // text-meta leading-4 text-muted-foreground
  pMeta: {
    fontSize: text.sizeMeta,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // flex flex-col gap-1.5
  divFlex4: {
    display: "flex",
    flexDirection: "column",
    gap: space.sm,
  },
  // border border-dashed border-border px-2 py-3 text-xs text-muted-foreground
  divXs: {
    borderWidth: "1px",
    borderStyle: "dashed",
    borderColor: colors.border,
    paddingInline: space.md,
    paddingBlock: space.lg,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.mutedForeground,
  },
  // h-6 min-w-0 flex-1 border border-primary/50 bg-background px-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  renameTheInput: {
    height: space.xxl,
    minWidth: 0,
    flex: "1 1 0%",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "hsl(var(--primary) / 0.5)",
    backgroundColor: colors.bg,
    paddingInline: space.sm,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.text,
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px ${colors.ring}` },
  },
  // min-w-0 flex-1 truncate text-left
  buttonTruncate: {
    minWidth: 0,
    flex: "1 1 0%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textAlign: "left",
  },
  // relative
  divRelative: {
    position: "relative",
  },
  // flex size-6 items-center justify-center text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  tagActionsForButton: {
    display: "flex",
    width: space.xxl,
    height: space.xxl,
    alignItems: "center",
    justifyContent: "center",
    color: { default: colors.mutedForeground, ":hover": colors.text },
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px ${colors.ring}` },
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
    zIndex: 40,
    width: "8rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: colors.popover,
    padding: space.xs,
    color: "hsl(var(--popover-foreground))",
    boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    display: "flex",
    flexDirection: "column",
    gap: space.xs,
  },
  // flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  buttonFlexXs: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.md,
    paddingInline: space.md,
    paddingBlock: space.sm,
    textAlign: "left",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.text,
    backgroundColor: { default: null, ":hover": "hsl(var(--accent))" },
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px ${colors.ring}` },
  },
  // size-3
  renamePencil: {
    width: space.lg,
    height: space.lg,
  },
  // flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
  buttonFlexXs2: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: space.md,
    paddingInline: space.md,
    paddingBlock: space.sm,
    textAlign: "left",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: colors.danger,
    backgroundColor: { default: null, ":hover": "hsl(var(--destructive) / 0.1)" },
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    boxShadow: { default: null, ":focus-visible": `0 0 0 2px ${colors.ring}` },
  },
  // size-3
  deleteTrash2: {
    width: space.lg,
    height: space.lg,
  },
  // font-meta text-micro uppercase tracking-meta text-muted-foreground
  showing: {
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: text.lineMicro,
    textTransform: "uppercase",
    letterSpacing: text.trackingMeta,
    color: colors.mutedForeground,
  },
  // flex flex-wrap gap-1
  group: {
    display: "flex",
    flexWrap: "wrap",
    gap: space.xs,
  },
});
