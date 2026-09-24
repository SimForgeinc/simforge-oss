# Getting started

Every command prints JSON on stdout and exits `0` (ok), `1` (the operation
failed) or `2` (bad input, including a package this CLI is too old to read).
Human-readable progress goes to stderr.

## 1. Check the machine

```sh
simforge doctor
```

## 2. Get a scenario package

In the hosted app, open a scenario revision and choose **Export for CLI**. You
get a `*.simforge.zip` (`simforge.scenario-package/v1`): the scenario, the
simulated trace, the render timeline and the digests of the map and actor
assets it uses. It is a few MB; the map and models are fetched separately, by
digest, and verified.

```sh
simforge package verify my-scenario.simforge.zip
simforge package import my-scenario.simforge.zip --into ./ws
```

A package names the oldest CLI that can read it (`producer.minCli`); an older
CLI refuses it with `package_reader_too_old` rather than guessing.

## 3. Fetch what it references

```sh
simforge maps pull <name>@<version>
simforge assets pull
```

Both are content-addressed and cached under `$XDG_DATA_HOME/simforge`
(`~/.local/share/simforge`). `assets pull` prints where the models'
`ATTRIBUTION.json` is.

## 4. Render

```sh
simforge timeline build ./ws
simforge render ./ws --preset training --rig rig.json --out ./out
```

`out/results.json` lists every pass (RGB, depth, instance ids, lidar, radar)
with its SHA-256 and the adapter it was rendered on. See
[Rendering](rendering.md).

## 5. Drive it

```sh
simforge env serve ./ws --socket /tmp/simforge.sock
```

and connect with the gym ([Closed loop](closed-loop.md)).
