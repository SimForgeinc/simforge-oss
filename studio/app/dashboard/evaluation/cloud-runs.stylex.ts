import * as stylex from "@stylexjs/stylex";
export const styles = stylex.create({
  root: { display: "flex", flexDirection: "column", gap: "1.5rem" },
  selector: { width: "100%", maxWidth: "24rem", display: "flex", flexDirection: "column", gap: ".375rem" },
  label: { fontSize: ".75rem", lineHeight: "1rem", textTransform: "uppercase", letterSpacing: ".05em", color: "hsl(var(--muted-foreground))" },
  help: { fontSize: ".75rem", lineHeight: "1.25rem", color: "hsl(var(--muted-foreground))" },
});
