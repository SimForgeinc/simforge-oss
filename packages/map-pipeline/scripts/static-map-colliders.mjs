/**
 * The static-collider producer, re-exported.
 *
 * This file used to carry its own copy of the extractor, which drifted twice
 * over: it kept the old name-inclusion rule (so a component-named mesh under a
 * semantic ancestor was silently `ignored`), and it emitted the schema string
 * `simforge-oss.static-map-colliders/v1`, which `@simforge-oss/playback`'s
 * loader rejects — it accepts only `simforge.static-map-colliders/v1`. So every
 * artifact this path produced was refused at load time.
 *
 * There is one producer now. `scripts/build-map-derivatives.mjs` reaches it
 * through `scripts/static-map-colliders-lib.mjs`, which resolves this subpath.
 */
export * from '@simforge-oss/maps/ingest';
