"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import {
  detectHeroSceneEnvironment,
  HERO_SCENE_LOAD_TIMEOUT_MS,
  shouldRenderHeroScene,
} from "./hero-scene";
import { hero } from "./onboarding.stylex";

/**
 * The animated backdrop behind the onboarding screens: the same two Unicorn
 * Studio scenes the marketing site shows behind its hero, so the installed app
 * opens on the atmosphere the download page promised.
 *
 * The SDK comes from a CDN and each scene pulls its own payload, so nothing is
 * assumed and nothing is requested until it can pay off: a CSS gradient in the
 * same palette is painted underneath, and the scenes mount only where they can
 * render (WebGL, a network, no reduced-motion preference). A scene that fails
 * or never answers is dropped back to the gradient. Nothing above this layer
 * depends on the scenes rendering.
 */

const UnicornScene = dynamic(() => import("unicornstudio-react"), { ssr: false });

const SCENE_PROPS = {
  width: "100%",
  height: "100%",
  scale: 1,
  dpi: 1.5,
  sdkUrl: "https://cdn.jsdelivr.net/gh/hiunicornstudio/unicornstudio.js@2.1.12/dist/unicornStudio.umd.js",
  className: "h-full w-full",
  lazyLoad: false,
  showPlaceholderOnError: false,
  showPlaceholderWhileLoading: false,
} as const;

export function HeroBackdrop({ className = "" }: { className?: string }) {
  /**
   * `probing` until the browser has been asked what it supports: the server
   * renders the gradient, the first effect decides, and only `live` mounts the
   * scenes. `loaded` closes the watchdog below.
   */
  const [scene, setScene] = useState<"probing" | "live" | "fallback">("probing");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setScene(shouldRenderHeroScene(detectHeroSceneEnvironment()) ? "live" : "fallback");
  }, []);

  // A scene that neither loads nor errors (blackholed CDN, captive portal)
  // would otherwise hold an invisible load forever; unmount it and keep the
  // gradient the screen was already showing.
  useEffect(() => {
    if (scene !== "live" || loaded) return;
    const timer = window.setTimeout(() => setScene("fallback"), HERO_SCENE_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [scene, loaded]);

  const root = stylex.props(hero.root);

  return (
    <div
      aria-hidden="true"
      // A caller's class still applies on top: this layer is positioned by
      // whatever screen mounts it.
      className={className ? `${root.className ?? ""} ${className}`.trim() : root.className}
      data-testid="onboarding-hero-backdrop"
      data-scene={scene}
      style={root.style}
    >
      {scene === "live" ? (
        <>
          <div {...stylex.props(hero.layer, hero.skyMask)}>
            <UnicornScene
              {...SCENE_PROPS}
              projectId="Lgi1YImqkgZhsSfqjKTg"
              altText="Animated digital-twin environment"
              ariaLabel="Animated digital-twin environment"
              onError={() => setScene("fallback")}
              onLoad={() => setLoaded(true)}
            />
          </div>
          <div {...stylex.props(hero.layer, hero.groundMask)}>
            <UnicornScene
              {...SCENE_PROPS}
              projectId="PT1yYvFGJoaxM36xAiSA"
              altText="Animated simulation ground plane"
              ariaLabel="Animated simulation ground plane"
              onError={() => setScene("fallback")}
              onLoad={() => setLoaded(true)}
            />
          </div>
        </>
      ) : null}
      {/* The marketing hero carries a headline over a wide crop; this screen
          carries three lines of instructions and two buttons over the same
          scene, so the copy side of the scrim is darker than the site's. */}
      <div {...stylex.props(hero.layer, hero.verticalScrim)} />
      <div {...stylex.props(hero.layer, hero.copyScrim)} />
    </div>
  );
}
