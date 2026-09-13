import * as stylex from "@stylexjs/stylex";

export const styles = stylex.create({
  root: { flexShrink: 0, cursor: "default", gap: "0.25rem", whiteSpace: "nowrap", fontWeight: 500 },
  small: { height: "1.25rem", paddingInline: "0.375rem", paddingBlock: 0, fontSize: "10px" },
  medium: { height: "1.5rem", paddingInline: "0.5rem", paddingBlock: "0.125rem", fontSize: "0.75rem", lineHeight: "1rem" },
  native: { borderColor: "rgb(56 189 248 / 25%)", backgroundColor: "rgb(56 189 248 / 15%)", color: "rgb(186 230 253)", ":hover": { backgroundColor: "rgb(56 189 248 / 15%)" } },
  generated: { borderColor: "transparent", backgroundColor: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))", ":hover": { backgroundColor: "hsl(var(--muted))" } },
  browser: { borderColor: "hsl(var(--border))", backgroundColor: "transparent", color: "hsl(var(--muted-foreground))" },
});
