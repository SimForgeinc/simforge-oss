#!/usr/bin/env bash
# gate-local.sh: the SDK merge gate. The merger runs it (as of main, never a
# PR's copy) on the exact merge commit it is about to land; contributors run it
# before labelling a PR `ready`.
#
#   scripts/gate-local.sh            gate HEAD of this checkout
#
# Steps (the first failure stops the gate; affected = changed since the base):
#   boundary   scripts/check-boundary.sh (no TypeScript; cargo metadata proves
#              no path dependency leaves the checkout; uv/maturin paths inside)
#   rust:<ws>  per Cargo workspace: rustfmt and clippy on the files this change
#              touched (main is not fmt/clippy-clean everywhere yet: a ratchet),
#              then cargo nextest over the workspace
#   python     pytest for every affected Python package (uv, locked toolchain)
#   goldens    lavapipe render goldens (qualification/golden-harness), when the
#              renderer, the engine core, the harness or its fixtures changed
#
# The base is the merge base of HEAD and origin/main, or HEAD^1 when HEAD is
# already on main. No skip flags. The tree must be clean.
#
# Sandbox. The steps run PR code, so the merge service runs them in a container
# with no credentials, no docker socket, no GPU (lavapipe only), the host git
# objects read-only, its own caches, and egress only through an allowlisting
# proxy. The container and proxy definitions are the operator's, not this
# repository's: GATE_SANDBOX_DEFS names a directory holding Dockerfile,
# proxy.Dockerfile, squid.conf and allowlist.
#   GATE_SANDBOX=off       (default) on the host: your own code on your machine
#   GATE_SANDBOX=required  the merge service: never run PR code on the host
# Map corpora (GATE_SANDBOX_MAPS, default the local map cache) and verified sky
# plates (GATE_SANDBOX_SKY) are mounted read-only. The record says which mode ran.
# `scripts/gate-local.sh --step <name> [args]` runs one step (what the sandbox
# executes); it writes no record.
# Records: $GATE_HOME/records.jsonl (hash chain + HMAC with $GATE_HOME/.gate-key),
# run logs under $GATE_HOME/runs/<id>/. Exit 0 pass, 1 fail, 2 could not run.
# The LAST line is always
#   GATE PASS|FAIL|ERROR sha=<sha> time=<s>s [failing=<step>] record=<path>
set -uo pipefail

if test "${1:-}" = --step; then
  # One step, in the current checkout; GATE_BASE names the base. No record.
  shift; step="$1"; shift
  root="$(git rev-parse --show-toplevel)"; cd "$root"
  changed="$(git diff --name-only "$GATE_BASE" HEAD)"
  out="${GATE_STEP_OUT:-$(mktemp -d)}"; mkdir -p "$out"
  ratchet() { # <workspace dir> <fmt log> <clippy log>
    local ws="$1" bad="" f
    local fmt_files; fmt_files="$(grep -oE '^Diff in [^:]+' "$2" | sed "s#^Diff in $root/##" | sort -u)"
    local clippy_files; clippy_files="$(grep -oE -- '--> [^:]+' "$3" | sed 's/^--> //' | sed "s#^#$ws/#" | sort -u)"
    for f in $fmt_files; do grep -qxF "$f" <<<"$changed" && bad+=" rustfmt:$f"; done
    for f in $clippy_files; do f="$(realpath -m --relative-to="$root" "$root/$f")"; grep -qxF "$f" <<<"$changed" && bad+=" clippy:$f"; done
    test -z "$bad" || { echo "ratchet: files this change touched need fixing:$bad"; return 1; }
  }
  case "$step" in
    boundary) exec scripts/check-boundary.sh ;;
    rust)
      ws="$1"
      ( cd "$ws" && cargo fmt --check ) >"$out/fmt.txt" 2>&1
      ( cd "$ws" && cargo clippy --all-targets --message-format=short -- --cap-lints warn ) >"$out/clippy.txt" 2>&1 || { tail -40 "$out/clippy.txt"; exit 1; }
      ratchet "$ws" "$out/fmt.txt" "$out/clippy.txt" || exit 1
      cd "$ws" && exec cargo nextest run --no-fail-fast --no-tests=pass ;;
    python)
      rc=0
      for d in "$@"; do
        echo "== pytest $d"
        # CPU only (GPU-only tests skip themselves). A maturin package is rebuilt
        # from this checkout (uv caches wheels by version, not by content).
        rebuild=()
        if grep -q 'build-backend = "maturin"' "$d/pyproject.toml"; then
          rebuild=(--reinstall-package "$(python3 -c 'import sys,tomllib; print(tomllib.load(open(sys.argv[1],"rb"))["project"]["name"])' "$d/pyproject.toml")")
        fi
        ( cd "$d" && CUDA_VISIBLE_DEVICES="" uv run --quiet "${rebuild[@]}" --with pytest python -m pytest -q -p no:cacheprovider ) || rc=1
      done
      exit $rc ;;
    goldens)
      maps="${SIMFORGE_MAPS_CACHE_ROOT:-$HOME/.local/share/simforge/maps}"
      export SIMFORGE_CORPUS_RICHMOND="${SIMFORGE_CORPUS_RICHMOND:-$maps/.corpus/richmond-field-station}"
      export SIMFORGE_CORPUS_YALE="${SIMFORGE_CORPUS_YALE:-$maps/.corpus/yale-street}"
      exec qualification/golden-harness/ci-local.sh verify ;;
    *) echo "gate: unknown step $step" >&2; exit 2 ;;
  esac
fi

GATE_HOME="${GATE_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/simforge-gate}"
TRUNK="main"
LOCK_WAIT_S="${GATE_LOCK_WAIT_S:-5400}"
script_path="$(readlink -f "${BASH_SOURCE[0]}")"
script_sha="$(sha256sum "$script_path" | cut -d' ' -f1)"
root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "GATE ERROR sha=- time=0s not a git checkout"; exit 2; }
cd "$root"
mkdir -p "$GATE_HOME/runs"
started=$(date +%s)
sha="$(git rev-parse HEAD)"
die() { echo "gate: $1" >&2; echo "GATE ERROR sha=$sha time=$(( $(date +%s) - started ))s $1"; exit 2; }

test -z "$(git status --porcelain --untracked-files=normal)" || { git status --short | head -20 >&2; die "the working tree is not clean"; }
if test "${GATE_SANDBOX:-off}" = required; then tools="git jq docker"; else tools="git jq cargo uv python3 node"; fi
for tool in $tools; do command -v "$tool" >/dev/null || die "missing tool: $tool"; done
test "${GATE_SANDBOX:-off}" = required || cargo nextest --version >/dev/null 2>&1 || die "missing tool: cargo-nextest"

exec 9>"$GATE_HOME/gate.lock"
if ! flock -n 9; then
  echo "gate: another gate holds $GATE_HOME/gate.lock; waiting (up to ${LOCK_WAIT_S}s)"
  flock -w "$LOCK_WAIT_S" 9 || die "timed out waiting for the gate lock"
fi

git fetch --no-tags --quiet origin "+refs/heads/$TRUNK:refs/remotes/origin/$TRUNK" || die "git fetch origin $TRUNK failed"
base="$(git merge-base HEAD "origin/$TRUNK")" || die "no merge base with origin/$TRUNK"
if test "$base" = "$sha"; then base="$(git rev-parse HEAD^1 2>/dev/null || echo "$sha")"; fi
run_id="sdk-$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:12}"
run_dir="$GATE_HOME/runs/$run_id"
mkdir -p "$run_dir"
changed="$(git diff --name-only "$base" HEAD)"
printf '%s\n' "$changed" >"$run_dir/changed.txt"
echo "gate: $sha (base ${base:0:12}, $(grep -c . <<<"$changed") files changed) -> $run_dir"
touched() { grep -Eq "$1" <<<"$changed"; }
if command -v sccache >/dev/null; then export RUSTC_WRAPPER=sccache; fi
export CARGO_TERM_COLOR=never CI=true

steps_json="[]"; failing=""
record_step() { steps_json="$(jq -c --arg n "$1" --arg s "$2" --argjson t "$3" --arg l "$4" --arg d "$5" '. + [{name:$n,status:$s,seconds:$t,log:$l,detail:$d}]' <<<"$steps_json")"; printf '  %-4s  %-22s %5ss  %s\n' "$(tr a-z A-Z <<<"$2")" "$1" "$3" "$5"; }
SANDBOX="${GATE_SANDBOX:-off}"
container=""
cleanup() { test -n "$container" && docker rm -f "$container" >/dev/null 2>&1; return 0; }
trap cleanup EXIT
if test "$SANDBOX" = required; then
  defs_src="${GATE_SANDBOX_DEFS:?GATE_SANDBOX=required needs GATE_SANDBOX_DEFS (Dockerfile, proxy.Dockerfile, squid.conf, allowlist)}"
  docker info >/dev/null 2>&1 || die "GATE_SANDBOX=required but docker is not usable"
  defs="$run_dir/sandbox-defs"; mkdir -p "$defs"
  for f in Dockerfile proxy.Dockerfile squid.conf allowlist; do cp "$defs_src/$f" "$defs/$f" 2>/dev/null || die "$defs_src/$f missing"; done
  gate_tag="simforge-gate:$(sha256sum <"$defs/Dockerfile" | cut -c1-12)"
  proxy_tag="simforge-gate-proxy:$(cat "$defs"/proxy.Dockerfile "$defs"/squid.conf "$defs"/allowlist | sha256sum | cut -c1-12)"
  docker image inspect "$gate_tag" >/dev/null 2>&1 ||
    docker build -q -t "$gate_tag" --build-arg UID="$(id -u)" --build-arg GID="$(id -g)" -f "$defs/Dockerfile" "$defs" >"$run_dir/image-build.log" 2>&1 || die "could not build $gate_tag"
  docker image inspect "$proxy_tag" >/dev/null 2>&1 ||
    docker build -q -t "$proxy_tag" -f "$defs/proxy.Dockerfile" "$defs" >"$run_dir/proxy-build.log" 2>&1 || die "could not build $proxy_tag"
  docker network inspect gate-internal >/dev/null 2>&1 || docker network create --internal gate-internal >/dev/null || die "no gate-internal network"
  if test "$(docker inspect -f '{{.Config.Image}} {{.State.Running}}' gate-proxy 2>/dev/null)" != "$proxy_tag true"; then
    docker rm -f gate-proxy >/dev/null 2>&1
    dns_opts=(); for ns in $(awk '/^nameserver [0-9.]+$/ { print $2 }' /run/systemd/resolve/resolv.conf 2>/dev/null); do dns_opts+=(--dns "$ns"); done
    docker run -d --name gate-proxy --restart unless-stopped --ulimit nofile=65536:65536 "${dns_opts[@]}" --network bridge "$proxy_tag" >/dev/null || die "could not start gate-proxy"
    docker network connect gate-internal gate-proxy || die "could not attach gate-proxy"
  fi
  docker cp gate-proxy:/etc/squid/proxy.crt "$defs/proxy.crt" >/dev/null 2>&1 || die "could not read gate-proxy's certificate"
  cat /etc/ssl/certs/ca-certificates.crt "$defs/proxy.crt" >"$defs/ca-bundle.crt"
  sbx="$GATE_HOME/sandbox-cache"; mkdir -p "$sbx"
  common="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
  maps="${GATE_SANDBOX_MAPS:-${SIMFORGE_MAPS_CACHE_ROOT:-$HOME/.local/share/simforge/maps}}"
  sky="${GATE_SANDBOX_SKY:-${XDG_CACHE_HOME:-$HOME/.cache}/simforge/sky-products}"
  mounts=(-v "$sbx:/cache" -v "$common:$common:ro" -v "$script_path:/gate/gate-local.sh:ro" -v "$defs/proxy.crt:/gate/proxy.crt:ro" -v "$defs/ca-bundle.crt:/etc/ssl/certs/ca-certificates.crt:ro")
  test -d "$maps/.corpus" && mounts+=(-v "$maps/.corpus:/maps/.corpus:ro")
  test -d "$sky" && mounts+=(-v "$sky:/cache/xdg/simforge/sky-products:ro")
  proxy=http://gate-proxy:8888; sproxy=https://gate-proxy:8443
  container="gate-$run_id"
  docker run -d --name "$container" --network gate-internal \
    --cpus "${SANDBOX_CPUS:-12}" --memory "${SANDBOX_MEMORY:-32g}" --pids-limit 8192 --security-opt no-new-privileges "${mounts[@]}" \
    -e HTTP_PROXY="$proxy" -e http_proxy="$proxy" -e HTTPS_PROXY="$proxy" -e https_proxy="$sproxy" \
    -e NO_PROXY="localhost,127.0.0.1,gate-proxy" -e no_proxy="localhost,127.0.0.1,gate-proxy" \
    -e NODE_EXTRA_CA_CERTS=/gate/proxy.crt -e SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt -e NODE_USE_ENV_PROXY=1 \
    -e CARGO_HTTP_PROXY="$proxy" -e GIT_PROXY_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt -e UV_NATIVE_TLS=1 \
    -e UV_CACHE_DIR=/cache/uv -e XDG_CACHE_HOME=/cache/xdg -e SIMFORGE_MAPS_CACHE_ROOT=/maps -e CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}" \
    -e GATE_BASE="$base" -e GATE_STEP_OUT=/cache/step-out \
    "$gate_tag" sleep infinity >/dev/null || die "could not start the sandbox"
  # The sandbox's own clone (objects shared read-only with the host clone), the
  # pinned toolchain and cargo-nextest; git and cargo run inside, never on the host.
  docker exec "$container" bash -euc "
    test -x /cache/cargo/bin/rustup || rustup-init -y -q --no-modify-path --profile minimal --default-toolchain none
    test -d /cache/src/.git || git clone -q --shared --no-checkout '$common' /cache/src
    cd /cache/src && git -c advice.detachedHead=false checkout -q --force --detach '$sha' && git clean -fdq
    test \"\$(git rev-parse HEAD)\" = '$sha'
    if ! test -x /cache/cargo/bin/cargo-nextest; then
      curl -fsSL -o /tmp/nextest.tgz https://github.com/nextest-rs/nextest/releases/download/cargo-nextest-0.9.146/cargo-nextest-0.9.146-x86_64-unknown-linux-gnu.tar.gz
      tar -xzf /tmp/nextest.tgz -C /cache/cargo/bin cargo-nextest
    fi" >"$run_dir/checkout.log" 2>&1 || { cat "$run_dir/checkout.log" >&2; die "sandbox setup for $sha failed"; }
elif test "$SANDBOX" != off; then
  die "GATE_SANDBOX must be off or required, not $SANDBOX"
fi

run_step() { # name detail -- step args...
  local name="$1" detail="$2"; shift 3
  local log="$run_dir/${name//[:\/]/-}.log" t0 status; t0=$(date +%s)
  if test -n "$container"; then docker exec -w /cache/src "$container" bash /gate/gate-local.sh --step "$@" >"$log" 2>&1
  else ( export GATE_BASE="$base" GATE_STEP_OUT="$run_dir/step-out"; bash "$script_path" --step "$@" ) >"$log" 2>&1; fi
  status=$?; local dt=$(( $(date +%s) - t0 ))
  if test $status -eq 0; then record_step "$name" pass "$dt" "$log" "$detail"; return 0; fi
  record_step "$name" fail "$dt" "$log" "$detail (exit $status)"; tail -n 60 "$log" | sed 's/^/      | /'; echo "      \\ full log: $log"; failing="$name"; return 1; }
skip_step() { record_step "$1" skip 0 "" "$2"; }

ok=true
run_step boundary "cargo metadata + uv + no TS" -- boundary || ok=false
engine='^(native/Cargo\.(toml|lock)|native/crates/simforge-(core|compiler|session|bindings-common|bindings-python|package)/|fixtures/|examples/|contracts/|rust-toolchain\.toml)'
declare -A ws_when=(
  [native]="$engine"
  [renderer]='^(renderer/|native/crates/simforge-(core|compiler|session|package|cli)/|native/Cargo\.lock|fixtures/|catalog/|rust-toolchain\.toml)'
  [native/crates/simforge-timeline-python]='^(native/crates/simforge-(timeline-python|core)/|rust-toolchain\.toml)'
)
# The simforge CLI (native/crates/simforge-cli) is a member of the renderer workspace.
for ws in native renderer native/crates/simforge-timeline-python; do
  $ok || break
  test -f "$ws/Cargo.toml" || continue
  if touched "${ws_when[$ws]}"; then run_step "rust:$ws" "fmt+clippy ratchet, nextest" -- rust "$ws" || ok=false
  else skip_step "rust:$ws" "not affected"; fi
done
if $ok; then
  py=()
  for d in $(git ls-files -- '*pyproject.toml' | xargs -n1 dirname | sort -u); do
    test -d "$d/tests" || continue
    if touched "^$d/" || { touched "$engine" && grep -Eq 'maturin|simforge-oss-gym|simforge-oss-timeline' "$d/pyproject.toml"; }; then py+=("$d"); fi
  done
  if test ${#py[@]} -gt 0; then run_step python "${py[*]}" -- python "${py[@]}" || ok=false
  else skip_step python "no Python package affected"; fi
fi
if $ok; then
  if touched '^(renderer/|native/crates/simforge-core/|native/Cargo\.lock|qualification/golden-harness/|catalog/|rust-toolchain\.toml)'; then
    run_step goldens "lavapipe, verify all" -- goldens || ok=false
  else skip_step goldens "renderer/engine not affected"; fi
fi

finished=$(date +%s); result=$($ok && echo pass || echo fail)
key_file="$GATE_HOME/.gate-key"
test -s "$key_file" || (umask 077 && head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$key_file")
prev="$(tail -n 1 "$GATE_HOME/records.jsonl" 2>/dev/null | sha256sum | cut -d' ' -f1)"
body="$(jq -cn --arg sha "$sha" --arg base "$base" --arg tree "$(git rev-parse 'HEAD^{tree}')" --arg repo "simforge-sdk" --arg sandbox "$SANDBOX" \
  --arg result "$result" --arg failing "$failing" --arg host "$(hostname)" --arg user "$(id -un)" \
  --arg script "$script_sha" --arg id "$run_id" --arg dir "$run_dir" --arg prev "$prev" \
  --argjson started "$started" --argjson finished "$finished" --argjson steps "$steps_json" \
  '{v:1, repo:$repo, sandbox:($sandbox == "required"), id:$id, sha:$sha, base:$base, tree:$tree, result:$result, failing:(if $failing == "" then null else $failing end),
    seconds:($finished-$started), started:($started|todate), finished:($finished|todate),
    host:$host, user:$user, gateScriptSha256:$script, steps:$steps, runDir:$dir, prev:$prev}')"
hmac="$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$(cat "$key_file")" -r | cut -d' ' -f1)"
record="$(jq -c --arg h "$hmac" '. + {hmac:$h}' <<<"$body")"
test -n "$record" || die "could not write the gate record"
printf '%s\n' "$record" >>"$GATE_HOME/records.jsonl"
printf '%s\n' "$record" | jq . >"$run_dir/record.json"
echo "GATE $(tr a-z A-Z <<<"$result") sha=$sha time=$(( finished - started ))s${failing:+ failing=$failing} record=$run_dir/record.json"
$ok && exit 0 || exit 1
