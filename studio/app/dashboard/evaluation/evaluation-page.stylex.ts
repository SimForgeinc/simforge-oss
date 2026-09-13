import * as stylex from "@stylexjs/stylex";
import { text } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

export const styles = stylex.create({
  page: { display: "flex", height: "100%", flexDirection: "column", overflowY: "auto", gap: "1.5rem" },
  tabs: { display: "flex", minHeight: 0, flex: 1, flexDirection: "column" },
  tabList: { marginInline: "1.25rem", marginTop: "1.25rem", alignSelf: "flex-start", "@media (min-width: 640px)": { marginInline: "1.5rem" } },
  tabContent: { paddingInline: "1.25rem", paddingBlock: "1.25rem", "@media (min-width: 640px)": { paddingInline: "1.5rem" } },
  campaignList: { display: "flex", flexDirection: "column", gap: "1.25rem", paddingInline: "1.25rem", paddingBlock: "1.25rem", "@media (min-width: 640px)": { paddingInline: "1.5rem" } },
  campaignHeader: { display: "flex", flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: ".75rem" },
  cardTitle: { fontSize: "1rem", lineHeight: "1.5rem" },
  muted: { fontSize: ".75rem", lineHeight: "1rem", color: "hsl(var(--muted-foreground))" },
  right: { textAlign: "right" },
  numeric: { textAlign: "right", fontFamily: text.fontMono },
  numericMuted: { textAlign: "right", fontFamily: text.fontMono, fontSize: ".75rem", lineHeight: "1rem", color: "hsl(var(--muted-foreground))" },
  promoted: { fontFamily: text.fontMono, fontSize: ".75rem", lineHeight: "1rem", color: "hsl(var(--muted-foreground))" },
  link: { fontWeight: 500, color: "hsl(var(--foreground))", ":hover": { textDecorationLine: "underline" } },
  modelLink: { fontFamily: text.fontMono, fontSize: ".75rem", lineHeight: "1rem", color: "hsl(var(--muted-foreground))", ":hover": { textDecorationLine: "underline" } },
  icon: { width: "1rem", height: "1rem", marginRight: ".375rem" },
  emptyIcon: { width: "2rem", height: "2rem" },
});
