import * as stylex from "@stylexjs/stylex";
import { colors, space, text } from "../../../stylex/tokens.stylex";

export const styles = stylex.create({
  // ml-auto flex items-center gap-1.5
  flexCenterPushRight: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: space.sm,
  },
  // flex items-center rounded-md bg-black/15 p-0.5
  flexCenterPad05: {
    display: "flex",
    alignItems: "center",
    borderRadius: "0",
    backgroundColor: "rgb(0 0 0 / 0.15)",
    padding: space.xxs,
  },
  // size-3.5
  size35: {
    width: "0.875rem",
    height: "0.875rem",
  },
  // text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground
  textPrimaryForegroundHoverBgPrimaryForeground10HoverTextPrimaryForeground: {
    color: {
      default: colors.primaryForeground,
      ":hover": colors.primaryForeground,
    },
    backgroundColor: {
      default: null,
      ":hover": "hsl(var(--primary-foreground) / 0.1)",
    },
  },
  // ml-auto text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground
  pushRight: {
    marginLeft: "auto",
    color: {
      default: colors.primaryForeground,
      ":hover": colors.primaryForeground,
    },
    backgroundColor: {
      default: null,
      ":hover": "hsl(var(--primary-foreground) / 0.1)",
    },
  },

  // flex min-h-11 shrink-0 items-center px-5 py-2 text-sm font-semibold
  banner: {
    display: "flex",
    minHeight: "2.75rem",
    flexShrink: 0,
    alignItems: "center",
    paddingLeft: "1.25rem",
    paddingRight: "1.25rem",
    paddingTop: space.md,
    paddingBottom: space.md,
    fontSize: text.sizeSm,
    lineHeight: "1.25rem",
    fontWeight: text.weightSemibold,
  },
  // bg-amber-400 text-black
  bannerWarning: {
    backgroundColor: "rgb(251 191 36 / 1)",
    color: "rgb(0 0 0 / 1)",
  },
  // bg-primary text-primary-foreground
  bannerMode: {
    backgroundColor: colors.primary,
    color: colors.primaryForeground,
  },
  // mr-2 size-2 — the `editor-pulse` keyframe utility stays a global class:
  // it is one of the animation utilities styles.css keeps behind a
  // reduced-motion guard.
  pulseDot: {
    marginRight: space.md,
    width: "0.5rem",
    height: "0.5rem",
  },
  // bg-black
  pulseDotWarning: {
    backgroundColor: "rgb(0 0 0 / 1)",
  },
  // bg-primary-foreground
  pulseDotMode: {
    backgroundColor: colors.primaryForeground,
  },
  // bg-black text-white hover:bg-black/85
  routeToolActive: {
    backgroundColor: {
      default: "rgb(0 0 0 / 1)",
      ":hover": "rgb(0 0 0 / 0.85)",
    },
    color: "rgb(255 255 255 / 1)",
  },
  // text-primary-foreground hover:bg-primary-foreground/10 — deliberately does
  // not pin the hover colour, so the ghost button's own `hover:text-*` keeps
  // winning exactly as it did before.
  routeToolIdle: {
    color: colors.primaryForeground,
    backgroundColor: {
      default: null,
      ":hover": "hsl(var(--primary-foreground) / 0.1)",
    },
  },
});
