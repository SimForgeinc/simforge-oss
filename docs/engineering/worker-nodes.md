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
- A native claim's `prepareMap` response is URL-backed. `ready` carries the
  map version, timestamps, and one entry per declared closure member with a
  session-less, checksum-bound `download`; no host path is returned. The
  worker materializes the closure under its own scratch root through a
  content-addressed cache (`<LOCAL_WORKER_ROOT>/map-cache/sha256/<xx>/<sha>`),
  so a repeated job on the same map downloads nothing, and then verifies the
  materialized directory against the intent's declarations as before. On a
  hosted deployment the member URLs are presigned object-store URLs and the
  host downloads nothing; on a local host, whose map cache *is* its object
  store, the closure is ensured on disk first and the members are served by
  the map's `semantic-assets` route.
- A claim input with a `file:` URL is copied from the worker's local
  filesystem, which is the host's filesystem only when the host origin is
  loopback. A worker that claimed from any other origin refuses such an input
  by name instead of reading whatever sits at that path. The packaged actor
  closure must therefore be published through the artifact/input URL path for
  remote workers.
- Scratch paths (`LOCAL_WORKER_ROOT`) are worker-local and are never sent to
  the host. The worker must not set or rely on `SIMFORGE_CLOUD_ROOT`.

## Adding a job family

For a new family such as `rl.train`, add its ledger table and attempt/lease
fence events, add `rl.train` to the shared family contract and claim query, add
an explicit worker capability name (for example `rl-train`), and implement the
worker executor using the same heartbeat, URL input, reserve/upload, and
complete/fail protocol. Then expose it through the existing CLI verbs
`simforge submit`, `simforge wait`, and `simforge artifacts`; no second
scheduler or GPU API is needed.
