import * as stylex from "@stylexjs/stylex";
import { colors, layers, space, text } from "../../stylex/tokens.stylex";

export const styles = stylex.create({
  // pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-[inherit]
  scenarioPreviewTimelineGlass: {
    pointerEvents: "none",
    position: "absolute",
    inset: "0",
    zIndex: 0,
    overflow: "hidden",
  },
  // absolute inset-0 bg-gradient-to-br from-white/[0.11] via-white/[0.025] to-black/10
  divAbsolute: {
    position: "absolute",
    inset: "0",
    backgroundImage: `linear-gradient(to bottom right, rgb(255 255 255 / 0.11), rgb(255 255 255 / 0.025), rgb(0 0 0 / 0.1))`,
  },
  // absolute -left-8 -top-14 size-28 rounded-full bg-[#E8E044]/10 blur-3xl
  divAbsoluteIcon: {
    position: "absolute",
    left: `calc(-1 * ${space.xxxl})`,
    top: "-3.5rem",
    width: "7rem",
    height: "7rem",
    backgroundColor: "rgb(232 224 68 / 0.1)",
    filter: "blur(64px)",
  },
  // absolute inset-x-4 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent
  divAbsolute2: {
    position: "absolute",
    left: space.xl,
    right: space.xl,
    top: "0",
    height: "1px",
    backgroundImage: `linear-gradient(to right, transparent, rgb(255 255 255 / 0.55), transparent)`,
  },
  // relative z-10 grid size-8 shrink-0 place-items-center rounded-full border-0 bg-transparent p-0 text-white/85 shadow-none transition-[color,transform] hover:scale-110 hover:bg-transparent hover:text-[#E8E044] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]/70 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:scale-100
  buttonRelativeGridIcon: {
    position: "relative",
    zIndex: layers.raised,
    display: "grid",
    width: space.xxxl,
    height: space.xxxl,
    flexShrink: 0,
    placeItems: "center",
    borderWidth: 0,
    backgroundColor: { default: "transparent", ":hover": "transparent" },
    padding: "0",
    color: { default: "rgb(255 255 255 / 0.85)", ":hover": colors.accent },
    boxShadow: { default: "none", ":focus-visible": `0 0 0 2px rgb(232 224 68 / 0.7)` },
    transitionProperty: "color , transform",
    transitionDuration: "150ms",
    transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)",
    transform: { default: null, ":hover": "scale(1.1)", ":disabled:hover": "scale(1)" },
    outline: { default: null, ":focus-visible": "2px solid transparent" },
    outlineOffset: { default: null, ":focus-visible": "2px" },
    cursor: { default: null, ":disabled": "not-allowed" },
    opacity: { default: null, ":disabled": 0.45 },
  },
  // size-4 fill-current
  pauseIcon: {
    width: space.xl,
    height: space.xl,
    fill: "currentColor",
  },
  // ml-0.5 size-4 fill-current
  playIcon: {
    marginLeft: space.xxs,
    width: space.xl,
    height: space.xl,
    fill: "currentColor",
  },
  // relative z-10 flex min-w-0 flex-1 items-center
  divRelativeFlex: {
    position: "relative",
    zIndex: layers.raised,
    display: "flex",
    minWidth: 0,
    flex: "1 1 0%",
    alignItems: "center",
  },
  // relative z-10 h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-white/20 accent-[#E8E044] [&::-moz-range-progress]:h-1.5 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-[#E8E044] [&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-black [&::-moz-range-thumb]:bg-[#E8E044] [&::-webkit-slider-thumb]:mt-[-3px] [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-black [&::-webkit-slider-thumb]:bg-[#E8E044] [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full disabled:cursor-not-allowed disabled:opacity-45
  scenarioPreviewTimeInput: {
    position: "relative",
    zIndex: layers.raised,
    height: space.sm,
    minWidth: 0,
    flex: "1 1 0%",
    cursor: { default: "pointer", ":disabled": "not-allowed" },
    appearance: "none",
    backgroundColor: "rgb(255 255 255 / 0.2)",
    accentColor: colors.accent,
    "::-moz-range-progress": { height: space.sm, backgroundColor: colors.accent },
    "::-moz-range-thumb": { width: space.lg, height: space.lg, borderWidth: "2px", borderColor: "rgb(0 0 0 / 1)", backgroundColor: colors.accent },
    "::-webkit-slider-thumb": { marginTop: "-3px", width: space.lg, height: space.lg, appearance: "none", borderWidth: "2px", borderColor: "rgb(0 0 0 / 1)", backgroundColor: colors.accent },
    "::-webkit-slider-runnable-track": { height: space.sm },
    opacity: { default: null, ":disabled": 0.45 },
  },
  // pointer-events-none absolute inset-x-0 top-1/2 h-3 -translate-y-1/2
  scenarioPreviewCutMarkers: {
    pointerEvents: "none",
    position: "absolute",
    left: "0",
    right: "0",
    top: "50%",
    height: space.lg,
    transform: "translateY(-50%)",
  },
  // absolute top-0 h-3 w-px -translate-x-1/2 bg-white/45
  spanAbsolute: {
    position: "absolute",
    top: "0",
    height: space.lg,
    width: "1px",
    transform: "translateX(-50%)",
    backgroundColor: "rgb(255 255 255 / 0.45)",
  },
  // relative z-10 shrink-0 font-mono text-[9px] tabular-nums text-white/65
  spanRelativeMono: {
    position: "relative",
    zIndex: layers.raised,
    flexShrink: 0,
    fontFamily: text.fontMono,
    fontSize: "9px",
    fontVariantNumeric: "tabular-nums",
    color: "rgb(255 255 255 / 0.65)",
  },
  // size-3.5
  clapperboardIcon: {
    width: "0.875rem",
    height: "0.875rem",
  },
});
