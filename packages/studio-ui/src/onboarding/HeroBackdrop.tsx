"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

/**
 * The animated backdrop behind the onboarding screens: the same two Unicorn
 * Studio scenes the marketing site shows behind its hero, so the installed app
 * opens on the atmosphere the download page promised.
 *
 * The SDK comes from a CDN and the scenes need WebGL, so neither is assumed:
 * a CSS gradient in the same palette is painted underneath and stays visible
 * while the scenes load, forever if they fail (offline install, blocked CDN,
 * no GPU). Nothing above this layer depends on the scenes rendering.
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
  const [failed, setFailed] = useState(false);

  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}
      data-testid="onboarding-hero-backdrop"
      data-scene={failed ? "fallback" : "live"}
      style={{ backgroundImage: FALLBACK_GRADIENT }}
    >
      {failed ? null : (
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
              onError={() => setFailed(true)}
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
              onError={() => setFailed(true)}
            />
          </div>
        </>
      )}
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(5,6,7,0.5)_0%,rgba(5,6,7,0.18)_38%,rgba(5,6,7,0.94)_100%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(5,6,7,0.72)_0%,rgba(5,6,7,0.16)_68%,rgba(5,6,7,0.28)_100%)]" />
    </div>
  );
}
