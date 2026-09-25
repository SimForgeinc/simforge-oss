---
name: simforge-cli
description: Drive the `simforge` command line (SimForge SDK) from an agent. Use when asked to sign in to SimForge (`simforge login`), list or pull a map (including an organization's private maps), verify or import a SimForge scenario package, pull the actor assets, build a render timeline, render a scenario offline (frames, id/depth/semantic, lidar, radar, video), re-simulate it, or serve closed-loop episodes to a policy over a socket.
---

# simforge CLI

`simforge` is a single binary. Every command prints **one JSON document on
stdout**; a failure prints `{code, path?, reason, detail?}` on **stderr**.

| Exit | Meaning | What to do |
|---|---|---|
| 0 | ok | read stdout |
| 1 | could not run (bad flags, missing file, unreachable registry, missing map) | fix the invocation or install what `detail.hint` names |
| 2 | ran and found something wrong with the input (digest mismatch, failed gate) | report it; do not retry blindly |

`simforge help --json` prints the whole command surface (every flag, its
type, default and allowed values). Read it instead of guessing flags:
unknown flags are errors.

## The usual path

```sh
simforge doctor                                   # GPU, ffmpeg, sky plates, caches, registry
simforge package verify scenario.zip              # every digest; exit 2 = refused
simforge package import scenario.zip --into ws    # unpack; `next` lists what to pull
simforge maps pull <name>@<version>               # the map the scenario was made on
simforge assets pull --closure <sha256>           # the actor models it binds
simforge render ws --preset training --rig rig.json --out out
simforge simulate ws                              # re-simulation, labelled "re-simulated"
simforge env serve ws --socket /tmp/env.sock --rig rig.json   # closed-loop episodes
```

- Maps and actor closures are found **by digest**, never by name. A missing
  one is an error naming the pull command; nothing is substituted.
- `render` writes frames and passes under `out/<sensor>/`, `results.json`,
  `render.json` (the summary it also prints) and videos when ffmpeg exists.
  Its parity gate fails the run (exit 2) if the renderer drew an actor off
  its timeline pose.
- The rig is `simforge.render-rig/v1`: the hosted render's `sources`,
  `sensorHosts`, `clip` and `video`, pasted as they are.

## Signing in (private maps)

`richmond-field-station` is public. Every other map comes from the user's
SimForge account, after one sign-in on this machine:

```sh
simforge auth status                 # exit 1 + code not_logged_in / session_invalid: sign in
simforge login                       # browser: the user signs in on simforge.ai and clicks Approve
simforge login --device              # no browser here (SSH, CI box): print a URL + code
simforge maps list                   # the maps the user's organization can use
simforge maps pull <name>@<version>  # uses the login automatically
simforge logout                      # revoke on the host, delete the local tokens
```

- `login` needs a person: it waits (default 600 s) while they approve in a
  browser. Tell the user what to do from the stderr event line: `login.browser`
  (a browser tab opened; `url` if it did not), `login.device` (`userCode` and
  `verificationUriComplete` to open anywhere). Never guess or retry an approval.
- Without a local browser (SSH, no `DISPLAY`) `login` uses the device code and
  says why (`methodReason`); `--device` asks for it explicitly.
- `--host dev.simforge.ai` (or `SIMFORGE_HOST`) targets another deployment.
  `SIMFORGE_TOKEN` (an access token) overrides the stored login for CI.
- Results say which registry answered and as whom: `"registry": {"url",
  "authenticated": true, "source": "account:<host>", "account"}`. When not
  logged in, `maps` reads the public registry (`"authenticated": false`).
- `unauthorized` (exit 1) means the session was revoked, expired or lacks
  `maps:read`: run `simforge login` again. A refused pull installs nothing.
- Never print, log or paste tokens. `auth status` reports where they are kept
  (`keyring`, or a 0600 `file` with the reason), never their value.
