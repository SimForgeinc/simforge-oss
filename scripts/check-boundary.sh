#!/usr/bin/env bash
# check-boundary.sh: the SDK is self-contained Rust + Python.
#   1. no TypeScript and no npm workspace (the golden harness and
#      scripts/actor-assets/closures.mjs are plain Node ESM with zero
#      dependencies, stopgaps until the CLI covers them);
#   2. every Cargo workspace resolves only to crates.io, git, or paths INSIDE
#      this checkout (`cargo metadata`, the mechanical proof);
#   3. every uv/maturin path source stays inside this checkout.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"; cd "$root"
fail=0

ts="$(git ls-files -- '*.ts' '*.tsx' '*.mts' '*.cts' '*package.json' '*pnpm-lock.yaml' '*pnpm-workspace.yaml' '*tsconfig*.json')"
js="$(git ls-files -- '*.js' '*.mjs' '*.cjs' | grep -v -e '^qualification/golden-harness/' -e '^scripts/actor-assets/closures.mjs$' || true)"
if test -n "$ts$js"; then echo "boundary: TypeScript/npm files are not allowed in the SDK:"; printf '%s\n' $ts $js | sed 's/^/  /'; fail=1; fi

for manifest in $(git ls-files -- '*Cargo.toml' | grep -v '^renderer/vendor/'); do
  # Only workspace roots and standalone packages (members are covered by their root).
  if ! grep -q '^\[workspace\]' "$manifest"; then
    dir="$(dirname "$manifest")"; covered=0
    while test "$dir" != "."; do dir="$(dirname "$dir")"; test -f "$dir/Cargo.toml" && grep -q '^\[workspace\]' "$dir/Cargo.toml" && covered=1 && break; done
    test $covered = 1 && continue
  fi
  out="$(cargo metadata --format-version 1 --manifest-path "$manifest" 2>&1)" || { echo "boundary: cargo metadata failed for $manifest:"; echo "$out" | tail -5; fail=1; continue; }
  bad="$(jq -r --arg root "$root/" '.packages[] | select(.source == null) | .manifest_path | select(startswith($root) | not)' <<<"$out")"
  if test -n "$bad"; then echo "boundary: $manifest resolves a path crate outside the SDK:"; sed 's/^/  /' <<<"$bad"; fail=1; fi
  echo "boundary: $manifest ok ($(jq '[.packages[] | select(.source == null)] | length' <<<"$out") local crates)"
done

for py in $(git ls-files -- '*pyproject.toml'); do
  dir="$(dirname "$py")"
  while IFS= read -r rel; do
    test -n "$rel" || continue
    target="$(realpath -m "$dir/$rel")"
    case "$target/" in "$root"/*) ;; *) echo "boundary: $py points outside the SDK: $rel"; fail=1;; esac
  done < <(python3 - "$py" <<'PY'
import sys, tomllib
d = tomllib.load(open(sys.argv[1], 'rb'))
for v in (d.get('tool', {}).get('uv', {}).get('sources', {}) or {}).values():
    for s in (v if isinstance(v, list) else [v]):
        if isinstance(s, dict) and 'path' in s: print(s['path'])
m = d.get('tool', {}).get('maturin', {}).get('manifest-path')
if m: print(m)
PY
)
done
test $fail = 0 && echo "boundary: PASS" || { echo "boundary: FAIL"; exit 1; }
