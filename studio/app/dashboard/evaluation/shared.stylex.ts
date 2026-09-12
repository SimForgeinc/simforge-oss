import * as stylex from "@stylexjs/stylex";

export const styles = stylex.create({
  status: { display: "inline-flex", alignItems: "center", borderWidth: 1, borderStyle: "solid", borderColor: "transparent", borderRadius: "9999px", paddingInline: ".5rem", paddingBlock: ".125rem", fontSize: ".75rem", lineHeight: "1rem", textTransform: "capitalize" },
  queued: { backgroundColor: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" },
  running: { backgroundColor: "rgba(59,130,246,.15)", color: "rgb(37,99,235)" },
  complete: { backgroundColor: "rgba(16,185,129,.15)", color: "rgb(5,150,105)" },
  failed: { backgroundColor: "rgba(239,68,68,.15)", color: "hsl(var(--destructive))" },
  message: { display: "flex", height: "10rem", alignItems: "center", justifyContent: "center", paddingInline: "1rem", textAlign: "center", fontSize: ".875rem", lineHeight: "1.25rem", color: "hsl(var(--muted-foreground))" },
});
