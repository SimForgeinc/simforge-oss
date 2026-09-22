# SUMO derivatives

Ambient SUMO traffic (the editor's Traffic source, drive mode, the map gallery
and `simforge debug --provider sumo`) runs the pinned SUMO 1.27.1 WebAssembly
runtime against a per-map road network. That network is a map derivative:

```
derived/sumo/map.net.xml                 the network the runtime loads
derived/sumo/sumo-network-manifest.json  scene transform, seeded routes, buildKey
derived/sumo/sumo-build-report.json      what the validation gates measured
```

A map revision without these members cannot run SUMO; Studio says why
(`sumoStatus` on the map descriptor) instead of silently disabling it.

## One producer

`@simforge-oss/map-pipeline/sumo-network` (`buildSumoDerivative`) is the only
producer. It is used by:

- the map master stage (`simforge maps build|ingest`): every map with
  OpenDRIVE gets `derived/sumo` in its canonical closure, and a failed gate
  fails the build. `SIMFORGE_MAP_SUMO=skip` opts a build out explicitly;
- `pnpm maps:sumo -- --map <id>|--all [--check] [--out DIR]` for installed
  maps (the CLI dev-assets cache);
- SimCloud's reconciliation of published map versions.

## Pinned toolchain

netconvert must be exactly SUMO 1.27.1, the version of the WebAssembly
runtime; any other version (for example a distro `/usr/bin/netconvert`) is
refused. `pnpm maps:sumo:toolchain [-- --root DIR]` installs it into a Python
virtual environment from PyPI with every wheel digest pinned in
`config/sumo-toolchain.json` (default
`$XDG_DATA_HOME/simforge/toolchains/sumo-1.27.1`; `SIMFORGE_SUMO_TOOLCHAIN`
points anywhere else). netconvert runs with `SUMO_HOME` cleared and an
explicit typemap, so the output never depends on another SUMO install.

## Deterministic and versioned

Output bytes are a function of the OpenDRIVE digest, the map id, SUMO 1.27.1,
`SUMO_DERIVATIVE_REVISION`, the netconvert options, the committed typemap and
the gate thresholds. All of these are in the manifest's `buildKey` and in
`SUMO_DERIVATIVE_FINGERPRINT`, which the master stage folds into its key, so a
toolchain or option bump rebuilds every map. `pnpm maps:sumo -- --all --check`
reports `current`, `stale` or `missing` per installed map.

## What the build does

1. netconvert imports OpenDRIVE with junction internal shapes, 1 m curve
   resolution, OpenDRIVE signal groups and no invented U-turns, through a
   typemap that discards parking lanes (traffic must never drive through the
   parked-car stalls the editor fills).
2. Traffic-light movements netconvert could not tie to a head are bound to the
   heads on (or referenced from) the connecting road that carries them; this
   covers exporters that leave heads `dynamic="no"` or untyped. A traffic
   light with no head in the scene at all is removed in a second netconvert
   pass so its junction runs on priority rules, as the scene shows it.
3. Every drivable lane is registered onto its OpenDRIVE centerline from the
   topology index (`origId` names the lane). netconvert lays lanes out from
   the width at the start of each lane section, so variable-width lanes, cubic
   lane offsets and discarded inner lanes otherwise leave SUMO lanes metres
   away from the lanes the 3D map shows.
4. Seeded origin/destination routes are computed in-process.

## Gates

A failed gate throws `SumoBuildError` with the full report and writes only
`failed-sumo-build-report.json`:

- drivable lane centerlines: p95 offset <= 0.35 m, max <= 1.5 m from the
  OpenDRIVE driving lanes, and >= 90 % of driving-lane length covered;
- junction lanes connected to the registered lanes (median offset <= 0.5 m);
- every signalized OpenDRIVE junction is a SUMO traffic light and no traffic
  light is invisible in the scene;
- enough routes to populate the network;
- with the runtime available (`SIMFORGE_SUMO_RUNTIME_DIR` or
  `<maps-root>/sumo-runtime`), a deterministic 120 s run of 64 vehicles on the
  pinned WebAssembly runtime: vehicles depart and move, stay within 1 m (p95)
  of the scene's lanes, do not teleport, and every traffic light cycles.

Movements without a head to display their state, and heads SUMO does not
drive (pedestrian heads, for example), are reported as warnings.

## CI

`pnpm maps:sumo:smoke` builds the committed OpenDRIVE fixtures twice
(byte-identical output required). On hosts with installed maps,
`pnpm maps:sumo:smoke -- --maps representative --require-runtime` also builds
Richmond Field Station, Yale Street, Garching and San Ramon phase 2 with the
headless gate.

## Consumers

The authoritative consumer is the worker SUMO traffic step, which bakes SUMO
traffic into the simulation trace (`docs/engineering/sumo-worker-traffic.md`).
The editor's in-browser SUMO is a display-only preview of the same network.
