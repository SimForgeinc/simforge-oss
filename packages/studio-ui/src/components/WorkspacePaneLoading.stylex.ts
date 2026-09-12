import * as stylex from "@stylexjs/stylex";
export const styles = stylex.create({
 root: { display: "flex", minHeight: "5rem", alignItems: "flex-start", gap: "0.75rem", borderBottomWidth: 1, borderBottomColor: "rgb(255 255 255 / 10%)", paddingInline: "0.75rem", paddingBlock: "1rem", color: "hsl(var(--foreground))" },
 spinner: { marginTop: "0.125rem", display: "grid", width: "0.875rem", height: "0.875rem", flexShrink: 0, placeItems: "center", color: "hsl(var(--primary))", animationName: { default: "spin", "@media (prefers-reduced-motion: reduce)": "none" }, animationDuration: "1s", animationIterationCount: "infinite" },
 body: { minWidth: 0 },
 message: { fontFamily: "var(--font-meta)", fontSize: "var(--text-micro)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "var(--tracking-meta-wider)", color: "hsl(var(--foreground))" },
 hint: { marginTop: "0.25rem", fontSize: "0.75rem", lineHeight: "1rem", color: "rgb(255 255 255 / 60%)" },
 icon: { width: "0.875rem", height: "0.875rem" },
});
