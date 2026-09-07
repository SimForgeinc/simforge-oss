import type { NextConfig } from "next";
import { join } from "node:path";

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
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    return config;
  },
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
