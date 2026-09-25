# Paths the release tooling needs, in one place. Sourced by scripts/release/*.sh
# and by the release workflows (they append it to $GITHUB_ENV).
#
# The SDK keeps today's oss/ layout (SPLIT-MAP.md, track S owns it): no root
# Cargo workspace; the CLI is a member of the renderer workspace. When a path
# moves (the post-move workspace unification, track X's closure pins, track P's
# fixtures), change it here and nowhere else.
SIMFORGE_CLI_PACKAGE=simforge
SIMFORGE_CLI_MANIFEST=native/crates/simforge-cli/Cargo.toml
# Every Cargo workspace whose crates ship (cargo deny runs over each).
SIMFORGE_CARGO_WORKSPACES="renderer native native/crates/simforge-timeline-python"
SIMFORGE_GYM_DIR=adapters/gym
SIMFORGE_GYM_DIST_NAME=simforge_oss_gym
# The Python distributions released together at the CLI's version (PEP 440
# spelling), each dir:kind. `native` = maturin abi3 extension (one wheel per
# platform), `pure` = one py3-none-any wheel. Sibling pins between them are ==.
SIMFORGE_PY_DISTS="adapters/gym:native adapters/timeline:native adapters/gpu:pure adapters/physics:pure renderer/service/python:pure"
# In-repo asset catalogs whose ATTRIBUTION.json must be complete (track X moves
# the models out of git; the manifests and ATTRIBUTION.json stay).
SIMFORGE_ASSET_CATALOGS="catalog/vehicles-carla catalog/pedestrians-carla"
# The asset closures the SDK pins (simforge.asset-closures-lock/v1, track X):
# every closure in it is attribution-checked on every release.
SIMFORGE_CLOSURES_LOCK=catalog/closures.lock.json
# The fixture the release smoke renders with lavapipe (track P): a thin package
# pinning the public Richmond release and actor closure by digest; its golden
# scene is qualification/golden-harness package-smoke-richmond. The rig path is
# settled at the dry run.
SIMFORGE_SMOKE_PACKAGE=fixtures/scenario-package/smoke/richmond-public.scenario.zip
SIMFORGE_SMOKE_RIG=fixtures/scenario-package/smoke/rig.json
