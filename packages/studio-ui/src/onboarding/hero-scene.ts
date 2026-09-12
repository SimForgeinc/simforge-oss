/**
 * Whether the onboarding hero may run its live Unicorn Studio scenes.
 *
 * The scenes are atmosphere, not information: the screen is complete with the
 * CSS gradient alone. So the decision is made *before* anything is requested —
 * the SDK comes from a CDN and each scene pulls its own payload from
 * unicorn.studio, and an installation that cannot render them (no WebGL) or
 * should not animate (reduced motion) or cannot reach the network (offline
 * install) must not spend that download to arrive at the same gradient.
 */
export type HeroSceneEnvironment = {
  /** The user asked the platform for less animation. */
  reducedMotion: boolean;
  /** The browser believes it has a network; `true` when it cannot tell. */
  online: boolean;
  /** A WebGL context can actually be created. */
  webgl: boolean;
};

/**
 * How long a mounted scene may stay silent before the backdrop gives up on it.
 * `onError` covers a refused request; a request that never answers (captive
 * portal, blackholed CDN) reports nothing at all, and the scenes are then
 * unmounted so a doomed load is not left running behind the screen.
 */
export const HERO_SCENE_LOAD_TIMEOUT_MS = 8000;

export function shouldRenderHeroScene(environment: HeroSceneEnvironment): boolean {
  return environment.webgl && environment.online && !environment.reducedMotion;
}

/**
 * Reads the environment in a browser. Called from an effect, never during
 * render: the server has no answer for any of these and a guess would
 * hydrate differently.
 */
export function detectHeroSceneEnvironment(): HeroSceneEnvironment {
  return {
    reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
    online: navigator.onLine !== false,
    webgl: hasWebGl(),
  };
}

function hasWebGl(): boolean {
  const canvas = document.createElement("canvas");
  try {
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!context) return false;
    // A software fallback still renders; only a context that cannot be made at
    // all disqualifies the scene. Release it immediately — the SDK makes its own.
    const lose = (context as WebGLRenderingContext).getExtension("WEBGL_lose_context");
    (lose as { loseContext?: () => void } | null)?.loseContext?.();
    return true;
  } catch {
    return false;
  }
}
