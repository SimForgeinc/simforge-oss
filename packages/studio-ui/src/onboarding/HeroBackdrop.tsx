"use client";

import * as stylex from "@stylexjs/stylex";
import { hero } from "./onboarding.stylex";

/**
 * The backdrop behind the onboarding screens: the teal-to-near-black gradient
 * of the download page's hero, plus the two scrims that hold it down far
 * enough for body text to stay readable.
 *
 * It used to mount the marketing site's two Unicorn Studio scenes on top of
 * this gradient. That cost a third-party SDK from a CDN and ~12 MB of MP4 per
 * scene from `assets.unicorn.studio`, which is 12 seconds of network on the
 * very first screen of an application whose whole promise is that it runs on
 * this computer. The gradient was always what the screens fell back to, so it
 * is now simply what they show: no request, nothing to wait for, no CDN to be
 * reachable. Everything above this layer is decoration-independent.
 */

export function HeroBackdrop({ className = "" }: { className?: string }) {
  const root = stylex.props(hero.root);

  return (
    <div
      aria-hidden="true"
      // A caller's class still applies on top: this layer is positioned by
      // whatever screen mounts it.
      className={className ? `${root.className ?? ""} ${className}`.trim() : root.className}
      data-testid="onboarding-hero-backdrop"
      style={root.style}
    >
      {/* The marketing hero carries a headline over a wide crop; this screen
          carries three lines of instructions and two buttons over the same
          palette, so the copy side of the scrim is darker than the site's. */}
      <div {...stylex.props(hero.layer, hero.verticalScrim)} />
      <div {...stylex.props(hero.layer, hero.copyScrim)} />
    </div>
  );
}
