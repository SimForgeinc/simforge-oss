// tsc emits only TypeScript; the editor shell's CSS module ships beside its
// component so the emitted import `./ScenarioEditorShell.module.css` resolves.
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry.endsWith(".css")) {
      const target = join(dist, relative(src, full));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(full, target);
    }
  }
}
walk(src);

// The harness keeps a long-lived process-exit hook installed for workspace
// commands. This synchronous copier has no asynchronous cleanup to await, so
// terminate explicitly after the copy to avoid that hook converting success to
// SIGABRT in the isolated build runner.
process.exit(0);
