import * as stylex from "@stylexjs/stylex";
import { layers, space, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // pointer-events-none absolute right-4 top-4 z-10 max-w-sm
  scenarioIdleStatus: {
    pointerEvents: "none",
    position: "absolute",
    right: space.xl,
    top: space.xl,
    zIndex: layers.raised,
    maxWidth: "24rem",
  },
  // inline-flex rounded-md border border-black/10 bg-white/90 px-3 py-2 text-xs font-medium text-black/65 shadow-sm backdrop-blur-md
  spanXsMedium: {
    display: "inline-flex",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "rgb(0 0 0 / 0.1)",
    backgroundColor: "rgb(255 255 255 / 0.9)",
    paddingInline: space.lg,
    paddingBlock: space.md,
    fontSize: text.sizeXs,
    lineHeight: "1rem",
    fontWeight: text.weightMedium,
    color: "rgb(0 0 0 / 0.65)",
    boxShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    backdropFilter: "blur(12px)",
  },
  // pointer-events-auto absolute bottom-4 right-4 z-10 w-[min(760px,calc(100%_-_2rem))]
  scenarioPreviewTimelineAncho: {
    pointerEvents: "auto",
    position: "absolute",
    bottom: space.xl,
    right: space.xl,
    zIndex: layers.raised,
    width: "min(760px,calc(100% - 2rem))",
  },
});
