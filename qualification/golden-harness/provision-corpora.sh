#!/usr/bin/env bash
# Provision the golden scenes' pinned map corpora (corpora.json) and print one
# `export <ENV>=<dir>` line per corpus for the caller to eval. Each corpus is a
# public registry release pulled with the SDK's own `simforge maps pull` (every
# blob verified against the release's canonical closure) into a cache keyed by
# the release digest, so versions of one map never share a directory and a warm
# cache re-verifies in seconds. The installed receipt must carry exactly the
# pinned release and canonical digests. Any failure exits non-zero: a golden
# scene never renders against a missing or different corpus.
#   GOLDEN_CORPUS_CACHE  cache root (default $XDG_CACHE_HOME/simforge/golden-corpora)
#   SIMFORGE_BIN         the simforge CLI (default target/release/simforge)
set -euo pipefail
cd "$(dirname "$0")/../.."
spec=qualification/golden-harness/corpora.json
bin="${SIMFORGE_BIN:-target/release/simforge}"
cache="${GOLDEN_CORPUS_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/simforge/golden-corpora}"
registry="$(jq -r .registry "$spec")"
fail() { echo "provision-corpora: $1" >&2; exit 1; }

receipt_ok() { # <corpus dir> <release digest> <canonical digest>
  local r="$1/.map-release.json"
  test -f "$r" || return 1
  test "$(jq -r .releaseDigest "$r")" = "$2" && test "$(jq -r .canonicalDigest "$r")" = "$3"
}

n="$(jq '.corpora | length' "$spec")"
for (( i = 0; i < n; i++ )); do
  env_name="$(jq -r ".corpora[$i].env" "$spec")"
  map="$(jq -r ".corpora[$i].map" "$spec")"
  version="$(jq -r ".corpora[$i].version" "$spec")"
  release="$(jq -r ".corpora[$i].releaseDigest" "$spec")"
  canonical="$(jq -r ".corpora[$i].canonicalDigest" "$spec")"
  given="${!env_name:-}"
  if test -n "$given"; then
    receipt_ok "$given" "$release" "$canonical" ||
      fail "$env_name=$given is not $map@$version (its .map-release.json must carry release $release and canonical closure $canonical)"
    echo "export $env_name=$given"
    continue
  fi
  test -x "$bin" || fail "no simforge CLI at $bin (cargo build --release -p simforge --bin simforge)"
  root="$cache/$release"
  mkdir -p "$root"
  out="$root/pull.json"
  # One pull per release at a time (gates and contributors may share the cache).
  flock "$root/.lock" "$bin" maps pull "$map@$version" --registry "$registry" --cache-root "$root" >"$out" 2>"$root/pull.stderr" ||
    fail "maps pull $map@$version from $registry failed: $(tail -c 600 "$root/pull.stderr")"
  test "$(jq -r .releaseDigest "$out")" = "$release" ||
    fail "$map@$version is release $(jq -r .releaseDigest "$out") on $registry, pinned $release (the registry moved; re-pin corpora.json with the scenes that use it)"
  test "$(jq -r .closureDigest "$out")" = "$canonical" || fail "$map@$version canonical closure $(jq -r .closureDigest "$out"), pinned $canonical"
  dir="$root/.corpus/$map"
  receipt_ok "$dir" "$release" "$canonical" || fail "$dir holds no receipt for $map@$version after the pull"
  echo "provision-corpora: $env_name = $map@$version (release ${release:0:12}, $(jq -r .blobs.downloaded "$out") blobs downloaded, $(jq -r .blobs.reused "$out") reused)" >&2
  echo "export $env_name=$dir"
done
