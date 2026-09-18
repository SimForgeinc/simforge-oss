"use client";

import { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { hero } from "./onboarding.stylex";

/**
 * The backdrop behind every screen of the first-run flow: the teal-to-near-black
 * gradient of the download page's hero, the marketing scene playing over it,
 * and the two scrims that hold both down far enough for body text to stay
 * readable.
 *
 * The scene is a local asset the host serves from its own `public/onboarding`
 * directory, never a request to a third party. It used to be two Unicorn
 * Studio scenes: an SDK from a CDN plus ~12 MB of MP4 per scene from
 * `assets.unicorn.studio`, which is twelve seconds of network on the very
 * first screen of an application whose whole promise is that it runs on this
 * computer. Vendored and re-encoded, the same scene is 6.2 MB off this disk.
 *
 * Every layer above the gradient is optional by construction: the gradient is
 * painted by this element itself, the poster is one still of the scene, and
 * the video sits on top of them. A video that cannot decode, a poster that
 * 404s and `prefers-reduced-motion: reduce` (which mounts no video at all)
 * therefore all degrade to exactly the screen that shipped before the asset
 * existed.
 */

/** Served by the host from `studio/public/onboarding`; same-origin by construction. */
const HERO_VIDEO_SRC = "/onboarding/onboarding-hero.mp4";
const HERO_POSTER_SRC = "/onboarding/onboarding-hero-poster.jpg";

export function HeroBackdrop({ className = "" }: { className?: string }) {
  const root = stylex.props(hero.root);
  /**
   * Motion is a client fact: the server cannot know the preference, and a
   * video autoplaying before it is known is the one thing reduced motion
   * asks not to happen. The poster is server-rendered, so the first paint is
   * the scene either way.
   */
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setAnimate(!query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return (
    <div
      aria-hidden="true"
      // A caller's class still applies on top: this layer is positioned by
      // whatever screen mounts it.
      className={className ? `${root.className ?? ""} ${className}`.trim() : root.className}
      data-testid="onboarding-hero-backdrop"
      style={root.style}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- host-served still, no loader needed */}
      <img alt="" {...stylex.props(hero.layer, hero.scene)} src={HERO_POSTER_SRC} />
      {animate ? (
        <video
          autoPlay
          data-testid="onboarding-hero-video"
          loop
          muted
          playsInline
          poster={HERO_POSTER_SRC}
          // Enough to start; the rest streams from this disk.
          preload="metadata"
          src={HERO_VIDEO_SRC}
          {...stylex.props(hero.layer, hero.scene)}
        />
      ) : null}
      {/* The marketing hero carries a headline over a wide crop; this screen
          carries three lines of instructions and two buttons over the same
          palette, so the copy side of the scrim is darker than the site's. */}
      <div {...stylex.props(hero.layer, hero.verticalScrim)} />
      <div {...stylex.props(hero.layer, hero.copyScrim)} />
    </div>
  );
}
