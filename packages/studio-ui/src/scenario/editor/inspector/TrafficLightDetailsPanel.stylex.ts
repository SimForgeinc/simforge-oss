import * as stylex from "@stylexjs/stylex";
import { colors, text, space } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // flex flex-col items-center gap-1 text-center
  flexColCenter: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space.xs,
    textAlign: "center",
  },
  // size-9 text-[#E8E044]
  size9Text: {
    width: "2.25rem",
    height: "2.25rem",
    color: colors.accent,
  },
  // text-[9px] uppercase tracking-[0.16em] text-white/40
  caps: {
    fontSize: "9px",
    textTransform: "uppercase",
    letterSpacing: text.trackingMetaWide,
    color: "rgb(255 255 255 / 0.4)",
  },
  // max-w-52 truncate text-xs font-medium text-white
  xsWhiteMedium: {
    maxWidth: "13rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightMedium,
    color: "rgb(255 255 255 / 1)",
  },
  // text-[10px] leading-relaxed text-white/45
  relaxed: {
    fontSize: "10px",
    lineHeight: "1.625",
    color: "rgb(255 255 255 / 0.45)",
  },
  // rounded-lg border border-amber-300/35 bg-amber-300/10 px-2.5 py-2 text-[10px] leading-relaxed text-amber-100
  borderedRelaxed: {
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: "rgb(252 211 77 / 0.35)",
    backgroundColor: "rgb(252 211 77 / 0.1)",
    paddingLeft: "0.625rem",
    paddingRight: "0.625rem",
    paddingTop: space.md,
    paddingBottom: space.md,
    fontSize: "10px",
    lineHeight: "1.625",
    color: "rgb(254 243 199 / 1)",
  },
  // motionStyles.editorMotion + grid size-6 shrink-0 place-items-center rounded-md text-white/40 hover:bg-red-500/15 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300
  gridCenteredTight: {
    display: "grid",
    width: "1.5rem",
    height: "1.5rem",
    flexShrink: "0",
    placeItems: "center",
    borderRadius: "0",
    color: {
      default: "rgb(255 255 255 / 0.4)",
      ":hover": "rgb(252 165 165 / 1)",
    },
    outline: {
      default: null,
      ":focus-visible": "2px solid transparent",
    },
    outlineOffset: {
      default: null,
      ":focus-visible": "2px",
    },
    boxShadow: {
      default: null,
      ":focus-visible": "0 0 0 2px rgb(252 165 165 / 1)",
    },
    backgroundColor: {
      default: null,
      ":hover": "rgb(239 68 68 / 0.15)",
    },
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // motionStyles.editorMotion + flex w-full items-center justify-center gap-2 rounded-lg border border-white/15 px-3 py-2 text-xs text-white/60 hover:border-white/30 hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]
  flexCenterMid: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    borderRadius: "0",
    borderWidth: "1px",
    borderColor: {
      default: "rgb(255 255 255 / 0.15)",
      ":hover": "rgb(255 255 255 / 0.3)",
    },
    paddingLeft: space.lg,
    paddingRight: space.lg,
    paddingTop: space.md,
    paddingBottom: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    color: {
      default: "rgb(255 255 255 / 0.6)",
      ":hover": "rgb(255 255 255 / 1)",
    },
    outline: {
      default: null,
      ":focus-visible": "2px solid transparent",
    },
    outlineOffset: {
      default: null,
      ":focus-visible": "2px",
    },
    boxShadow: {
      default: null,
      ":focus-visible": "0 0 0 2px rgb(232 224 68 / 1)",
    },
    backgroundColor: {
      default: null,
      ":hover": "rgb(255 255 255 / 0.06)",
    },
  },
});
