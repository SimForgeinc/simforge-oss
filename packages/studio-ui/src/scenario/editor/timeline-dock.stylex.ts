import * as stylex from "@stylexjs/stylex";
import { layers } from "../../stylex/tokens.stylex";
export const styles = stylex.create({
  dock: { position: "relative", minWidth: 0 },
  handle: { position: "absolute", top: 0, bottom: 0, zIndex: layers.dropdown, width: "12px", cursor: "ew-resize", touchAction: "none" },
  left: { left: "-6px" },
  right: { right: "-6px" },
  marker: { pointerEvents: "none", position: "absolute", top: "20px", bottom: "20px", left: "50%", width: "1px", transform: "translateX(-50%)", borderRadius: "9999px", backgroundColor: "rgba(255,255,255,0.3)", boxShadow: "0 0 10px rgba(255,255,255,0.12)", transition: "background-color 80ms ease" },
});
