# Running the Studio host on one machine and the GUI on another

The daemon, the Next server, the database, the map cache, the render worker and
every GPU job can live on one Linux box while the desktop window runs on a
laptop somewhere else. Nothing about the architecture is per-machine except the
filesystem the host owns, and the shell is explicit about that (see
[What does not work remotely](#what-does-not-work-remotely)).

The split is:

| | |
|---|---|
| **host machine** | `simforge daemon` — migrations and seed, the Next server, PGlite, the map cache on disk, the CPU worker, native runner jobs, the GPU. |
| **GUI machine** | the Electron shell: one sandboxed renderer loading the host's pages, plus the map-cache IPC bridge. |
| **between them** | HTTP, authorized by the host's per-start control token and the trusted-local session cookie derived from it. |

## Start a network-bound host

The daemon binds where `--hostname` says, and defaults to `127.0.0.1`. Bind it
to every interface:

```bash
SIMFORGE_CLOUD_ORIGIN=https://staging.simforge.ai \
simforge daemon --port 5421 --hostname 0.0.0.0 --data-root ~/.simforge/cloud
```

`--hostname` is the flag, not the `HOSTNAME` environment variable: until the
daemon learned this flag it pinned `127.0.0.1` and ignored `HOSTNAME`
entirely, so the recipe this file used to give produced a loopback-only host
that looked like a network one. The render worker follows the bind rather
than assuming loopback.

Set `SIMFORGE_CLOUD_ORIGIN` explicitly for any work that touches SimCloud.
Unset, there is no Cloud at all: `CloudOrigin.fromEnvironment` returns `null`
and every Cloud operation fails closed as `cloud_not_configured`
(`packages/studio-host/src/origins.ts`). There is deliberately no default —
a host bound to a network address must never reach production because nobody
set a variable — so a GUI attached to a Cloud-less host shows SimCloud as
unconfigured rather than signed out.

The host writes `<data root>/host.json` (mode 0600) with the per-start
`controlToken`. That token is the whole authorization story: `studio/proxy.ts`
accepts a request only with `Authorization: Bearer <controlToken>` or with the
trusted-local session cookie, which is an HMAC of the same token. **Loopback is
not, and never was, authorization** — the gate does not care which machine a
caller is on, only that it proves it belongs to this installation. That is what
makes the remote GUI possible without weakening anything.

Read the token on the host machine:

```bash
python3 -c 'import json;print(json.load(open("'"$HOME"'/.simforge/cloud/host.json"))["controlToken"])'
```

## Choose the host from the app

Nobody needs to read `host.json` or set a variable. The shell owns a chooser
that runs **before any host page loads** (`studio/desktop/connections.html`,
driven by `studio/desktop/connections-window.mjs`), in the same family as
`starting.html` and `host-exited.html`. It lists "This computer" and every
remote daemon this computer has paired with, and probes each remote row with
the one function the shell adopts a host with, `checkContract`
(`studio/desktop/host-contract.mjs`): the row is usable only when the host
answers *and* reports a capability schema, protocol version and Studio
version this window can load. A row therefore never reads "reachable" for a
host that would then be refused — reachability and the contract are one
verdict, taken with one request.

Pairing, on the host machine:

```bash
simforge host pair                          # single-interface bind
simforge host pair --origin http://100.72.252.40:5421   # loopback or 0.0.0.0 bind
# {"code":"ABCD-EFGH","expiresAt":"...","origin":"http://100.72.252.40:5421",
#  "connect":"simforge://connect?origin=http%3A%2F%2F100.72.252.40%3A5421&code=ABCD-EFGH"}
```

The code is 40 bits from an unambiguous alphabet, lives five minutes, dies on
first use whether or not the exchange succeeded, and a burst of wrong guesses
wipes every outstanding code (`studio/app/lib/host/pairing.ts`). `--origin` is
required for a loopback or wildcard bind because the host record names the
address it bound, and no other machine can dial `0.0.0.0` or `127.0.0.1`;
nothing is guessed.

In the app, "Pair with a host on another machine…" takes the
`simforge://connect` link (or the origin and the code separately) and
exchanges it **once** through `POST /api/simforge/host/pair`, which returns
the control token in the response body. The token never appears in a URL,
browser history or referrer — the same discipline as the 60-second browser
ticket in `/api/simforge/host/session` — and the page script never sees it:
the exchange happens in the main process, which puts the token straight into
the OS credential vault.

**Where the token lives.** Sealed by the OS credential store through
Electron's `safeStorage`, in `host-tokens.json` under the app's user-data
directory, keyed `remote-host:<host origin>` — one entry per host, so two
daemons can never share one. That namespace is the shell's own, and it has to
be: the product's vault (`studio/app/lib/cloud/vault.ts`) is
`@napi-rs/keyring` keyed by `(OS user, "simforge-studio", cloud origin)`, and
two daemons on one SimCloud origin would collide there. The shell cannot use
that keyring at all — it is a native `.node` binding, and the shell ships as
one esbuild bundle inside app.asar with no `node_modules`
(`studio/desktop/stage-app.mjs`), so importing it makes `desktop:stage` fail
outright. `safeStorage` is part of the Electron binary and its key lives in
the OS store under the application's own Safe Storage entry (Keychain,
DPAPI, libsecret/kwallet), which cannot collide with `simforge-studio` by
construction.

Saved targets themselves live in `connections.json` (mode 0600) beside it —
an id, a label, an origin, the plaintext acknowledgement and when it was
paired. **No token is ever written to either file in the clear.** When the
platform cannot actually seal a secret the token is held in process memory
only, the row says it must be paired again after a relaunch, and nothing is
written. On Linux that check is not `isEncryptionAvailable()` alone: with no
keyring daemon Chromium selects the `basic_text` backend, whose key is a
constant in the binary, so `getSelectedStorageBackend()` is consulted and
`basic_text` counts as unsealable. A token obfuscated with a published key is
a plaintext file with extra steps.

**Switching is a relaunch.** Connection › Switch Connection… relaunches with
`--choose-connection` and says so before it does. This is not a limitation
worth hiding: the trusted origin, the session cookie, the map-cache IPC
bridge, the menu and the auto-updater are all derived from the choice once,
inside `app.whenReady()`, before any window content loads. Re-deriving them
under a live renderer that had assumed the other origin is how a shell ends
up half-attached to two hosts.

**When a remote host goes away** there is no exit code to report — that is
what `host-exited.html` exists for, a host *this* shell started and reaped.
A remote daemon simply stops answering, so the shell shows a state of its
own that names the origin and the last reason, with "Try again" and "Choose
another connection". Nothing fabricates an exit status. The same state
handles a remote that never answered at startup.

## Or point the shell with environment variables

For a script, a CI job or a one-shot launch, three environment variables name
one target and remember nothing (`studio/desktop/remote-host.mjs`). They
bypass the chooser and disable switching for that launch:

```bash
SIMFORGE_REMOTE_HOST=http://100.72.252.40:5421 \
SIMFORGE_REMOTE_HOST_TOKEN=<controlToken from the host machine> \
SIMFORGE_REMOTE_HOST_ALLOW_PLAINTEXT=1 \
  pnpm --filter @simforge-oss/studio desktop      # or the installed application
```

In this mode the shell is a **guest**:

- it starts no supervisor and assumes no loopback port;
- it checks `/api/simforge/host/capabilities` and refuses a host whose Studio
  version differs from its own, exactly as it refuses a mismatched local host;
- it sets the trusted-local session cookie for the remote origin (HttpOnly,
  SameSite=Strict, `Secure` when the origin is HTTPS) and loads the app;
- quitting the window leaves the host running. That is the existing contract
  for a host the shell did not start, now the only possible outcome.

Without `SIMFORGE_REMOTE_HOST` nothing changes: the shell owns a local host as
before.

### A browser instead of the shell

`POST /api/simforge/host/session` with the control token mints a one-use,
60-second ticket; following it sets the session cookie and redirects to the
requested page. The ticket is built from the authority the request **arrived
on** (`HostOrigin.fromReceivedRequest`,
`packages/studio-host/src/origins.ts`), so a caller on another machine
receives a URL it can actually resolve:

```bash
curl -s -X POST http://100.72.252.40:5421/api/simforge/host/session \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"next":"/dashboard/scenario"}'
# {"url":"http://100.72.252.40:5421/api/simforge/host/session?ticket=..."}
```

`next` must stay a same-origin absolute path, the ticket is single-use and
short-lived, and the control token never appears in a URL. The same authority
is what `studio/proxy.ts` compares `Origin` against for mutations, so the
session a ticket bootstraps can write on exactly the origin it was minted for.

`simforge host open` still refuses any bootstrap URL that is not loopback on
the host's own port — it opens a browser on the *host* machine, where a
network URL would be a sign the host answered for someone else.

## Security: the link must be private

The control token travels as a bearer header and the session cookie travels as
a cookie. Over plain HTTP **both are readable by anyone on the path**, and
either one is full access to the host: the database, the artifacts, the
filesystem endpoints, job submission.

So one of these is required:

1. **A private tailnet** — WireGuard or Tailscale. The `100.64.0.0/10` address
   in the examples is a Tailscale address; traffic on it is encrypted
   node-to-node and the host is not reachable from the public internet.
2. **A TLS terminator** in front of the daemon (`https://` origin). It must
   pass `Host` through unchanged and set `X-Forwarded-Proto: https`; the host
   derives both the ticket URL and the mutation origin check from those.

The refusal is in the type: `HostOrigin.fromConfigured(value, "packaged")`
throws `host_origin_plaintext_network` for plain `http://` on a non-loopback
address unless the caller passes `{ plaintextNetworkAcknowledged: true }`
(`packages/studio-host/src/origins.ts`). The shell applies the packaged rule
in every build, because the rule is about the link and not about the build,
and only the acknowledgement differs by surface:

- the chooser shows the refusal with a checkbox naming the tailnet, and
  stores the acknowledgement **with the target**, so it is re-checked on
  every attach and not only at pairing time — a target saved without it
  never silently becomes a plaintext network attach;
- `SIMFORGE_REMOTE_HOST_ALLOW_PLAINTEXT=1` is the same acknowledgement for
  an environment-pinned launch.

There is no silent fallback either way. Pairing refuses **before** any
request leaves, because the pairing exchange would itself carry the token in
cleartext.

Binding the daemon to `0.0.0.0` on a machine with a public interface exposes
the gate to the internet. It answers `401 local_access_denied` without
credentials, but it is a network service from then on; bind to the tailnet
interface instead if the box has a public address.

## What does not work remotely

Most of what the host does is already remote-correct, because the host does it
on its own machine: the database, artifacts, native runtime installation,
render and evaluation jobs, SimCloud sign-in (the host owns the credential
vault and the OS keyring entry). What cannot cross this boundary is an
operation that assumes the host's filesystem is the GUI machine's filesystem.

**The persistent map cache belongs to the host, not the GUI.** The desktop
map-cache bridge calls that host's `has`/`ensure`/`stream` endpoints; it does not
maintain a second on-disk map store on the laptop. Absolute asset URLs are
accepted when they match the request-scoped `HostOrigin` supplied by the
`has`/`ensure` routes. `parseCanonicalUrl` reduces them to a path, so loopback,
LAN and tailnet spellings share the same cache identity. Foreign origins are
refused rather than added to an allowlist. This works in remote mode; it is
not a reason for the renderer to restart or for asset requests to fail.

The GUI additionally has its ordinary private HTTP response cache. That is
separate from the host's verified content-addressed store: the host cannot
choose a cache directory on the laptop, and a laptop directory chooser cannot
move the host's cache. Unsupported filesystem operations are refused with a
message naming the host, rather than silently doing the wrong thing:

| Feature | Behaviour in remote mode |
|---|---|
| Map cache › "Use another folder…" / "Move cache…" (`MapAssetCacheStorage`, bridge `chooseDirectory`) | Refused. A folder picked on the GUI machine names a path the host cannot write. Change the cache folder on the host machine. |
| Menu › Map Cache › Change Cache Location… | Refused, same reason and message (the menu drives the same bridge). |
| Menu › Map Cache › Open Cache Folder | Refused: the path is on the host machine, and opening it here would open an unrelated folder or nothing. |
| Menu › Help › Open data folder | Refused: the data root is on the host machine. |
| Menu › Map Cache › Cache Usage… / Clear Map Cache… | Work; the dialogs name the host origin instead of claiming "this computer". |
| Menu › Help › Studio host… | Works; reports the origin as "remote, not managed by this app" and the data root as living on the host machine. |
| SimCloud `connect --provider google\|github` | The system browser opens on the GUI machine and the provider redirects to the host's `/api/simforge/cloud/callback`, so the GUI machine must be able to reach the host origin — over the tailnet it can. Password sign-in (`simforge cloud sign-in`, Settings › SimCloud) has no browser hop at all. |
| Desktop auto-update | Updates the shell on the GUI machine only. The host is updated on its own machine; a version skew is refused at attach time with the version on both sides named. |

## Verifying a split deployment

Drive the GUI machine against the host's **network** address, never
`127.0.0.1`, or a loopback shortcut will pass for success:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://<host>:<port>/dashboard/scenario   # 401
TICKET=$(curl -s -X POST http://<host>:<port>/api/simforge/host/session \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"next":"/dashboard/scenario"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["url"])')
curl -s -i -c /tmp/jar "$TICKET" | head -1                                         # 303
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/jar http://<host>:<port>/dashboard/scenario  # 200
```
