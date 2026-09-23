// Machine-wide semaphore for heavy builds (cargo, wasm, turbo, next build).
// 4-8 agents share one workstation; without a cap they all link Bevy at once
// and the box swaps. Slots are pid files under ~/.cache/devflow/slots; a slot
// whose owner died is reclaimed. Every holder also gets a fair share of cores
// (CARGO_BUILD_JOBS / turbo --concurrency) so N slots never oversubscribe.
import { cpus, totalmem } from "node:os";
import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CACHE_ROOT } from "./util.mjs";

const DIR = join(CACHE_ROOT, "slots");

export function slotCount() {
  const fromEnv = Number(process.env.DEVFLOW_HEAVY_SLOTS);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  const cores = cpus().length;
  const ramGb = totalmem() / 2 ** 30;
  // ~6 cores and ~12 GB per concurrent heavy build.
  return Math.max(1, Math.min(Math.floor(cores / 6), Math.floor(ramGb / 12)));
}

export function jobsPerSlot() {
  return Math.max(2, Math.floor(cpus().length / slotCount()));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function tryTake(file, label) {
  try {
    const fd = openSync(file, "wx");
    writeSync(fd, `${process.pid} ${label}\n`);
    closeSync(fd);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let pid = 0;
    try {
      pid = Number(readFileSync(file, "utf8").split(" ")[0]);
    } catch {
      return false;
    }
    if (pid && !alive(pid)) {
      try {
        unlinkSync(file);
      } catch {}
      return tryTake(file, label);
    }
    return false;
  }
}

export function busySlots() {
  try {
    return readdirSync(DIR)
      .filter((f) => f.startsWith("slot-"))
      .map((f) => {
        try {
          const [pid, ...label] = readFileSync(join(DIR, f), "utf8").trim().split(" ");
          return alive(Number(pid)) ? { slot: f, pid: Number(pid), label: label.join(" ") } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Waits for a slot; resolves a release() function. Prints once while waiting. */
export async function acquireSlot(label, { log = (m) => console.log(m) } = {}) {
  if (process.env.DEVFLOW_SLOT_HELD === "1") return () => {}; // nested: parent holds one
  mkdirSync(DIR, { recursive: true });
  const n = slotCount();
  let announced = false;
  const waitStart = Date.now();
  for (;;) {
    for (let i = 0; i < n; i += 1) {
      const file = join(DIR, `slot-${i}`);
      if (tryTake(file, label)) {
        const waited = Date.now() - waitStart;
        if (announced) log(`        got heavy-build slot ${i + 1}/${n} after ${(waited / 1000).toFixed(0)}s`);
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          try {
            unlinkSync(file);
          } catch {}
        };
        process.once("exit", release);
        return release;
      }
    }
    if (!announced) {
      announced = true;
      const holders = busySlots().map((s) => `${s.label}(pid ${s.pid})`).join(", ");
      log(`        waiting for a heavy-build slot (${n} busy: ${holders})`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
