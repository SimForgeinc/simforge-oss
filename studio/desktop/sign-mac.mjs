import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { unsignedMachO } from "./stage-manifest.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/** Capture the verified runtime before signing, then update only identities changed by signatures. */
export function prepareRuntimeSeal(runtimeRoot) {
  const root = resolve(runtimeRoot);
  const pathFor = relative => {
    if (typeof relative !== "string" || relative.split(/[\\/]/).some(part => !part || part === "." || part === "..")) throw new Error("Invalid runtime member path");
    const path = resolve(root, relative);
    if (!path.startsWith(root + sep)) throw new Error("Runtime member escapes its root");
    return path;
  };
  const manifestPath = join(root, "bin", "runtime-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schema !== "simforge.native-runtime/v1" || !Array.isArray(manifest.components)) throw new Error("Invalid native runtime manifest");
  const identities = [[`bin/${manifest.binary.name}`, manifest.binary], ...manifest.components.map(component => [component.install, component])];
  const originals = new Map();
  const checksumsPath = join(root, "SHA256SUMS");
  const checksumEntries = readFileSync(checksumsPath, "utf8").trim().split(/\r?\n/).map(line => {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) throw new Error("Invalid runtime checksum entry");
    const bytes = readFileSync(pathFor(match[2]));
    if (sha256(bytes) !== match[1]) throw new Error(`Unsigned runtime checksum mismatch: ${match[2]}`);
    const original = { sha256: match[1], sizeBytes: bytes.length,
      unsignedSha256: bytes.length >= 4 && bytes.readUInt32LE(0) === 0xfeedfacf ? unsignedMachO(bytes).sha256 : null };
    originals.set(match[2], original);
    return { relative: match[2], original };
  });
  for (const [relative, identity] of identities) {
    const original = originals.get(relative);
    if (!original || original.sha256 !== identity.sha256 || original.sizeBytes !== identity.sizeBytes) throw new Error(`Unsigned runtime identity mismatch: ${relative}`);
  }
  const verifySignedBytes = (relative, original) => {
    const bytes = readFileSync(pathFor(relative));
    const digest = sha256(bytes);
    if (digest !== original.sha256 && (!original.unsignedSha256 || unsignedMachO(bytes).sha256 !== original.unsignedSha256)) throw new Error(`Signing changed runtime code, not only its signature: ${relative}`);
    return { sha256: digest, sizeBytes: bytes.length };
  };
  return () => {
    // Validate every runtime member before writing either manifest. A changed data file,
    // unknown binary mutation or malformed Mach-O must fail rather than be re-blessed.
    const signed = new Map();
    for (const entry of checksumEntries) {
      if (entry.relative !== "bin/runtime-manifest.json") signed.set(entry.relative, verifySignedBytes(entry.relative, entry.original));
    }
    for (const [relative, identity] of identities) Object.assign(identity, signed.get(relative));
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    signed.set("bin/runtime-manifest.json", { sha256: sha256(manifestBytes), sizeBytes: manifestBytes.length });
    writeFileSync(manifestPath, manifestBytes);
    writeFileSync(checksumsPath, checksumEntries.map(({ relative }) => `${signed.get(relative).sha256}  ${relative}\n`).join(""));
  };
}

/** osx-sign signs children first and invokes optionsForFile immediately before each signature. */
export default async function signMac(options) {
  const require = createRequire(import.meta.url);
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const { signAsync } = createRequire(builderRequire.resolve("app-builder-lib/package.json"))("@electron/osx-sign");
  const app = resolve(options.app);
  const stageRoot = join(app, "Contents", "Resources", "studio");
  const stage = JSON.parse(readFileSync(join(stageRoot, "stage-manifest.json"), "utf8"));
  const seal = prepareRuntimeSeal(join(stageRoot, stage.nativeRuntimeRoot));
  let sealed = false;
  await signAsync({
    ...options,
    optionsForFile(file) {
      if (resolve(file) === app) {
        seal();
        sealed = true;
      }
      return options.optionsForFile?.(file) ?? {};
    },
  });
  if (!sealed) throw new Error("Runtime manifest was not sealed before the outer app signature");
}
