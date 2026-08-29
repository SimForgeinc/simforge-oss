#!/usr/bin/env bash
# Builds the four labelled calibration sets per PREREG.md. Stream B, tg-rethink.
set -uo pipefail
cd "$(dirname "$0")/../../.."

RUN=/tmp/tgr-instrument-calib1
MAPS=easterbrook-discovery-school,belmont-research-center,richmond-field-station,yale-street
COMMON=(--maps "$MAPS" --max-sites 2 --draws 1 --concurrency 6)
CLI="node packages/cli/bin/uniscenarios.js"

GOLD=(
  examples/mechanisms/corridor/lead-hard-brake.template.json
  examples/mechanisms/obstacle/disabled-vehicle.template.json
  examples/mechanisms/obstacle/fallen-cargo.template.json
  examples/mechanisms/obstacle/animal-crossing.template.json
  examples/mechanisms/remaining/oncoming-overtake.template.json
  examples/mechanisms/junction-vru/cyclist-crossing-path.template.json
  tools/gates/probes/c7-bus-shelter-fixed.template.json
  tools/gates/probes/c7-hedge-corner-fixed.template.json
)
BROKEN=(
  tools/tg-research/instrument/broken-templates/b1-frozen-ego.template.json
  tools/tg-research/instrument/broken-templates/b2-zero-kph.template.json
  tools/gates/probes/c7-bus-shelter-baseline.template.json
  tools/gates/probes/c7-hedge-corner-baseline.template.json
)

run_arm() { # arm template extra-args...
  local arm=$1 tpl=$2; shift 2
  local name; name=$(basename "$tpl" .template.json)
  echo "=== $arm / $name"
  $CLI batch "$tpl" "${COMMON[@]}" "$@" --out "$RUN/$arm/$name" \
    | tail -c 400 || echo "BATCH-FAILED $arm/$name"
}

mkdir -p "$RUN"
for t in "${GOLD[@]}"; do
  run_arm rplus "$t" --ambient moderate --ambient-seed 1234 --ambient-settle 20
done
for t in "${GOLD[@]}"; do
  run_arm rminus "$t" --ambient off
done
for t in "${BROKEN[@]}"; do
  run_arm bplus "$t"
done
echo "=== build complete"
find "$RUN" -name 'draw-*.trace.json.gz' | wc -l
