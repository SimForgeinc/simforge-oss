import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * The native viewport child process, as the Electron main process sees it.
 *
 * Identity is not baked into argv any more: the process is launched with the
 * map root it is anchored to and then told which release to load, so the main
 * process can verify identity against the studio's `native-profile` endpoint
 * before any bytes are opened. stdout is newline-delimited JSON
 * (`renderer/viewport/PROTOCOL.md`); the process writes its own logs to
 * stderr, and any non-JSON line here is therefore log noise, not an event.
 */
export class NativeViewportProcess {
  #child = null;
  #events = new Set();
  #ready = null;
  #exited = false;

  constructor({ executable, mapRoot, headless = false, embedded = false, geometry = null, args = [] }) {
    this.executable = executable;
    this.mapRoot = mapRoot;
    this.headless = headless;
    this.embedded = embedded;
    this.geometry = geometry;
    this.extraArgs = args;
  }

  onEvent(listener) {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  #emit(event) {
    for (const listener of this.#events) listener(event);
  }

  start() {
    if (this.#child) return this.#ready;
    const argv = ["--map-root", this.mapRoot];
    if (this.headless) argv.push("--headless");
    if (this.embedded) argv.push("--embedded");
    if (this.geometry) {
      argv.push("--width", String(Math.round(this.geometry.width)), "--height", String(Math.round(this.geometry.height)));
      if (Number.isFinite(this.geometry.x) && Number.isFinite(this.geometry.y)) {
        argv.push("--x", String(Math.round(this.geometry.x)), "--y", String(Math.round(this.geometry.y)));
      }
    }
    argv.push(...this.extraArgs);
    this.#child = spawn(this.executable, argv, { stdio: ["pipe", "pipe", "pipe"] });
    this.#ready = new Promise((resolve, reject) => {
      const lines = createInterface({ input: this.#child.stdout });
      lines.on("line", (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (typeof event?.event !== "string") return;
        this.#emit(event);
        // "up" means the process is talking, not that a map is loaded: the
        // load is a separate command whose result arrives as readiness.
        resolve(event);
      });
      this.#child.stderr.setEncoding("utf8");
      this.#child.once("error", reject);
      this.#child.once("exit", (code, signal) => {
        this.#exited = true;
        this.#emit({ event: "closed", code: code ?? -1, signal: signal ?? null });
        if (code !== 0) reject(new Error(`native viewport exited (${signal ?? code})`));
      });
    });
    return this.#ready;
  }

  get running() {
    return Boolean(this.#child) && !this.#exited;
  }

  /** stderr stream for log capture; null before `start`. */
  get stderr() {
    return this.#child?.stderr ?? null;
  }

  send(command) {
    if (!this.#child?.stdin.writable) throw new Error("native viewport is not running");
    this.#child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  loadMap({ mapRoot, mapVersionId, releaseDigest }) {
    this.send({ command: "load-map", mapRoot, mapVersionId, releaseDigest });
  }

  setCamera(position, target) {
    this.send({ command: "camera", position, target });
  }

  stop() {
    if (this.#child?.stdin.writable) {
      try { this.send({ command: "quit" }); } catch { /* already gone */ }
    }
    this.#child?.stdin.end();
    this.#child?.kill();
    this.#child = null;
    this.#ready = null;
  }
}
