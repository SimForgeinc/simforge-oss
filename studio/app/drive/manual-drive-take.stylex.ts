import * as stylex from "@stylexjs/stylex";
import { driveColors, driveRadius } from "../../../packages/studio-ui/src/drive/drive.stylex";

export const manualTake = stylex.create({
  boundary: { display: "grid", height: "100%", minHeight: 0, placeItems: "center", backgroundColor: driveColors.void, color: driveColors.textBody },
  boundaryBody: { textAlign: "center", fontSize: "0.875rem", lineHeight: "1.25rem", color: driveColors.textBody },
  returnLink: { display: "inline-block", marginTop: "0.75rem", color: driveColors.accent, textDecorationLine: "underline" },
  modal: { position: "fixed", inset: 0, zIndex: 50, display: "grid", placeItems: "center", backgroundColor: driveColors.scrim, padding: "1.5rem" },
  dialog: { width: "100%", maxWidth: "28rem", borderWidth: "1px", borderStyle: "solid", borderColor: "rgba(255,255,255,0.15)", borderRadius: driveRadius.card, backgroundColor: driveColors.dialog, padding: "1.5rem", boxShadow: "0 20px 25px -5px rgba(0,0,0,0.3)" },
  title: { fontSize: "1.125rem", lineHeight: "1.75rem", fontWeight: 600, color: driveColors.textPrimary },
  summary: { marginTop: "0.5rem", fontSize: "0.875rem", lineHeight: "1.25rem", color: driveColors.textBody },
  error: { marginTop: "0.75rem", fontSize: "0.875rem", lineHeight: "1.25rem", color: driveColors.danger },
  actions: { display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginTop: "1.25rem" },
});
