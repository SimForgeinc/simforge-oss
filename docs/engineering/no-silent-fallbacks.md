# No silent fallbacks in render output

Missing, failed, or unsupported data never silently degrades a render. Every
case does exactly one of these:

1. **Fail the job** with a machine code that names the missing thing
   (`native_*` for the Bevy path, `carla_*` for CARLA, `render_*` for
   engine-neutral checks) and a message that names the actor, sensor, file or
   field involved. These errors are never retryable: a different worker would
   fail the same way.
2. **Substitute explicitly**, only where the substitution is genuine product
   behaviour. The job input must request it (`RenderIntentV1.allowSubstitutions`),
   and the engine must record every substitution it makes in its manifest
   (`substitutions`, gated by `CONTROL_FEATURE_RENDER_SUBSTITUTIONS`). The UI
   and the job result then show it. Absent the request, the job fails.

Preview-only paths (the editor's local preview, the browser engine's
`browser-preview` purpose) may degrade, but only when the degradation is
visibly labelled.

## Mechanics

- TypeScript: throw `RenderInputError(code, message)` from
  `@simforge-oss/render`. The render worker reports its code as
  `render.<code>`, non-retryable.
- The native service (`renderer/service`) prefixes policy errors with
  `[native_<code>] `. The TypeScript service client turns that prefix back into
  a `RenderInputError`.
- CARLA (`adapters/carla-exec`) raises its contract error with a `carla_*` code.
- New manifest fields follow the `CONTROL_FEATURE_*` rule in
  `packages/render/src/worker-control.ts`: a new constant, listed by control
  planes that parse it, and written only when the lease lists it.

## Guard

`scripts/ci/no-silent-fallbacks.mjs` (run by `pnpm verify:no-silent-fallbacks`
and in CI) scans `renderer/`, `packages/render/src` and
`adapters/carla-exec/simforge_oss_carla_exec` for fallback constructs:
- `unwrap_or*`, `.ok()`, `let _ =` and `Err(_) =>` in Rust;
- `?? <literal>`, `|| <literal>`, `catch {}` and `.catch(() => ...)` in TypeScript;
- `except ...: pass`, `.get(key, default)` and `or <literal>` in Python;
- the words fallback, placeholder and proxy.

Each hit must match an entry in `scripts/ci/no-silent-fallbacks.allowlist.json`,
which records a path, the exact matched line text, and a justification (why the
construct cannot change render output, or which recorded, explicit mechanism
covers it). New code that adds a construct without an allowlist entry fails the
check. Moving code is fine: entries match on text, not line numbers.

## Findings and treatment

See the table at the end of this file. It is maintained with the code: a row is
added or updated whenever a fallback is removed or made explicit.
