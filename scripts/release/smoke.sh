#!/usr/bin/env bash
# Release smoke: install every published artifact the way a user would and run
# it. Used by release-smoke.yml and by hand (the v0.2.0-rc.0 dry run).
#
#   scripts/release/smoke.sh <check> <tag>
#
# Checks (each prints one JSON line {"check","status","detail"} on stdout and
# exits non-zero on failure; nothing is skipped silently):
#   verify      signatures, checksums, provenance (verify-release.sh)
#   installer   the shell installer from the GitHub release, in clean
#               glibc-2.28..2.39 containers: --help everywhere; `doctor` must
#               pass on Ubuntu 24.04 with lavapipe + ffmpeg installed
#   tarball-arm64  the aarch64 tarball under qemu (needs arm64 binfmt on the host)
#   container   the ghcr image by digest: --help, doctor (lavapipe), ldd clean
#   render      lavapipe render of the fixture package inside the image, and the
#               render's pass hashes against the fixture's expected results
#   wheel       the gym wheel from the release in a fresh venv: import + policy runner
#   native      (macOS/Windows runners) installer, --help, doctor, signature
set -euo pipefail

repo="${SIMFORGE_RELEASE_REPO:-SimForgeinc/simforge-sdk}"
check="${1:?usage: smoke.sh <check> <tag>}"
tag="${2:?usage: smoke.sh <check> <tag>}"
version="${tag#v}"
root="$(git rev-parse --show-toplevel)"
# shellcheck source=layout.sh
source "$root/scripts/release/layout.sh"
work="${SMOKE_WORK:-$(mktemp -d)}"
installer_url="https://github.com/${repo}/releases/download/${tag}/simforge-installer.sh"

report() { printf '{"check":"%s","status":"%s","detail":%s}\n' "$1" "$2" "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$3")"; }
fail() { report "$check" fail "$1"; exit 1; }
plat() { case "$(uname -s)" in Linux) echo Linux ;; Darwin) echo Darwin ;; MINGW*|MSYS*|CYGWIN*) echo Windows ;; *) uname -s ;; esac; }

image_ref() {
  gh release download "$tag" --repo "$repo" --dir "$work" -p container-image.json --clobber
  python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["image"]+"@"+d["digest"])' "$work/container-image.json"
}

case "$check" in
  verify)
    out="$("$root/scripts/release/verify-release.sh" "$tag" --dir "$work/assets")" || fail "verify-release.sh failed"
    report verify pass "$out" ;;

  installer)
    # distro image : glibc
    for distro in rockylinux:8 debian:11 ubuntu:22.04 ubuntu:24.04; do
      case "$distro" in
        rockylinux:*) prep="dnf install -y -q xz >/dev/null" ;;
        *) prep="apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates xz-utils >/dev/null" ;;
      esac
      docker run --rm "$distro" sh -c "set -e; $prep; curl --proto '=https' --tlsv1.2 -LsSf '$installer_url' | CARGO_HOME=/opt/simforge sh -s -- --no-modify-path >/dev/null; /opt/simforge/bin/simforge --help >/dev/null; /opt/simforge/bin/simforge --version" \
        >"$work/installer-$distro.log" 2>&1 || fail "installer on $distro: $(tail -5 "$work/installer-$distro.log")"
      grep -q "$version" "$work/installer-$distro.log" || fail "installer on $distro installed a different version: $(tail -1 "$work/installer-$distro.log")"
    done
    docker run --rm ubuntu:24.04 sh -c "set -e; apt-get update -qq; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates xz-utils mesa-vulkan-drivers libvulkan1 ffmpeg >/dev/null; curl --proto '=https' --tlsv1.2 -LsSf '$installer_url' | CARGO_HOME=/opt/simforge sh -s -- --no-modify-path >/dev/null; /opt/simforge/bin/simforge assets pull --only sky >/dev/null; SIMFORGE_NATIVE_ALLOW_SOFTWARE_ADAPTER=1 /opt/simforge/bin/simforge doctor" \
      >"$work/doctor-ubuntu24.json" 2>"$work/doctor-ubuntu24.err" || fail "doctor on ubuntu:24.04 + lavapipe: $(tail -5 "$work/doctor-ubuntu24.err")"
    report installer pass "shell installer: rockylinux:8 debian:11 ubuntu:22.04 ubuntu:24.04 (--help, --version=$version); doctor passes on ubuntu:24.04+lavapipe" ;;

  tarball-arm64)
    [[ -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ]] || fail "no arm64 binfmt on this host: install qemu-user-static (one-time) to smoke the aarch64 build"
    gh release download "$tag" --repo "$repo" --dir "$work" -p 'simforge-aarch64-unknown-linux-gnu.tar.xz*' --clobber
    (cd "$work" && sha256sum -c simforge-aarch64-unknown-linux-gnu.tar.xz.sha256 >/dev/null) || fail "aarch64 checksum"
    docker run --rm --platform linux/arm64 -v "$work:/w:ro" ubuntu:24.04 sh -c \
      "set -e; apt-get update -qq; apt-get install -y -qq xz-utils >/dev/null; tar -xJf /w/simforge-aarch64-unknown-linux-gnu.tar.xz -C /tmp; /tmp/simforge-aarch64-unknown-linux-gnu/simforge --help >/dev/null; /tmp/simforge-aarch64-unknown-linux-gnu/simforge --version" \
      >"$work/arm64.log" 2>&1 || fail "aarch64 under qemu: $(tail -5 "$work/arm64.log")"
    report tarball-arm64 pass "$(tail -1 "$work/arm64.log")" ;;

  container)
    ref="$(image_ref)"
    docker pull -q "$ref" >/dev/null
    missing="$(docker run --rm --entrypoint ldd "$ref" /usr/local/bin/simforge | grep 'not found' || true)"
    [[ -z "$missing" ]] || fail "image lacks libraries: $missing"
    docker run --rm "$ref" --help >/dev/null || fail "--help in the image"
    docker volume create simforge-smoke-data >/dev/null
    docker run --rm -v simforge-smoke-data:/data "$ref" assets pull --only sky >/dev/null || fail "sky closure pull in the image"
    docker run --rm -e SIMFORGE_DEVICE=cpu -v simforge-smoke-data:/data "$ref" doctor >"$work/doctor-image.json" || fail "doctor in the image (lavapipe)"
    # SIMFORGE_DEVICE=gpu without a GPU must refuse, not render on the CPU.
    if docker run --rm -e SIMFORGE_DEVICE=gpu "$ref" --help >/dev/null 2>&1; then fail "SIMFORGE_DEVICE=gpu without a GPU did not fail"; fi
    report container pass "$ref: ldd clean, --help, doctor (lavapipe), gpu-without-gpu refuses" ;;

  render)
    ref="$(image_ref)"
    [[ -f "$root/$SIMFORGE_SMOKE_PACKAGE" ]] || fail "smoke fixture $SIMFORGE_SMOKE_PACKAGE is missing"
    fixtures="$(dirname "$root/$SIMFORGE_SMOKE_PACKAGE")"
    pkg="/fixtures/$(basename "$SIMFORGE_SMOKE_PACKAGE")"
    rig="/fixtures/$(basename "$SIMFORGE_SMOKE_RIG")"
    mkdir -p "$work/render" && chmod 0777 "$work/render"
    run() { docker run --rm -e SIMFORGE_DEVICE=cpu -v simforge-smoke-data:/data -v "$fixtures:/fixtures:ro" -v "$work/render:/work" "$ref" "$@"; }
    run package verify "$pkg" >"$work/render/verify.json" || fail "package verify"
    run package import "$pkg" --into /work/ws >"$work/render/import.json" || fail "package import"
    run render /work/ws --preset training --rig "$rig" --out /work/out --allow-software-adapter >"$work/render/render.json" || fail "render (lavapipe)"
    [[ -f "$work/render/out/results.json" ]] || fail "render wrote no results.json"
    expected="$fixtures/expected-results.lavapipe.json"
    if [[ -f "$expected" ]]; then
      python3 - "$expected" "$work/render/out/results.json" <<'PY' || fail "pass hashes differ from the recorded lavapipe goldens"
import json, sys
want = json.load(open(sys.argv[1]))["passes"]
got = json.load(open(sys.argv[2]))["passes"]
bad = [k for k, v in want.items() if got.get(k, {}).get("sha256") != v["sha256"]]
sys.exit(1 if bad else 0)
PY
      report render pass "lavapipe render of $(basename "$SIMFORGE_SMOKE_PACKAGE") matches the recorded pass hashes"
    else
      fail "no expected-results.lavapipe.json beside the fixture: record the goldens on path-pc (golden.mjs record) first"
    fi ;;

  wheel)
    check="wheel-$(plat)"
    python="${PYTHON:-python3}"
    gh release download "$tag" --repo "$repo" --dir "$work/wheels" -p '*.whl' --clobber
    "$python" -m venv "$work/venv"
    if [[ -x "$work/venv/bin/python" ]]; then vpy="$work/venv/bin/python"; else vpy="$work/venv/Scripts/python.exe"; fi
    pyver="$("$python" - "$version" <<'PY'
import re, sys
m = re.match(r"(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.(\d+))?$", sys.argv[1])
print(m.group(1) + ({"alpha": "a", "beta": "b", "rc": "rc"}[m.group(2)] + m.group(3) if m.group(2) else ""))
PY
)"
    # Only this release's files for the five dists (no index); the gym's and
    # timeline's native extensions must import; every dist must report the
    # release version. Third-party deps (warp, mujoco, torch) are not smoked.
    dists="simforge-oss-gym simforge-oss-timeline simforge-oss-gpu simforge-oss-physics simforge-oss-render"
    for d in $dists; do
      "$vpy" -m pip install -q --no-index --no-deps --find-links "$work/wheels" "$d==$pyver" \
        || fail "pip install of the release wheel $d==$pyver"
    done
    "$vpy" -m pip install -q gymnasium numpy >/dev/null || fail "installing gymnasium/numpy"
    "$vpy" -c "import simforge_oss_gym._native, simforge_oss_timeline._native" || fail "native extensions do not import"
    "$vpy" - "$pyver" $dists <<'PY' || fail "a dist reports the wrong version"
import importlib.metadata as m, sys
bad = [d for d in sys.argv[2:] if m.version(d) != sys.argv[1]]
sys.exit(1 if bad else 0)
PY
    report "$check" pass "5 dists at $pyver from the release; gym and timeline extensions import" ;;

  native)
    check="native-$(plat)"
    case "$(uname -s)" in
      Darwin|Linux)
        curl --proto '=https' --tlsv1.2 -LsSf "$installer_url" | CARGO_HOME="$work/cargo" sh -s -- --no-modify-path >/dev/null || fail "shell installer"
        bin="$work/cargo/bin/simforge" ;;
      *)
        powershell -ExecutionPolicy Bypass -c "\$env:CARGO_HOME='$work\\cargo'; \$env:SIMFORGE_NO_MODIFY_PATH='1'; irm https://github.com/${repo}/releases/download/${tag}/simforge-installer.ps1 | iex" >/dev/null || fail "powershell installer"
        bin="$work/cargo/bin/simforge.exe" ;;
    esac
    "$bin" --help >/dev/null || fail "--help"
    "$bin" --version | grep -q "$version" || fail "--version is not $version"
    # No GPU is guaranteed on hosted runners: doctor must run and report, and
    # its verdict is recorded rather than required.
    set +e; "$bin" doctor >"$work/doctor.json" 2>"$work/doctor.err"; code=$?; set -e
    [[ $code -le 2 ]] || fail "doctor crashed (exit $code): $(tail -3 "$work/doctor.err")"
    report "$check" pass "installer, --help, --version=$version, doctor exit $code" ;;

  *) echo "unknown check $check" >&2; exit 2 ;;
esac
