import * as stylex from "@stylexjs/stylex";
import SimForgeLogo from "@/app/components/landing/SimForgeLogo";
import { styles } from "@/app/components/AppTopBarFrame.stylex";

/**
 * Static replica of `AppTopBar`'s chrome, used as the Suspense fallback while
 * the authenticated top bar resolves.
 *
 * This is the piece Cache Components prerenders into the route shell, so it
 * must stay free of `cookies()`, `headers()`, `connection()`, and every other
 * per-request read. Before this existed the whole dashboard shell prerendered
 * to a single full-page spinner; the header geometry (the 3.5rem height, the
 * border, the logo button) is now static HTML and no longer waits on session
 * resolution.
 *
 * Geometry is duplicated from `AppTopBar` deliberately rather than shared: the
 * real bar is a client component whose chrome is entangled with hover state,
 * and a placeholder that imported it would drag that bundle into the shell.
 * Keep the header height and border in sync with `AppTopBar` so the streamed
 * bar does not shift layout when it replaces this.
 */
export function AppTopBarFrame() {
  return (
    <header
      {...stylex.props(styles.header)}
      role="status"
      aria-label="Loading workspace navigation"
    >
      <div {...stylex.props(styles.row)} aria-hidden="true">
        <div {...stylex.props(styles.brandSlot)}>
          {/* Desktop button — mirrors DesktopUnifiedTrigger, without the hover affordances. */}
          <div {...stylex.props(styles.desktopButton)}>
            <div {...stylex.props(styles.mark)}>
              <SimForgeLogo size={32} />
            </div>
          </div>

          {/* Mobile chip — the workspace name is per-request data, so it is omitted here. */}
          <div {...stylex.props(styles.mobileChip)}>
            <div {...stylex.props(styles.mobileMark)}>
              <SimForgeLogo size={24} />
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
