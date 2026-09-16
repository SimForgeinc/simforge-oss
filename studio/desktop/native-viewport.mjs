import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * Minimal Electron-side transport for the native viewport process. The UI can
 * use this seam without knowing whether its renderer is native or Three.js.
 */
export class NativeViewportProcess {
  #child = null;
  #events = new Set();
  #ready = null;

  constructor({ executable, mapRoot, mapVersionId, releaseDigest, headless = false }) {
    this.executable = executable;
    this.mapRoot = mapRoot;
    this.mapVersionId = mapVersionId;
    this.releaseDigest = releaseDigest;
    this.headless = headless;
  }

  onEvent(listener) {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  start() {
    if (this.#child) throw new Error("native viewport is already running");
    this.#child = spawn(this.executable, [
      "--map-root", this.mapRoot,
      "--map-version-id", this.mapVersionId,
      "--release-digest", this.releaseDigest,
      ...(this.headless ? ["--headless"] : []),
    ], { stdio: ["pipe", "pipe", "pipe"] });
    this.#ready = new Promise((resolve, reject) => {
      const lines = createInterface({ input: this.#child.stdout });
      lines.on("line", (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        for (const listener of this.#events) listener(event);
        if (event.event === "interactive") resolve(event);
        if (event.event === "error") reject(new Error(event.error ?? "native viewport failed"));
      });
      this.#child.once("error", reject);
      this.#child.once("exit", (code, signal) => {
        if (code !== 0) reject(new Error(`native viewport exited (${signal ?? code})`));
      });
    });
    return this.#ready;
  }

  setCamera(position, target) {
    if (!this.#child?.stdin.writable) throw new Error("native viewport is not running");
    this.#child.stdin.write(`${JSON.stringify({ command: "camera", position, target })}\n`);
  }

  stop() {
    this.#child?.stdin.end();
    this.#child?.kill();
    this.#child = null;
    this.#ready = null;
  }
}
