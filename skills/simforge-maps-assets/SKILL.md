---
name: simforge-maps-assets
description: Pull SimForge map releases (`simforge maps pull name@version`) and the actor-asset closure (`simforge assets pull`) into the local content-addressed caches, use private registries or mirrors and air-gapped copies, manage cache locations, and respect the models' licences (CC BY 4.0 attribution). Use when a render or import says a map or actor closure is missing, when preparing an offline machine, or when asked about asset licences.
---

# Maps and actor assets

Both are immutable and content-addressed: every blob is verified by sha256
on download, and a package names exactly which release and closure it needs.

## Maps

```sh
simforge maps pull richmond-field-station@v2     # a specific release
simforge maps pull richmond-field-station        # the latest release of that map
```

- Cache: `$SIMFORGE_MAPS_CACHE_ROOT`, else `$XDG_DATA_HOME/simforge/maps`
  (`--cache-root` overrides per command).
- Registry: `--registry`, else `$SIMFORGE_MAPS_REGISTRY`, then the public
  registry. `https://` or `file://` (a local mirror for air-gapped sites).
- `simforge package inspect` shows the release a package pins; render finds the
  installed map by content, not by name.
- The public registry carries `richmond-field-station`.

## Actor assets

```sh
simforge assets pull                              # the closure this CLI is pinned to
simforge assets pull --closure <sha256>           # a specific closure (a package's actorClosureDigest)
```

- Root: `--root`, else `$SIMFORGE_ACTOR_ASSETS_ROOT`, else
  `$XDG_DATA_HOME/simforge/actor-assets`. Store: `--base-url`, else
  `$SIMFORGE_ACTOR_ASSETS_BASE_URL`, else the public store.
- The closure ships `ATTRIBUTION.json`; the command prints where it is.

## Licences

The vehicle and pedestrian models include CARLA content (© CARLA contributors
and CVC/UAB) and SimForge-made models, under CC BY 4.0: if you publish renders
that show them, credit them as `ATTRIBUTION.json` lists (title, creator,
licence, changes). The CLI itself is Apache-2.0; its dependencies are listed in
`THIRD_PARTY_NOTICES.md`. ffmpeg is a separate program, never bundled.

## Reference

<!-- simforge:reference maps pull, assets pull -->
_Generated from `simforge --help` (CLI 0.2.0-rc.0) by scripts/skills/skills.py; do not edit._

#### `simforge maps pull`

Pull an immutable map release into the local cache, verifying every blob's sha256

Usage: `simforge maps pull <name@version> [flags]`

| Argument / flag | | What |
|---|---|---|
| `<name@version>` | required | The release to pull, as `<name>@<version>` (e.g. `richmond-field-station@v2`); `<name>` alone pulls the latest |
| `--registry URL` |  | Registry base URL (https:// or file://), instead of the account's. Default: SIMFORGE_MAPS_REGISTRY, SIMFORGE_MAPS_PUBLIC_URL, then the logged-in account's registry, then the public registry. A private https registry named here reads a bearer token from SIMFORGE_MAPS_REGISTRY_TOKEN |
| `--host HOST` |  | SimForge host whose account registry to use (see `simforge login`). Default: SIMFORGE_HOST, then simforge.ai |
| `--cache-root DIR` |  | Map cache root. Default: SIMFORGE_MAPS_CACHE_ROOT, then $XDG_DATA_HOME/simforge/maps |
| `--archive` |  | Also install the verbatim source rasters (images/*.png/jpg/webp/avif) under dev-assets |
| `--concurrency N` | default `8` | Parallel blob downloads (1-32) |

#### `simforge assets pull`

Pull the actor-asset closure and its ATTRIBUTION.json, verifying every blob's sha256

Usage: `simforge assets pull [flags]`

| Argument / flag | | What |
|---|---|---|
| `--only ONLY` | one of `actors`, `sky` | Pull only this closure. Default: both the actor closure and the sky plates |
| `--closure SHA256` |  | The actor closure digest (sha256). Default: the closure this build is pinned to |
| `--base-url URL` |  | Asset store base URL (https:// or file://). Default: SIMFORGE_ACTOR_ASSETS_BASE_URL, then the public store |
| `--root DIR` |  | Local asset root. Default: SIMFORGE_ACTOR_ASSETS_ROOT, then $XDG_DATA_HOME/simforge/actor-assets |
| `--timeout SECONDS` | default `60` | Seconds to wait for a connection or for a response to start |

Exit codes: `0` ok; `1` command error: the command could not run; `2` findings: the command ran and found something wrong with its input.
<!-- /simforge:reference -->
