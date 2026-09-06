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
   tree. Published versions are never overwritten or reused.
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

## Rollback

Rollback Cloud by restoring a previously committed stack lock and its matching
content-addressed artifacts. Never republish an old version, overwrite an npm
package, or move a release tag.
