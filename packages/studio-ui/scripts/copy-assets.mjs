// tsc emits only TypeScript; copy source CSS beside the emitted modules and
// remove CSS artifacts whose source files were deleted.
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");
const copied = new Set();

function walkSource(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSource(full);
    else if (entry.endsWith(".css")) {
      const target = join(dist, relative(src, full));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(full, target);
      copied.add(target);
    }
  }
}

function pruneStaleCss(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      pruneStaleCss(full);
      if (readdirSync(full).length === 0) rmSync(full, { recursive: true });
    } else if (entry.endsWith(".css") && !copied.has(full)) {
      rmSync(full);
    }
  }
}

walkSource(src);
pruneStaleCss(dist);

// The harness keeps a long-lived process-exit hook installed for workspace
// commands. This synchronous copier has no asynchronous cleanup to await, so
// terminate explicitly after the copy to avoid that hook converting success
// to SIGABRT in the isolated build runner.
process.exit(0);
