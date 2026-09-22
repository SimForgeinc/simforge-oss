import * as stylex from "@stylexjs/stylex";
import { colors, space, stroke, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex shrink-0 items-center justify-end gap-1
  divFlex: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space.s1,
  },
  // size-3.5
  morehorizontalIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // mr-2 size-3.5
  downloadJSONDownload: {
    marginRight: space.s2,
    width: "0.875rem",
    height: "0.875rem",
  },
  // mr-2 size-3.5
  editDetailsPencil: {
    marginRight: space.s2,
    width: "0.875rem",
    height: "0.875rem",
  },
  // mr-2 size-3.5
  duplicateCopyPlus: {
    marginRight: space.s2,
    width: "0.875rem",
    height: "0.875rem",
  },
  transferMapPin: {
    marginRight: space.s2,
    width: "0.875rem",
    height: "0.875rem",
  },
  // mr-2 size-3.5
  deleteTrash2: {
    marginRight: space.s2,
    width: "0.875rem",
    height: "0.875rem",
  },
  // h-7 w-28 border border-primary/40 bg-background px-1.5 text-xs font-medium text-foreground outline-none focus:border-primary
  renameInput: {
    height: "1.75rem",
    width: "7rem",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: { default: colors.accentLineSubtle, ":focus": colors.primary },
    backgroundColor: colors.bg,
    paddingInline: space.s1_5,
    fontSize: text.sizeXs,
    lineHeight: text.lineXs,
    fontWeight: text.weightMedium,
    color: colors.text,
    outline: "2px solid transparent",
    outlineOffset: "2px",
  },
  // size-3.5
  pencilIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // size-3.5
  gamepadIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // size-3.5
  gitbranchIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // absolute -right-0.5 -top-0.5 flex min-w-3 items-center justify-center bg-primary px-0.5 font-meta text-micro font-bold leading-3 text-primary-foreground
  spanAbsoluteFlexMeta: {
    position: "absolute",
    right: `calc(-1 * ${space.s0_5})`,
    top: `calc(-1 * ${space.s0_5})`,
    display: "flex",
    minWidth: space.s3,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
    paddingInline: space.s0_5,
    fontFamily: text.fontMeta,
    fontSize: text.sizeMicro,
    lineHeight: "0.75rem",
    fontWeight: text.weightBold,
    color: colors.primaryForeground,
  },
  // size-3.5
  videoIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // min-w-0 flex-1
  div: {
    minWidth: 0,
    flex: "1 1 0%",
  },
  // mt-1 mr-1 inline-flex rounded-full border border-sky-400/45 bg-sky-400/10 px-1.5 py-0.5 font-meta text-[9px] uppercase tracking-meta-tight text-sky-300
  variation: {
    marginTop: space.s1,
    marginRight: space.s1,
    display: "inline-flex",
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.info,
    backgroundColor: colors.infoWash,
    paddingInline: space.s1_5,
    paddingBlock: space.s0_5,
    color: colors.info,
  },
  // mt-1 line-clamp-2 text-[12px] leading-snug text-white/70
  div2: {
    marginTop: space.s1,
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
    fontSize: text.sizeXs,
    lineHeight: text.lineSnug,
    color: colors.inkSecondary,
  },
  // mt-2 flex flex-wrap gap-1.5
  tagsFor: {
    marginTop: space.s2,
    display: "flex",
    flexWrap: "wrap",
    gap: space.s1_5,
  },
  // rounded-full border border-primary/70 bg-primary/15 px-2 py-0.5 font-meta text-[9px] uppercase tracking-meta-tight text-primary
  letGoToApplyTag: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    borderColor: colors.accentLine,
    backgroundColor: colors.accentWash,
    paddingInline: space.s2,
    paddingBlock: space.s0_5,
    color: colors.primary,
  },
  // rounded-full border px-2 py-0.5 font-meta text-[9px] uppercase tracking-meta-tight
  spanMetaUppercase: {
    borderWidth: stroke.hairline,
    borderStyle: "solid",
    paddingInline: space.s2,
    paddingBlock: space.s0_5,
  },
  // rounded-full border border-dashed border-border px-2 py-0.5 font-meta text-[9px] uppercase tracking-meta-tight text-muted-foreground
  authoredInTheScenarioContent: {
    borderWidth: stroke.hairline,
    borderStyle: "dashed",
    borderColor: colors.hairline,
    paddingInline: space.s2,
    paddingBlock: space.s0_5,
    color: colors.mutedForeground,
  },
  // mt-1 flex flex-col gap-0.5 font-meta text-micro uppercase tracking-meta text-white/70
  divFlexMetaMicro: {
    marginTop: space.s1,
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    color: colors.inkSecondary,
  },
});
