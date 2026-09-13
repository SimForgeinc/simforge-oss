/**
 * StyleX styles for `AppTopBarFrame`, the prerendered stand-in for the real
 * top bar.
 *
 * Kept separate from `AppTopBar.stylex.ts` for the same reason the components
 * are separate: the placeholder must not pull the client bar's chrome — or its
 * hover machinery — into the route shell. The header height and bottom border
 * are the pieces that must stay in step with `AppTopBar`, and they are the
 * first two declarations below.
 *
 * A one-for-one translation of the Tailwind this placeholder shipped with;
 * radii are absent because the global reset makes every `rounded-*` inert.
 */

import * as stylex from "@stylexjs/stylex";
import { colors, layers } from "@simforge-oss/studio-ui/stylex/tokens.stylex";

/** `md:` — the one breakpoint this chrome responds to. */
const MD = "@media (min-width: 768px)";

export const styles = stylex.create({
  /**
   * sticky top-0 z-30 flex h-14 w-full shrink-0 items-center border-b
   * border-border bg-background/95 backdrop-blur-sm
   */
  header: {
    position: "sticky",
    top: 0,
    zIndex: layers.sticky,
    display: "flex",
    height: "3.5rem",
    width: "100%",
    flexShrink: 0,
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    backgroundColor: "hsl(var(--background) / 0.95)",
    backdropFilter: "blur(4px)",
  },
  // flex h-full w-full items-center gap-3 px-3
  row: {
    display: "flex",
    height: "100%",
    width: "100%",
    alignItems: "center",
    gap: "0.75rem",
    paddingInline: "0.75rem",
  },
  // flex shrink-0 items-center
  brandSlot: { display: "flex", flexShrink: 0, alignItems: "center" },
  // hidden size-10 items-center justify-center rounded-md md:flex
  desktopButton: {
    display: { default: "none", [MD]: "flex" },
    width: "2.5rem",
    height: "2.5rem",
    alignItems: "center",
    justifyContent: "center",
  },
  // flex shrink-0 items-center justify-center text-primary
  mark: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    color: colors.primary,
  },
  // flex h-10 items-center gap-2 px-2 pr-2.5 md:hidden
  mobileChip: {
    display: { default: "flex", [MD]: "none" },
    height: "2.5rem",
    alignItems: "center",
    gap: "0.5rem",
    paddingLeft: "0.5rem",
    paddingRight: "0.625rem",
  },
  // flex aspect-square size-7 shrink-0 items-center justify-center text-primary
  mobileMark: {
    display: "flex",
    aspectRatio: "1 / 1",
    width: "1.75rem",
    height: "1.75rem",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    color: colors.primary,
  },
});
