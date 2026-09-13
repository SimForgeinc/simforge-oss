import * as stylex from "@stylexjs/stylex";

export const styles = stylex.create({
  status: { display: "inline-flex", alignItems: "center", borderWidth: 1, borderStyle: "solid", borderColor: "transparent", borderRadius: "9999px", paddingInline: ".5rem", paddingBlock: ".125rem", fontSize: ".75rem", lineHeight: "1rem", textTransform: "capitalize" },
  queued: { backgroundColor: "hsl(var(--muted))", color: "hsl(var(--muted-foreground))" },
  /** `bg-blue-500/15 text-blue-600 dark:text-blue-400` — the shell is permanently dark, so the dark value is folded. */
  running: { backgroundColor: "rgba(59,130,246,.15)", color: "rgb(96,165,250)" },
  /** `bg-emerald-500/15 text-emerald-600 dark:text-emerald-400` — dark value folded. */
  complete: { backgroundColor: "rgba(16,185,129,.15)", color: "rgb(52,211,153)" },
  failed: { backgroundColor: "rgba(239,68,68,.15)", color: "hsl(var(--destructive))" },
  message: { display: "flex", height: "10rem", alignItems: "center", justifyContent: "center", paddingInline: "1rem", textAlign: "center", fontSize: ".875rem", lineHeight: "1.25rem", color: "hsl(var(--muted-foreground))" },
});
