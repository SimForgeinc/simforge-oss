"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import {
  detectHeroSceneEnvironment,
  HERO_SCENE_LOAD_TIMEOUT_MS,
  shouldRenderHeroScene,
} from "./hero-scene";

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

const FALLBACK_GRADIENT =
  "radial-gradient(120% 90% at 72% 18%, #1b4a5e 0%, #0d2130 38%, #060a0e 72%, #050607 100%)";

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

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}
      data-testid="onboarding-hero-backdrop"
      data-scene={scene}
      style={{ backgroundImage: FALLBACK_GRADIENT }}
    >
      {scene === "live" ? (
        <>
          <div
            className="absolute inset-0"
            style={{
              maskImage: "linear-gradient(202deg, black 0%, black 50%, transparent 72%)",
              WebkitMaskImage: "linear-gradient(202deg, black 0%, black 50%, transparent 72%)",
            }}
          >
            <UnicornScene
              {...SCENE_PROPS}
              projectId="Lgi1YImqkgZhsSfqjKTg"
              altText="Animated digital-twin environment"
              ariaLabel="Animated digital-twin environment"
              onError={() => setScene("fallback")}
              onLoad={() => setLoaded(true)}
            />
          </div>
          <div
            className="absolute inset-0"
            style={{
              maskImage: "linear-gradient(202deg, transparent 46%, black 68%, black 100%)",
              WebkitMaskImage: "linear-gradient(202deg, transparent 46%, black 68%, black 100%)",
            }}
          >
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
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(5,6,7,0.5)_0%,rgba(5,6,7,0.18)_38%,rgba(5,6,7,0.94)_100%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(5,6,7,0.9)_0%,rgba(5,6,7,0.78)_38%,rgba(5,6,7,0.3)_72%,rgba(5,6,7,0.42)_100%)]" />
    </div>
  );
}
