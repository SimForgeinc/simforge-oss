import { access, constants, cp, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertStagePlatform, readStageManifest, verifyNativeClosure } from "./stage-manifest.mjs";

/**
 * Copy the sealed stage verbatim into the package's resources; electron-builder's
 * own resource filtering must not prune its pnpm closure. Then prove the
 * packaged host resolves its disk-loaded packages inside the package, that
 * the native payload the manifest names is present and executable, and that
 * every native binding, executable and library in the package was built for
 * this platform (a Linux closure never ships as a Windows or macOS payload).
 */
export default async function afterPack(context) {
  const source = fileURLToPath(new URL("../dist/desktop/resources/", import.meta.url));
  const target = join(context.packager.getResourcesDir(context.appOutDir), "studio");
  await cp(source, target, { recursive: true, verbatimSymlinks: true });
  const manifest = await readStageManifest(target);
  assertStagePlatform(manifest);
  const require = createRequire(join(target, manifest.server));
  for (const name of ["next", "@electric-sql/pglite", "sharp", "playwright-core", "@napi-rs/keyring"]) {
    const entry = await realpath(require.resolve(name));
    if (!entry.startsWith(target + sep)) {
      throw new Error(`Packaged ${name} resolves outside Studio resources: ${entry}`);
    }
  }
  for (const rel of [manifest.nativeRunner, manifest.nativeRenderService, manifest.tools.ffmpeg, manifest.tools.ffprobe]) {
    await access(join(target, rel), process.platform === "win32" ? constants.R_OK : constants.X_OK).catch(() => {
      throw new Error(`Packaged native executable is missing or not executable: ${rel}`);
    });
  }
  for (const rel of [manifest.nativeAddon, manifest.nativeRenderLibrary, join(manifest.actorAssetsRoot, "closures"), manifest.browserHarness]) {
    await access(join(target, rel)).catch(() => {
      throw new Error(`Packaged resource is missing: ${rel}`);
    });
  }
  const problems = await verifyNativeClosure(target, manifest);
  if (problems.length > 0) {
    throw new Error(`Packaged native closure is not ${manifest.platform}-${manifest.arch}:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
}
