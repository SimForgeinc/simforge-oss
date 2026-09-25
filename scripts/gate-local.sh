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
# Records: $GATE_HOME/records.jsonl (hash chain + HMAC with $GATE_HOME/.gate-key),
# run logs under $GATE_HOME/runs/<id>/. Exit 0 pass, 1 fail, 2 could not run.
# The LAST line is always
#   GATE PASS|FAIL|ERROR sha=<sha> time=<s>s [failing=<step>] record=<path>
set -uo pipefail

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
for tool in git jq cargo uv python3 node; do command -v "$tool" >/dev/null || die "missing tool: $tool"; done
cargo nextest --version >/dev/null 2>&1 || die "missing tool: cargo-nextest"

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
run_step() { local name="$1" detail="$2"; shift 3; local log="$run_dir/${name//[:\/]/-}.log" t0 status; t0=$(date +%s)
  ( "$@" ) >"$log" 2>&1; status=$?; local dt=$(( $(date +%s) - t0 ))
  if test $status -eq 0; then record_step "$name" pass "$dt" "$log" "$detail"; return 0; fi
  record_step "$name" fail "$dt" "$log" "$detail (exit $status)"; tail -n 60 "$log" | sed 's/^/      | /'; echo "      \\ full log: $log"; failing="$name"; return 1; }
skip_step() { record_step "$1" skip 0 "" "$2"; }

# Files of this change that rustfmt/clippy flag, relative to the repo root.
ratchet() { # <workspace dir> <fmt log> <clippy log>
  local ws="$1" bad=""
  local fmt_files; fmt_files="$(grep -oE '^Diff in [^:]+' "$2" | sed "s#^Diff in $root/##" | sort -u)"
  local clippy_files; clippy_files="$(grep -oE '^(warning|error)[^:]*: .*|^ *--> [^:]+' "$3" | grep -oE -- '--> [^:]+' | sed 's/^--> //' | sed "s#^#$ws/#" | sort -u)"
  for f in $fmt_files; do grep -qxF "$f" <<<"$changed" && bad+=" rustfmt:$f"; done
  for f in $clippy_files; do f="$(realpath -m --relative-to="$root" "$root/$f")"; grep -qxF "$f" <<<"$changed" && bad+=" clippy:$f"; done
  test -z "$bad" || { echo "ratchet: files this change touched need fixing:$bad"; return 1; }
}
step_rust() { # <workspace dir>
  local ws="$1"
  ( cd "$ws" && cargo fmt --check ) >"$run_dir/fmt-${ws//\//-}.txt" 2>&1
  ( cd "$ws" && cargo clippy --all-targets --message-format=short -- --cap-lints warn ) >"$run_dir/clippy-${ws//\//-}.txt" 2>&1 || { tail -40 "$run_dir/clippy-${ws//\//-}.txt"; return 1; }
  ratchet "$ws" "$run_dir/fmt-${ws//\//-}.txt" "$run_dir/clippy-${ws//\//-}.txt" || return 1
  ( cd "$ws" && cargo nextest run --no-fail-fast --no-tests=pass )
}
step_python() { # <package dir>...
  local rc=0 d
  for d in "$@"; do
    echo "== pytest $d"
    # CPU only: the gate never takes a GPU (GPU-only tests skip themselves).
    # A maturin package is rebuilt from this checkout (uv caches wheels by version,
    # not by content, and a stale _native only makes its tests skip).
    local rebuild=()
    if grep -q 'build-backend = "maturin"' "$d/pyproject.toml"; then
      rebuild=(--reinstall-package "$(python3 -c 'import sys,tomllib; print(tomllib.load(open(sys.argv[1],"rb"))["project"]["name"])' "$d/pyproject.toml")")
    fi
    ( cd "$d" && CUDA_VISIBLE_DEVICES="" uv run --quiet "${rebuild[@]}" --with pytest python -m pytest -q -p no:cacheprovider ) || rc=1
  done
  return $rc
}
step_goldens() {
  export SIMFORGE_CORPUS_RICHMOND="${SIMFORGE_CORPUS_RICHMOND:-${SIMFORGE_MAPS_CACHE_ROOT:-$HOME/.local/share/simforge/maps}/.corpus/richmond-field-station}"
  export SIMFORGE_CORPUS_YALE="${SIMFORGE_CORPUS_YALE:-${SIMFORGE_MAPS_CACHE_ROOT:-$HOME/.local/share/simforge/maps}/.corpus/yale-street}"
  qualification/golden-harness/ci-local.sh verify
}

ok=true
run_step boundary "cargo metadata + uv + no TS" -- scripts/check-boundary.sh || ok=false
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
  if touched "${ws_when[$ws]}"; then run_step "rust:$ws" "fmt+clippy ratchet, nextest" -- step_rust "$ws" || ok=false
  else skip_step "rust:$ws" "not affected"; fi
done
if $ok; then
  py=()
  for d in $(git ls-files -- '*pyproject.toml' | xargs -n1 dirname | sort -u); do
    test -d "$d/tests" || continue
    if touched "^$d/" || { touched "$engine" && grep -Eq 'maturin|simforge-oss-gym|simforge-oss-timeline' "$d/pyproject.toml"; }; then py+=("$d"); fi
  done
  if test ${#py[@]} -gt 0; then run_step python "${py[*]}" -- step_python "${py[@]}" || ok=false
  else skip_step python "no Python package affected"; fi
fi
if $ok; then
  if touched '^(renderer/|native/crates/simforge-core/|native/Cargo\.lock|qualification/golden-harness/|catalog/|rust-toolchain\.toml)'; then
    run_step goldens "lavapipe, verify all" -- step_goldens || ok=false
  else skip_step goldens "renderer/engine not affected"; fi
fi

finished=$(date +%s); result=$($ok && echo pass || echo fail)
key_file="$GATE_HOME/.gate-key"
test -s "$key_file" || (umask 077 && head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$key_file")
prev="$(tail -n 1 "$GATE_HOME/records.jsonl" 2>/dev/null | sha256sum | cut -d' ' -f1)"
body="$(jq -cn --arg sha "$sha" --arg base "$base" --arg tree "$(git rev-parse 'HEAD^{tree}')" --arg repo "simforge-sdk" \
  --arg result "$result" --arg failing "$failing" --arg host "$(hostname)" --arg user "$(id -un)" \
  --arg script "$script_sha" --arg id "$run_id" --arg dir "$run_dir" --arg prev "$prev" \
  --argjson started "$started" --argjson finished "$finished" --argjson steps "$steps_json" \
  '{v:1, repo:$repo, id:$id, sha:$sha, base:$base, tree:$tree, result:$result, failing:(if $failing == "" then null else $failing end),
    seconds:($finished-$started), started:($started|todate), finished:($finished|todate),
    host:$host, user:$user, gateScriptSha256:$script, steps:$steps, runDir:$dir, prev:$prev}')"
hmac="$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$(cat "$key_file")" -r | cut -d' ' -f1)"
record="$(jq -c --arg h "$hmac" '. + {hmac:$h}' <<<"$body")"
test -n "$record" || die "could not write the gate record"
printf '%s\n' "$record" >>"$GATE_HOME/records.jsonl"
printf '%s\n' "$record" | jq . >"$run_dir/record.json"
echo "GATE $(tr a-z A-Z <<<"$result") sha=$sha time=$(( finished - started ))s${failing:+ failing=$failing} record=$run_dir/record.json"
$ok && exit 0 || exit 1
