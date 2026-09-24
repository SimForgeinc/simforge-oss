# Paths the release tooling needs, in one place. Sourced by scripts/release/*.sh
# and by the release workflows (they append it to $GITHUB_ENV).
#
# These are the post-move paths (PLAN §3.2 `cli/` layout at the root of
# SimForgeinc/simforge-sdk). Track S owns the layout: when a path moves, change
# it here and nowhere else.
SIMFORGE_CLI_PACKAGE=simforge
SIMFORGE_CLI_MANIFEST=crates/simforge-cli/Cargo.toml
SIMFORGE_GYM_DIR=python/simforge-oss-gym
SIMFORGE_GYM_DIST_NAME=simforge_oss_gym
# In-repo asset catalogs whose ATTRIBUTION.json must be complete (track X moves
# the models out of git; the manifests and ATTRIBUTION.json stay).
SIMFORGE_ASSET_CATALOGS="assets/vehicles-carla assets/pedestrians-carla"
# The actor closure the CLI pulls by default (digest), checked on every release.
SIMFORGE_ACTOR_CLOSURE_PIN_FILE=contracts/pins/actor-assets.json
# The fixture the release smoke renders with lavapipe: a full-form (air-gapped)
# scenario package, so the smoke needs no registry.
SIMFORGE_SMOKE_PACKAGE=fixtures/scenario-package/smoke/richmond-06.full.zip
SIMFORGE_SMOKE_RIG=fixtures/scenario-package/smoke/rig.json
