#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const binary = process.env.SIMFORGE_NATIVE_VIEWPORT ?? resolve(root, "renderer/target/debug/simforge-native-viewport");
const mapRoot = process.env.SIMFORGE_NATIVE_MAP_ROOT;
if (!mapRoot) throw new Error("SIMFORGE_NATIVE_MAP_ROOT is required");
await access(binary);

const args = [binary, "--map-root", mapRoot, "--map-version-id", process.env.SIMFORGE_NATIVE_MAP_ID ?? "smoke-map", "--release-digest", process.env.SIMFORGE_NATIVE_RELEASE_DIGEST ?? "smoke-release"];
const child = spawn("xvfb-run", ["-a", ...args], { stdio: ["pipe", "pipe", "inherit"] });
const events = [];
let output = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  output += chunk;
  for (const line of output.split("\n").slice(0, -1)) {
    try { events.push(JSON.parse(line)); } catch {}
  }
  output = output.split("\n").at(-1) ?? "";
});
const timer = setTimeout(() => child.kill("SIGTERM"), Number(process.env.SIMFORGE_NATIVE_SMOKE_TIMEOUT_MS ?? 20_000));
const exit = await new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
clearTimeout(timer);
const interactive = events.find((event) => event.event === "interactive");
if (!interactive) throw new Error(`native viewport never became interactive: ${JSON.stringify({ exit, events })}`);
console.log(JSON.stringify({ renderer: interactive.renderer, mapVersionId: interactive.map_version_id, releaseDigest: interactive.release_digest, elapsedMs: interactive.elapsed_ms, exit }));
