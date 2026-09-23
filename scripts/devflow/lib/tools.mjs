// Pinned, checksum-verified tool binaries (sccache, cargo-nextest) installed
// once per machine under ~/.cache/devflow/bin. A tool already on PATH wins.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { CACHE_ROOT, commandExists, sh } from "./util.mjs";

const BIN = join(CACHE_ROOT, "bin");

const TOOLS = {
  sccache: {
    version: "0.18.0",
    assets: {
      "linux-x64": {
        url: "https://github.com/mozilla/sccache/releases/download/v0.18.0/sccache-v0.18.0-x86_64-unknown-linux-musl.tar.gz",
        sha256: "45f1447fbe231e3037bde351ef70677dd212216c8d62ae7ca409fecc4d6acc89",
        member: "sccache-v0.18.0-x86_64-unknown-linux-musl/sccache",
      },
      "linux-arm64": {
        url: "https://github.com/mozilla/sccache/releases/download/v0.18.0/sccache-v0.18.0-aarch64-unknown-linux-musl.tar.gz",
        sha256: "2b3284d5da3b46a47dc4229e75bb7b88ac4aa99c8d754fb7d2f84997e5a4354a",
        member: "sccache-v0.18.0-aarch64-unknown-linux-musl/sccache",
      },
      "darwin-arm64": {
        url: "https://github.com/mozilla/sccache/releases/download/v0.18.0/sccache-v0.18.0-aarch64-apple-darwin.tar.gz",
        sha256: "308184519b646f5125289e8515b36f6ca65a13a041923994aebe702348674e8e",
        member: "sccache-v0.18.0-aarch64-apple-darwin/sccache",
      },
      "darwin-x64": {
        url: "https://github.com/mozilla/sccache/releases/download/v0.18.0/sccache-v0.18.0-x86_64-apple-darwin.tar.gz",
        sha256: "1dade83cc49eeb42337565eccd534b05982820a8e44b851bd7937467a18c7aef",
        member: "sccache-v0.18.0-x86_64-apple-darwin/sccache",
      },
    },
  },
  "cargo-nextest": {
    version: "0.9.146",
    assets: {
      "linux-x64": {
        url: "https://github.com/nextest-rs/nextest/releases/download/cargo-nextest-0.9.146/cargo-nextest-0.9.146-x86_64-unknown-linux-gnu.tar.gz",
        sha256: "682c21b777c333e96fd532e114d3a5a894e0729ab88d94c0a9f20f8419695428",
        member: "cargo-nextest",
      },
      "linux-arm64": {
        url: "https://github.com/nextest-rs/nextest/releases/download/cargo-nextest-0.9.146/cargo-nextest-0.9.146-aarch64-unknown-linux-gnu.tar.gz",
        sha256: "b2e33d7c72de7ade0ff7b3a948ac37516b24f8a836b7a8870c1f634a94be9de9",
        member: "cargo-nextest",
      },
      "darwin-arm64": {
        url: "https://github.com/nextest-rs/nextest/releases/download/cargo-nextest-0.9.146/cargo-nextest-0.9.146-universal-apple-darwin.tar.gz",
        sha256: "39785160b3c2f6ed9a765049cf4fa79f3b39aa02eb7598a5a0e2a1a0b9ffb9a8",
        member: "cargo-nextest",
      },
      "darwin-x64": {
        url: "https://github.com/nextest-rs/nextest/releases/download/cargo-nextest-0.9.146/cargo-nextest-0.9.146-universal-apple-darwin.tar.gz",
        sha256: "39785160b3c2f6ed9a765049cf4fa79f3b39aa02eb7598a5a0e2a1a0b9ffb9a8",
        member: "cargo-nextest",
      },
    },
  },
};

const platformKey = () => `${process.platform}-${process.arch}`;

/** Returns an absolute path to the tool, installing the pinned build if needed; null if unavailable. */
export async function ensureTool(name) {
  const tool = TOOLS[name];
  // The file must keep the tool's own name: sccache picks its mode from argv[0]
  // and acts as a masquerading compiler under any other name.
  const pinned = join(BIN, `${name}-${tool.version}`, name);
  if (existsSync(pinned)) return pinned;
  if (commandExists(name)) return sh("sh", ["-c", `command -v ${name}`]);
  const asset = tool.assets[platformKey()];
  if (!asset) return null;
  mkdirSync(BIN, { recursive: true });
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`download ${name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256) throw new Error(`download ${name}: sha256 ${digest} != pinned ${asset.sha256}`);
  const staging = join(BIN, `.${name}-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archive = join(staging, "a.tar.gz");
  writeFileSync(archive, bytes);
  sh("tar", ["-xzf", archive, "-C", staging]);
  chmodSync(join(staging, asset.member), 0o755);
  mkdirSync(dirname(pinned), { recursive: true });
  renameSync(join(staging, asset.member), pinned);
  rmSync(staging, { recursive: true, force: true });
  return pinned;
}

/** Makes `cargo nextest` resolvable: cargo finds subcommands as `cargo-<name>` on PATH. */
export async function toolPathDir() {
  const nextest = await ensureTool("cargo-nextest");
  if (nextest && nextest.startsWith(BIN)) {
    const link = join(BIN, "cargo-nextest");
    if (!existsSync(link)) writeFileSync(link, `#!/bin/sh\nexec "${nextest}" "$@"\n`, { mode: 0o755 });
  }
  return BIN;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
