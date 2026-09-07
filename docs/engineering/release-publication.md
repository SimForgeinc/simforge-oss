# Immutable SimForge stack publication

SimForge is the source repository for the `@simforge-oss/*` TypeScript stack,
the native Rust runtime it binds, the `simforge-oss-*` Python distributions,
Studio, and Renderer. SimForge Cloud consumes published artifacts; it does not
keep private copies of portable implementations.

## Release contract

1. Every public package has the exact lockstep version in
   `config/simforge-oss-stack.json` (`stackVersion`); Python distributions use
   its PEP 440 form (`0.1.0-rc.<N>` becomes `0.1.0rc<N>`).
2. The config registers every public `@simforge-oss/*` npm package under
   `packages/` and every public `simforge-oss-*` Python distribution. A
   publishable workspace package without a registry entry, or an internal
   dependency on an unregistered package, fails manifest generation.
3. A release tag is exactly `v<stackVersion>` and identifies one immutable Git
   tree. Published versions are never overwritten or reused. This namespace
   belongs to the stack alone: the desktop application publishes installer
   sets under `studio-<label>` tags (see
   [desktop-release.md](desktop-release.md)), because a `v*` tag triggers the
   stack publication workflow and an installer release must not.
4. Internal dependencies in packed artifacts are pinned to that stack version;
   no `workspace:` specifier survives publication.
5. Export maps and packed files are verified before publication. Browser-safe
   roots do not pull Node-only, three.js, or native execution code through
   merged subpaths.
6. npm and Python publication run only from the tagged trusted workflow with
   provenance. Local release commands prepare and verify artifacts but do not
   publish.
7. The source revision, tarball/wheel SHA-256, npm integrity, package role, and
   version are recorded in the generated release manifest.

## Package set

The npm and Python sets are exactly the `packages` and `pythonPackages`
entries of `config/simforge-oss-stack.json`; roles come from the same file.
Native Rust crate versions and the engine ABI are independent of
`stackVersion`; only the published distributions carry it.

## Release procedure

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:release
pnpm release:manifest
pnpm release:verify-artifacts
pnpm release:smoke-packages
```

Inspect the generated manifest and packed contents. Commit the version and
manifest changes, create `v<stackVersion>`, and push the tag. The trusted
workflow rebuilds from the tag, reruns verification, checks the tag/version/tree
identity, publishes, and attaches provenance.

The Cloud intake follows [simcloud-sync.md](simcloud-sync.md): its stack lock,
vendored artifacts, import rewrites, package-manager lockfile, and divergence
audit expectations change atomically.

## Source-bound vendored artifacts precede registry publication

SimForge Cloud consumes published artifacts, and it may consume them before
npm and PyPI carry them. Vendored tarballs are built from the exact
integrated OSS commit, digest-verified, and recorded with the full stack
manifest and source revision, which is the same provenance a registry
release carries — so the portal and the desktop app ship source-bound
without waiting for a public registry release. This is the existing vendor
source-distribution path, not a shim: `scripts/sync-simforge-oss-stack.mjs`
packs the same package contracts, `verify-simforge-oss-vendor.mjs` proves
the vendored bytes against the lock, and a hand-edited vendor tree is never
acceptable.

Registry publication keeps its own, separate checks: the `v<stackVersion>`
tag, the portable/export-map/packed-content verification in `publish.yml`,
and provenance. Those are not bypassed or relaxed because a vendored
prerelease exists, and a **stable** desktop release still requires the
registry publication to have succeeded (see `stable-gates.mjs`
`stack-identity-published`). Failing portable tests are repaired, never
skipped.

## Desktop releases

SimForge Studio installers are a separate publication of the same tree, with
their own tags (`studio-<label>`), their own record (`RELEASE.json`,
`simforge.desktop-release/v2`) and their own gates. A desktop preview does
not wait for npm publication; a **stable** desktop release does, because its
`stable-gates.mjs` `stack-identity-published` gate requires the
`v<stackVersion>` tag to exist and the registry to carry it, and the Cloud
vendor lock to name the same revision the installers were built from. That is
the only coupling between the two publications.

## Rollback

Rollback Cloud by restoring a previously committed stack lock and its matching
content-addressed artifacts. Never republish an old version, overwrite an npm
package, or move a release tag.
