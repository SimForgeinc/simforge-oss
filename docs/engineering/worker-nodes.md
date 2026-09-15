# SimForge worker nodes

A worker is a `simforge worker` process. The daemon starts the same CLI
process locally; a GPU box can run it against the daemon's HTTP(S) origin over
Tailscale. Workers do not open the host database or host filesystem.

## Control-plane contract

1. **Register/poll:** the worker authenticates with its worker token and sends
   its stable worker id and the engines it currently offers. The CPU claim
   request carries the offered engine set; the host uses it to scope leases.
   Engine availability is probed from the worker's local installation and
   `--capabilities` can only narrow that set.
2. **Lease/claim:** the job ledger is the scheduler. A claim contains a job
   family, attempt fence, immutable input declarations, and host-issued input
   URLs. The worker downloads inputs from those URLs and heartbeats the lease.
3. **Heartbeat:** heartbeats carry the attempt fence and progress. A requested
   cancellation or lost lease stops execution; stale leases are requeued or
   failed by the host.
4. **Reserve/upload:** before completion, the worker reserves each output. It
   uploads bytes with the URL and headers returned by the host (including
   presigned object-store URLs).
5. **Complete/fail:** the worker sends the fenced completion manifest, or a
   fenced failure code and detail. The host verifies digests and evidence before
   marking the ledger job successful.

The worker token is a bearer credential for internal worker routes. It is
required by the CLI and is never inferred from a remote host URL. A local
supervisor injects the per-host control token into its child. Presigned input
and output URLs are the only transfer paths; their origin must not be rewritten
for a remote worker.

## Capability routing

`native` and `browser` are the current CPU render engines. A worker advertises
only engines that its probes find and that its optional capability filter
allows. The host's lease query intersects the job family and engine filters,
so a node cannot receive an engine it did not offer. Host status reports worker
id, engine list, capability document (when registered), and last heartbeat.

## Remote-safety findings

- Browser and compiler inputs are checksum-bound URLs supplied in the claim;
  browser and native output uploads use reserve responses and presigned URLs.
  These paths are remote-safe.
- A native claim's `prepareMap` response currently returns a directory path
  materialized by the host. `native-render.ts` verifies members by reading that
  path directly. This is a known local-only dependency: a remote worker cannot
  read the host's map cache. The required fix is a map-cache/asset route that
  returns checksum-bound member download URLs, followed by worker-side
  materialization under its scratch root.
- A claim input with a `file:` URL is copied directly from the worker's local
  filesystem. This is safe only when the packaged actor closure is installed on
  that worker; remote jobs must instead receive an HTTP object URL. The route
  fix is to publish that closure through the existing artifact/input URL path.
- Scratch paths (`LOCAL_WORKER_ROOT`) are worker-local and are never sent to
  the host. The worker must not set or rely on `SIMFORGE_CLOUD_ROOT`.

Until the map and `file:` inputs are URL-backed, remote workers should be used
for URL-backed browser/compiler jobs or will fail closed on those local-only
inputs; they must not silently use a host path.

## Adding a job family

For a new family such as `rl.train`, add its ledger table and attempt/lease
fence events, add `rl.train` to the shared family contract and claim query, add
an explicit worker capability name (for example `rl-train`), and implement the
worker executor using the same heartbeat, URL input, reserve/upload, and
complete/fail protocol. Then expose it through the existing CLI verbs
`simforge submit`, `simforge wait`, and `simforge artifacts`; no second
scheduler or GPU API is needed.
