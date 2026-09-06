# `@simforge-oss/openscenario/esmini`

Pinned external execution boundary for esmini 3.6.0. It consumes only the typed
`EsminiExecutionJob` produced by the compatibility bundle builder and returns a
browser-safe `ExternalRunResult` containing execution status, immutable cache
identity, structured logs, and opaque artifact handles.

Production jobs must use the Docker invocation profile: no network, read-only
root and inputs, an unprivileged user, no Linux capabilities, bounded CPU,
memory, processes, runtime, and output. `LocalProcessExecutor` is explicitly a
developer convenience and reports `developer-local` isolation; it must not be
used as production evidence.

The numerical CSV/DAT/OSI outputs and collision log are authoritative external
evidence. Frames and video are optional, non-authoritative human evidence.

Install the official pinned binary locally with:

```sh
node packages/openscenario/scripts/fetch-pinned-esmini.mjs
```

The helper verifies the upstream archive SHA-256 before extraction. `.tools/`
must remain untracked. See [NOTICE.md](./NOTICE.md) for licensing.

Real esmini interoperability evidence is produced by the bundle builder in
`src/node/esmini-bundle.ts` (`buildEsminiRunnableBundle` and the runner around
it): it exports a validated OpenSCENARIO 1.3.1 package beside the canonical
native trace, executes the pinned binary, strictly parses the external CSV and
applies the normal trace-comparison release thresholds. Signal-edge timing and
signal-caused stop-line behaviour remain fail-closed because the pinned wide CSV
has no signal identity/state channel; a stopped baked trajectory is not accepted
as proof of traffic-signal execution. Native OSC 1.4 execution remains
unsupported by this pinned player. Binaries, source clones, maps, and run
outputs stay outside version control.
