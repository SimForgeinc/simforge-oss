import * as stylex from "@stylexjs/stylex";
import { colors, layers, layout, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
export { cloudPlate } from "@simforge-oss/studio-ui/components/SkyCloudBackdrop.stylex";
export const logoTransform = stylex.defineVars({ value: "none" });

export const styles = stylex.create({
  // Inset shadows paint below native no-drag controls rather than intercepting their hit regions.
  header: { position: "relative", zIndex: layers.topbar, display: "flex", height: "3.5rem", width: "100%", flexShrink: 0, alignItems: "center", overflow: "hidden", borderBottom: `1px solid ${colors.lineStrong}`, backgroundColor: colors.overlayScrim, boxShadow: "0 10px 35px rgba(0,0,0,0.24), inset 0 1px 0 rgba(255,255,255,0.10)", backdropFilter: "blur(40px) saturate(0)" },
  clouds: { pointerEvents: "none", position: "absolute", left: "-8%", right: "-8%", top: "-100%", bottom: "-100%" },
  // Respect desktop window controls without reserving space in a browser.
  row: { position: "relative", zIndex: layers.raised, display: "flex", height: "100%", minWidth: 0, marginLeft: "env(titlebar-area-x, 0px)", width: "env(titlebar-area-width, 100%)", alignItems: "center", gap: space.lg, paddingInline: space.lg },
  trigger: { [logoTransform.value]: { default: "none", ":hover": "scale(1.18)", ":focus-visible": "scale(1.18)" }, display: "flex", width: "44px", height: "44px", flexShrink: 0, alignItems: "center", justifyContent: "center", color: colors.accent, backgroundColor: "transparent", outlineColor: colors.ring },
  logo: { display: "flex", alignItems: "center", justifyContent: "center", transform: logoTransform.value, transitionProperty: { default: "transform", "@media (prefers-reduced-motion: reduce)": "none" }, transitionDuration: "200ms" },
  content: { display: "flex", minWidth: 0, flex: 1, alignItems: "center", gap: space.md },
  titleRow: { display: "flex", minWidth: 0, alignItems: "baseline", gap: space.md, overflow: "hidden", whiteSpace: "nowrap", color: colors.textOnPlate },
  brand: { display: { default: "none", [layout.workspaceBreakpoint]: "inline" }, flexShrink: 0, fontSize: text.sizeXl, fontFamily: text.fontHeavy, fontWeight: 700, letterSpacing: "-0.055em" },
  separator: { display: { default: "none", [layout.workspaceBreakpoint]: "inline" }, color: colors.textFaint },
  pageTitle: { margin: 0, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: text.sizeXl, fontWeight: 600, lineHeight: text.lineTight, letterSpacing: "-0.025em", fontFamily: text.fontDisplay },
  context: { display: { default: "none", [layout.workspaceBreakpoint]: "inline" }, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", color: colors.textSubtle, fontSize: text.sizeSm },
  actionGroup: { display: "flex", minWidth: 0, marginLeft: "auto", alignItems: "center", gap: space.md },
  actions: { display: "flex", minWidth: 0, flexWrap: "wrap", alignItems: "center", gap: space.md },
  actionsStart: { marginRight: "auto" },
  actionsEnd: { marginLeft: "auto" },
  trailing: { display: "flex", flexShrink: 0, alignItems: "center" },
  overflowTrigger: { display: "flex", marginLeft: "auto", width: "44px", height: "44px", flexShrink: 0, alignItems: "center", justifyContent: "center", backgroundColor: { default: "transparent", ":hover": colors.glassHover }, color: colors.text, outlineColor: colors.ring },
  menuOverlay: { position: "fixed", inset: 0, zIndex: layers.appSwitcher, backgroundColor: colors.overlayScrim },
  menu: { position: "fixed", zIndex: layers.appSwitcherTop, top: "4rem", right: layout.gutterNarrow, width: "min(28rem, calc(100vw - 32px))", maxHeight: "calc(100dvh - 5rem)", overflowY: "auto", border: `1px solid ${colors.border}`, backgroundColor: colors.bgElevated, color: colors.text, padding: space.xl },
  menuHeading: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.md, fontSize: text.sizeSm, fontWeight: 600 },
  menuActions: { display: "flex", flexDirection: "column", alignItems: "stretch", gap: space.xl, minWidth: 0, paddingBlock: space.md },
});
