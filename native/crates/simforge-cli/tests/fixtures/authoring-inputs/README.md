# authoring-inputs

Inputs some authoring parity goldens read that live outside the SDK tree in the
platform repository (where the differential harness runs): a map-bound
template, deliberately broken templates, and two non-template files used as
"not a template / not JSON" inputs. `tests/authoring_parity.rs` maps an argv
entry `packages/<p>` to `native/crates/simforge-cli/tests/fixtures/authoring-inputs/packages/<p>`
and maps it back in the result, so the goldens stay byte-identical to what the
harness proved. Keep these files byte-identical to their platform originals.
