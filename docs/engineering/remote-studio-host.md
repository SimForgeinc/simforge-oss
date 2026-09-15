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

The supervisor binds where `HOSTNAME` says
(`packages/studio-host/src/node/local-host-supervisor.ts`, `localHostConfig`),
which defaults to `127.0.0.1`. Bind it to every interface:

```bash
SIMFORGE_CLOUD_ORIGIN=https://staging.simforge.ai \
HOSTNAME=0.0.0.0 simforge daemon --port 5421 --data-root ~/.simforge/cloud
```

Set `SIMFORGE_CLOUD_ORIGIN` explicitly, even for read-only work. Unset, it
falls back to `DEFAULT_CLOUD_ORIGIN = "https://simforge.ai"`
(`studio/app/lib/cloud/connection.ts:33,194`) - production. That default is
defensible for an installed desktop app and is a poor one for a host you are
binding to a network address to experiment against, because every SimCloud
call the GUI makes then lands on production.

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

## Point the desktop shell at it

Three environment variables, read by `studio/desktop/remote-host.mjs`:

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
on** (`receivedUrl`, `packages/studio-host/src/node/received-url.ts`), so a
caller on another machine receives a URL it can actually resolve:

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

The shell refuses a non-loopback `http://` target unless the operator sets
`SIMFORGE_REMOTE_HOST_ALLOW_PLAINTEXT=1`, which is the acknowledgement that
case 1 applies. There is no silent fallback: without the variable the shell
shows the refusal and quits.

Binding the daemon to `0.0.0.0` on a machine with a public interface exposes
the gate to the internet. It answers `401 local_access_denied` without
credentials, but it is a network service from then on; bind to the tailnet
interface instead if the box has a public address.

## What does not work remotely

Everything the host does is already remote-correct, because the host does it on
its own machine: the database, artifacts, the map cache **contents**, native
runtime installation, render and evaluation jobs, SimCloud sign-in (the host
owns the credential vault and the OS keyring entry). What breaks is anything
that assumed the host's filesystem *is* the GUI machine's filesystem. Each of
those is refused with a message that names the host, rather than silently doing
the wrong thing:

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
