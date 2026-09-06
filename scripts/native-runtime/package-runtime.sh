#!/usr/bin/env bash
# Packages the built runtime into one distributable archive:
#   dist/native-runtime/simforge-native-runtime-<version>-<target>.tar.gz
# containing
#   bin/simforge-runner  bin/native-render-service  bin/runtime-manifest.json
#   lib/libsimforge_render.so
#   wheels/*.whl          (simforge-oss-gym, -physics, -gpu, -native-renderer, -splat)
#   share/sky/            (SOURCES.json + NASA-derived .skytex plates, when built)
#   SHA256SUMS
# Every entry is listed with its digest in runtime-manifest.json (components).
#
# Usage: scripts/native-runtime/package-runtime.sh [build-runner.sh flags]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
"$REPO_ROOT/scripts/native-runtime/build-runner.sh" "$@" >/dev/null

TARGET=""
for ((i = 1; i <= $#; i++)); do
  if [[ "${!i}" == "--target" ]]; then j=$((i + 1)); TARGET="${!j}"; fi
done
if [[ -n "$TARGET" ]]; then
  NATIVE_OUT="$REPO_ROOT/native/target/$TARGET/release"
  RENDER_OUT="$REPO_ROOT/renderer/target/$TARGET/release"
else
  TARGET="$(rustc -vV | sed -n 's/^host: //p')"
  NATIVE_OUT="$REPO_ROOT/native/target/release"
  RENDER_OUT="$REPO_ROOT/renderer/target/release"
fi
MANIFEST="$NATIVE_OUT/runtime-manifest.json"
WHEELS_DIR="$REPO_ROOT/dist/native-runtime/wheels"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/bin" "$STAGE/lib" "$STAGE/wheels" "$STAGE/share"
cp "$NATIVE_OUT/simforge-runner" "$STAGE/bin/simforge-runner"
cp "$RENDER_OUT/native-render-service" "$STAGE/bin/native-render-service"
cp "$RENDER_OUT/libsimforge_render.so" "$STAGE/lib/libsimforge_render.so"
cp "$MANIFEST" "$STAGE/bin/runtime-manifest.json"
if compgen -G "$WHEELS_DIR/*.whl" >/dev/null; then cp "$WHEELS_DIR"/*.whl "$STAGE/wheels/"; fi
# Assets are copied from the manifest's component list (each records the
# absolute source it was hashed from), never by directory glob.
node -e '
const fs = require("fs"); const path = require("path");
const [stage, manifestPath] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const c of manifest.components.filter((c) => c.kind === "asset")) {
  if (!c.source) { console.error(JSON.stringify({ code: "runtime.package_failed", reason: `${c.install} has no source path` })); process.exit(1); }
  fs.mkdirSync(path.dirname(path.join(stage, c.install)), { recursive: true });
  fs.copyFileSync(c.source, path.join(stage, c.install));
}
' "$STAGE" "$MANIFEST"

# Every component the manifest lists must be in the archive with the same bytes.
node -e '
const fs = require("fs"); const path = require("path"); const crypto = require("crypto");
const [stage, manifestPath] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const c of manifest.components) {
  const file = path.join(stage, c.install);
  if (!fs.existsSync(file)) { console.error(JSON.stringify({ code: "runtime.package_failed", reason: `${c.install} missing from stage` })); process.exit(1); }
  const sha = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (sha !== c.sha256) { console.error(JSON.stringify({ code: "runtime.package_failed", reason: `${c.install} digest mismatch` })); process.exit(1); }
}
' "$STAGE" "$MANIFEST"

(cd "$STAGE" && find bin lib wheels share -type f | sort | xargs sha256sum > SHA256SUMS)
VERSION="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$MANIFEST")"
DIST="$REPO_ROOT/dist/native-runtime"
mkdir -p "$DIST"
ARCHIVE="$DIST/simforge-native-runtime-$VERSION-$TARGET.tar.gz"
tar -C "$STAGE" -czf "$ARCHIVE" bin lib wheels share SHA256SUMS
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"

node -e '
const [archive, manifest] = process.argv.slice(1);
const fs = require("fs");
process.stdout.write(JSON.stringify({
  schema: "simforge.native-runtime-package/v1",
  archive,
  archiveSha256: fs.readFileSync(`${archive}.sha256`, "utf8").split(/\s+/)[0],
  runtime: JSON.parse(fs.readFileSync(manifest, "utf8")),
}) + "\n");
' "$ARCHIVE" "$MANIFEST"
