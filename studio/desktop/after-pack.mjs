import { access, constants, cp, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { matchesPin, toolPins } from "./fetch-tools.mjs";
import { assertStagePlatform, readStageManifest, targetFor, verifyNativeClosure } from "./stage-manifest.mjs";

/** @type {{ Arch: Record<number, string> }} */
const { Arch } = createRequire(import.meta.url)("electron-builder");

/**
 * Copy the sealed stage verbatim into the package's resources; electron-builder's
 * own resource filtering must not prune its pnpm closure. Then prove the stage
 * is for the platform and architecture electron-builder is packaging (not
 * merely for the build host: a `--x64` run on an arm64 Mac must fail here, not
 * ship an arm64 payload under an x64 name), that the packaged host resolves
 * its disk-loaded packages inside the package, that the native payload the
 * manifest names is present and executable, that every native binding,
 * executable and library in the package was built for this target (a Linux
 * closure never ships as a Windows or macOS payload), and that the pinned
 * encoders are still byte-identical to desktop/tools.lock.json. This hook runs
 * before electron-builder signs, so that last check is the pre-signature link
 * of the encoders' integrity chain; desktop/verify-package.mjs holds the
 * post-signature link.
 */
export default async function afterPack(context) {
  const source = fileURLToPath(new URL("../dist/desktop/resources/", import.meta.url));
  const target = join(context.packager.getResourcesDir(context.appOutDir), "studio");
  await cp(source, target, { recursive: true, verbatimSymlinks: true });
  const manifest = await readStageManifest(target);
  const packaging = { platform: context.electronPlatformName, arch: Arch[context.arch] };
  if (manifest.platform !== packaging.platform || manifest.arch !== packaging.arch) {
    throw new Error(
      `The stage is for ${manifest.platform}-${manifest.arch} (${manifest.target}) but electron-builder is packaging ${packaging.platform}-${packaging.arch}; ` +
        "package with this stage's --<arch> only, or stage on the target's native runner.",
    );
  }
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
  const pins = toolPins(targetFor(manifest.platform, manifest.arch).key);
  for (const name of /** @type {const} */ (["ffmpeg", "ffprobe"])) {
    if (!(await matchesPin(join(target, manifest.tools[name]), pins[name]))) {
      throw new Error(`Packaged ${manifest.tools[name]} does not match desktop/tools.lock.json before signing`);
    }
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
