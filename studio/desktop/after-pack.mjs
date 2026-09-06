import { cp, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertStagePlatform, readStageManifest } from "./stage-manifest.mjs";

/** Copy the sealed stage verbatim; resource filtering must not prune its pnpm closure. */
export default async function afterPack(context) {
  const source = fileURLToPath(new URL("../dist/desktop/resources/", import.meta.url));
  const target = join(context.packager.getResourcesDir(context.appOutDir), "studio");
  await cp(source, target, { recursive: true, verbatimSymlinks: true });
  const manifest = await readStageManifest(target);
  assertStagePlatform(manifest);
  const require = createRequire(join(target, manifest.server));
  for (const name of ["next", "@electric-sql/pglite", "sharp", "playwright-core"]) {
    const entry = await realpath(require.resolve(name));
    if (!entry.startsWith(target + sep)) {
      throw new Error(`Packaged ${name} resolves outside Studio resources: ${entry}`);
    }
  }
}
