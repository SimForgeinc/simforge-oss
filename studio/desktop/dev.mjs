// The desktop shell on live sources.
//
// `electron .` attaches to the `pnpm dev` host already serving on port 5199
// (desktop/local-host.mjs adopts a running host of the same version), so the
// renderer hot-reloads through Next. The main process, however, resolves
// workspace packages through Node, which means `dist/` - stale or absent after
// a checkout. Running Electron's Node with tsx and the `development` export
// condition resolves them from `src/` too, so no package build is needed.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const studioRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const electron = createRequire(import.meta.url)("electron");
const child = spawn(electron, [studioRoot, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import tsx --conditions=development"].filter(Boolean).join(" "),
  },
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
