# Jev drive adapter

This adapter is the text-only Jev (`jev-1.13.0`) decision service used by the
native `simforge drive` bench. Jev receives a validated `scene-observation/v2`
state and chooses one code-enumerated, deterministic candidate. It never receives
images and never emits pedals or a trajectory. The native bench remains the only
actuator: it converts the selected candidate's safe preview/setpoint into an
`EnvAction`.

## Setup

Use a dedicated Python environment for the adapter. The service needs Python
3.12, NumPy, Gymnasium, the pinned TypeSafe SDK and the SimForge native gym
wheel. The native rc61 wheel is built in this repository rather than published
on PyPI, so use the setup script:

```sh
cd adapters/jev-driver
scripts/setup.sh
```

To use a wheel outside the checkout, set `SIMFORGE_GYM_WHEEL` to its
`simforge_oss_gym-0.1.0rc61-*.whl` path before running the script.

The TypeSafe API key must be available as `TYPESAFE_API_KEY`; the supported local
credential file is `~/.config/typesafe/env` (mode 600), which can be sourced by
the shell before starting the service. Credentials are never written to run
artifacts or service logs.

## Service

The CLI starts this loopback service automatically for `simforge drive run
--policy jev`. To run it manually:

```sh
.venv/bin/python -m jevdrive serve --port 8766
```

`--port 0` selects an ephemeral port and the readiness line reports the bound
port. `GET /contract` reports the pinned model and contract. `GET /stats` reports
request, real API-call and schema-refusal counts. `POST /decision` accepts either
the established Studio request shape or `{ "scene": <scene-observation/v2> }`.
The service binds only to `127.0.0.1` and uses one pooled TypeSafe client with no
retries.

## Bench policy

```sh
simforge drive run --policy jev --scenario <garching-or-belmont-corridor> \
  --seed 42 --duration 10 --out ~/simforge-assets/runs/drive
```

Jev is scheduled at approximately 3 Hz while native ticks continue at the bench
engine rate between latches. Offline-simtime waits at decision barriers, so API
latency changes wall time but not native outcomes. A service or API failure takes
the deterministic native minimum-risk stop. The run records the v2 scene gate,
feasible/rejected candidate sets, API latency, selected probabilities and the
real API-call count in `steps.jsonl` and `log.txt`; the main camera video is
rendered by the bench even though `cameraProfile` is `none`.
