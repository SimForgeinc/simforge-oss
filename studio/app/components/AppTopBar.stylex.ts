import * as stylex from "@stylexjs/stylex";
import { colors, layers, layout, space, text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";
export { cloudPlate } from "@simforge-oss/studio-ui/components/SkyCloudBackdrop.stylex";
export const logoTransform = stylex.defineVars({ value: "none" });

export const styles = stylex.create({
  // Inset shadows paint below native no-drag controls rather than intercepting their hit regions.
  header: { position: "relative", zIndex: layers.topbar, display: "flex", height: "3.5rem", width: "100%", flexShrink: 0, alignItems: "center", overflow: "hidden", borderBottom: `1px solid ${colors.hairlineStrong}`, backgroundColor: colors.scrim, boxShadow: "0 10px 35px rgba(0,0,0,0.24), inset 0 1px 0 rgba(255,255,255,0.10)", backdropFilter: "blur(40px) saturate(0)" },
  clouds: { pointerEvents: "none", position: "absolute", left: "-8%", right: "-8%", top: "-100%", bottom: "-100%" },
  // Respect desktop window controls without reserving space in a browser.
  row: { position: "relative", zIndex: layers.raised, display: "flex", height: "100%", minWidth: 0, marginLeft: "env(titlebar-area-x, 0px)", width: "env(titlebar-area-width, 100%)", alignItems: "center", gap: space.s3, paddingInline: space.s3 },
  trigger: { [logoTransform.value]: { default: "none", ":hover": "scale(1.18)", ":focus-visible": "scale(1.18)" }, display: "flex", width: "44px", height: "44px", flexShrink: 0, alignItems: "center", justifyContent: "center", color: colors.accent, backgroundColor: "transparent", outlineColor: colors.ring },
  logo: { display: "flex", alignItems: "center", justifyContent: "center", transform: logoTransform.value, transitionProperty: { default: "transform", [layout.reducedMotion]: "none" }, transitionDuration: "200ms" },
  content: { display: "flex", minWidth: 0, flex: 1, alignItems: "center", gap: space.s2 },
  titleRow: { display: "flex", minWidth: 0, alignItems: "baseline", gap: space.s2, overflow: "hidden", whiteSpace: "nowrap", color: colors.ink },
  brand: { display: { default: "none", [layout.bpLg]: "inline" }, flexShrink: 0, fontSize: text.sizeXl, fontFamily: text.fontHeavy, fontWeight: text.weightBold, letterSpacing: "-0.055em" },
  separator: { display: { default: "none", [layout.bpLg]: "inline" }, color: colors.inkFaint },
  pageTitle: { margin: 0, minWidth: 0, fontSize: text.sizeXl, fontWeight: text.weightSemibold, lineHeight: text.lineTight, letterSpacing: text.trackingTight, fontFamily: text.fontDisplay },
  context: { display: { default: "none", [layout.bpLg]: "inline" }, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", color: colors.textSubtle, fontSize: text.sizeSm },
  actionGroup: { display: "flex", minWidth: 0, marginLeft: "auto", alignItems: "center", gap: space.s2 },
  actions: { display: "flex", minWidth: 0, flexWrap: "wrap", alignItems: "center", gap: space.s2 },
  actionsStart: { marginRight: "auto" },
  actionsEnd: { marginLeft: "auto" },
  trailing: { display: "flex", flexShrink: 0, alignItems: "center" },
  overflowTrigger: { display: "flex", marginLeft: "auto", width: "44px", height: "44px", flexShrink: 0, alignItems: "center", justifyContent: "center", backgroundColor: { default: "transparent", ":hover": colors.fillStronger }, color: colors.text, outlineColor: colors.ring },
  menuOverlay: { position: "fixed", inset: 0, zIndex: layers.appSwitcher, backgroundColor: colors.scrim },
  menu: { position: "fixed", zIndex: layers.appSwitcherTop, top: "4rem", right: layout.gutterNarrow, width: "min(28rem, calc(100vw - 32px))", maxHeight: "calc(100dvh - 5rem)", overflowY: "auto", border: `1px solid ${colors.border}`, backgroundColor: colors.card, color: colors.text, padding: space.s4 },
  menuHeading: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: space.s2, fontSize: text.sizeSm, fontWeight: text.weightSemibold },
  menuActions: { display: "flex", flexDirection: "column", alignItems: "stretch", gap: space.s4, minWidth: 0, paddingBlock: space.s2 },
});
