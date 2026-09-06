// tsc emits only TypeScript; the editor shell's CSS module ships beside its
// component so the emitted import `./ScenarioEditorShell.module.css` resolves.
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
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
