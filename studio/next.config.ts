import type { NextConfig } from "next";
import { join, relative } from "node:path";
import { withAtomicDevEmit } from "./dev-atomic-emit.mjs";
import { stylexBabelConfig, stylexCompileRoots } from "./stylex.config.mjs";
import { linkStudioHost, loadStudioHost } from "./host.config.mjs";

/**
 * The attached host, if any (`SIMFORGE_STUDIO_HOST`; see host.config.mjs).
 * A hosted build runs with `<host>/.studio/root` as its project directory;
 * linking here keeps that directory current on every `next dev|build|start`.
 */
const host = loadStudioHost();
linkStudioHost(host);

/**
 * Origin serving a live twin's camera feeds (MJPEG) when one is attached.
 * Proxied rather than hot-linked so the browser makes no cross-origin request:
 * feeds then share the page's connection budget and work unchanged over a
 * tunnelled host. Unset means no twin is attached and the route is not mounted,
 * which is better than mounting a rewrite that 502s.
 */
const twinHttpOrigin = process.env.SIMFORGE_TWIN_HTTP_ORIGIN?.trim();
/**
 * The content-addressed actor store (`/actor-assets/blobs/sha256/<aa>/<sha256>`):
 * the catalog's model packs are fetched by digest from it (viewer
 * `externalModelUrl`), never from this deployment. Proxied so the browser sees
 * one origin. SIMFORGE_ACTOR_ASSETS_BASE_URL overrides the public CDN, the same
 * variable the render workers read; a trailing `/actor-assets` is folded away.
 */
const actorAssetsOrigin = (process.env.SIMFORGE_ACTOR_ASSETS_BASE_URL?.trim() || "https://da3tufozhdsvl.cloudfront.net")
  .replace(/\/+$/, "")
  .replace(/\/actor-assets$/, "");
const configuredDevOrigins = (process.env.SIMFORGE_ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // The desktop stage (`desktop/stage.mjs`) serves the traced standalone
  // server from the installed artifact; the browser edition keeps `next start`.
  ...(process.env.SIMFORGE_DESKTOP_BUILD === "1" ? { output: "standalone" as const } : {}),
  // Local assets require the browser's loopback session. Next's server-side
  // image fetch cannot authenticate as that browser; serve the encoded assets directly.
  images: { unoptimized: true },
  // A hosted build writes its own output so it never overwrites the local one.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : host ? { distDir: host.distDir } : {}),
  // The host's tsconfig resolves `@/*` to the host first: that is how slots resolve.
  ...(host ? { typescript: { tsconfigPath: relative(__dirname, host.tsconfig) } } : {}),
  // Workspace packages are bundled from source, so file tracing must span the monorepo.
  outputFileTracingRoot: join(__dirname, ".."),
  // Cargo outputs may be external worktree symlinks. Desktop staging copies
  // the selected native binaries explicitly, never the development build trees.
  outputFileTracingExcludes: {
    "/*": ["../renderer/target", "../renderer/target/**/*", "../native/target", "../native/target/**/*"],
  },
  async rewrites() {
    return [
      { source: "/actor-assets/:path*", destination: `${actorAssetsOrigin}/actor-assets/:path*` },
      ...(twinHttpOrigin ? [{ source: "/streams/:path*", destination: `${twinHttpOrigin}/streams/:path*` }] : []),
    ];
  },
  // Other hosts that may load the dev server (a LAN or tailnet name, say)
  // come from SIMFORGE_ALLOWED_DEV_ORIGINS; none are baked in.
  allowedDevOrigins: ["127.0.0.1", ...configuredDevOrigins],
  cacheComponents: true,
  partialPrefetching: true,
  serverExternalPackages: ["@electric-sql/pglite", "@napi-rs/keyring", "@simforge-oss/native-runtime", "@simforge-oss/render"],
  turbopack: {
    rules: {
      "basis_transcoder.wasm": { type: "asset" },
    },
  },
  transpilePackages: [
    "@simforge-oss/asset-catalog",
    "@simforge-oss/compiler",
    "@simforge-oss/maps",
    "@simforge-oss/openscenario",
    "@simforge-oss/playback/traffic",
    "@simforge-oss/viewer",
    "@simforge-oss/editor",
    "@simforge-oss/playback",
    "@simforge-oss/scenario",
    "@simforge-oss/engine",
    "@simforge-oss/training-env",
    "@simforge-oss/studio-host",
    "@simforge-oss/studio-ui",
  ],
  /**
   * StyleX is compiled here rather than through a root Babel config: a Babel
   * config would take the whole app off SWC, and `next/font` — which
   * `app/layout.tsx` uses for all three faces — is unsupported under Babel.
   * This rule is appended after Next's own, so it runs first on the original
   * source and hands SWC plain JS/TS with the StyleX calls already rewritten.
   *
   * Consequence: the studio must be built and served with `--webpack`, which
   * every script in `package.json` and the `simforge daemon` supervisor already do.
   */
  webpack(config, context) {
    // Dev only: a worker spawned mid-recompile must never load a half-written chunk.
    withAtomicDevEmit(config, context);
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    config.module.rules.push({
      test: /\.(?:tsx|ts|jsx|js|mjs|cjs)$/,
      include: stylexCompileRoots,
      use: [
        {
          loader: "babel-loader",
          options: { ...stylexBabelConfig, cacheDirectory: true },
        },
      ],
    });
    return config;
  },
  experimental: {
    externalDir: true,
  },
};

/** A host's config hook receives this app's config and returns the hosted one. */
export default async function config(): Promise<NextConfig> {
  if (!host?.nextConfig) return nextConfig;
  // An absolute path, not a file URL: this config is transpiled to CommonJS,
  // where the import becomes a require().
  const hook = await import(host.nextConfig);
  return hook.extendNextConfig(nextConfig, { studioDir: __dirname, host });
}
