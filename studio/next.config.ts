import type { NextConfig } from "next";
import { join } from "node:path";
import { stylexBabelConfig, stylexCompileRoots } from "./stylex.config.mjs";

/**
 * Origin serving a live twin's camera feeds (MJPEG) when one is attached.
 * Proxied rather than hot-linked so the browser makes no cross-origin request:
 * feeds then share the page's connection budget and work unchanged over a
 * tunnelled host. Unset means no twin is attached and the route is not mounted,
 * which is better than mounting a rewrite that 502s.
 */
const twinHttpOrigin = process.env.SIMFORGE_TWIN_HTTP_ORIGIN?.trim();
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
  // Workspace packages are bundled from source, so file tracing must span the monorepo.
  outputFileTracingRoot: join(__dirname, ".."),
  // Cargo outputs may be external worktree symlinks. Desktop staging copies
  // the selected native binaries explicitly, never the development build trees.
  outputFileTracingExcludes: {
    "/*": ["../renderer/target", "../renderer/target/**/*", "../native/target", "../native/target/**/*"],
  },
  async rewrites() {
    return twinHttpOrigin
      ? [{ source: "/streams/:path*", destination: `${twinHttpOrigin}/streams/:path*` }]
      : [];
  },
  allowedDevOrigins: [
    "127.0.0.1",
    "100.72.252.40",
    "path-b860i-aorus-pro-ice",
    "path-b860i-aorus-pro-ice.tail1cad6a.ts.net",
    ...configuredDevOrigins,
  ],
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
   * every script in `package.json` and `scripts/local-host.ts` already does.
   */
  webpack(config) {
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

export default nextConfig;
