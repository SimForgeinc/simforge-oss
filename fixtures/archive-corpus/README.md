# Archive corpus

Real artifacts from past SimForge releases, stored **verbatim**, with the
expectations every later release must keep. A scenario authored once must stay
playable: its trace must still read, keep its identity and replay the same
motion, whatever the engine, trace format or sampler version is now.

| Path | What |
|---|---|
| `corpus.json` | One entry per artifact: provenance (`release`, `recorded`, `source`), the sha256 of the stored bytes and the expectations. |
| `traces/` | Stored traces, byte for byte as they were written (gzip or plain JSON). |
| `timelines/` | Stored render timelines, when one was archived with its trace. |
| `documents/` | Scenario documents and revision contents. |

Expectations are computed from the stored bytes alone, never by the reader
under test:

- `shape` / `traceVersion` / `unrecorded`: how the reader must classify the
  trace, and exactly which sections its source never recorded (the reader lists
  them instead of inventing them, and evaluators refuse them).
- `identity`: the identity the reader must report. That's the recorded
  `traceSha256` where the trace was registered with one; otherwise, for an
  upgraded trace, `documentSha256` (the canonical digest of the stored
  document). It's `null` for current-format traces that were never registered.
- `motionSha256`: the stored tick times and per-actor world poses on the trace
  grid (position 4 dp, heading 6 dp, `null` where the actor is absent), hashed
  with SimForge canonical JSON.

## Tests

- `cargo test -p simforge-core --test archive_corpus` (run by the merge gate's
  `rust` step, `scripts/gate-local.sh`) checks every trace. It must still be the same bytes and still read, upgraded
  in memory where older, as the expected shape with the expected unrecorded
  sections. It must keep its identity. And it must replay the same motion: the
  upgraded trace, the render timeline built from it on the CPU (no GPU), and
  the shared sampler at every tick all reproduce `motionSha256`. An archived
  timeline must carry the same motion as the timeline re-derived under the
  current sampler.
- `cargo test -p simforge-package --test round_trip archive_corpus_documents_round_trip`
  packages every archived document and checks that the package's document
  digest is the entry's `documentSha256`.

## Rules

- **Append-only.** Never edit or delete an entry or a stored file, and never
  reuse an id. If a reader change breaks an entry, fix the reader
  (add an upgrade step), not the entry.
- A new trace format ships with its `vN_to_vN+1` step in
  `native/crates/simforge-core/src/trace/upgrade.rs`, in the same change.
- A new sampler version needs no migration. Timelines are keyed by
  `(traceSha256, heightFieldDigest, catalogDigest, samplerVersion)`, so a
  sampler bump derives a new timeline from the stored trace. Archived
  timelines from the old sampler stay here, and the test checks that their
  motion equals the re-derived one.
- Keep it compact: prefer short clips with few actors. Keep the whole corpus
  under ~10 MB. Never commit customer data: use QA, example or synthetic
  scenarios only.

## Release step: add to the corpus at every release

After cutting a release, add at least one trace produced by that release's
engine (and its timeline, if the release stores one), plus one scenario
document saved by that release of the hosted editor. Store the bytes verbatim
under `traces/`, `timelines/` or `documents/`, append the entry to
`corpus.json` with its provenance (`release`, `recorded`, `source`), the
sha256 of the stored bytes and expectations computed independently of the
reader under test, then run:

```sh
cargo test -p simforge-core --test archive_corpus
cargo test -p simforge-package --test round_trip
```

Pick artifacts that exercise something the corpus lacks: a new actor kind,
signals, ambient or SUMO traffic, a new trace or timeline version.
