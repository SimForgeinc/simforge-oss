//! A single material for all ID clones; the ID travels with the mesh instance.
use bevy::prelude::*;
use bevy::render::render_resource::AsBindGroup;
use bevy::shader::ShaderRef;

#[derive(Asset, TypePath, AsBindGroup, Debug, Clone, Default)]
pub(super) struct AuxMaterial {}

impl Material for AuxMaterial {
    fn fragment_shader() -> ShaderRef { "embedded://sensors/aux_id.wgsl".into() }
    fn enable_shadows() -> bool { false }
}

pub(super) fn install(app: &mut App) {
    bevy::asset::embedded_asset!(app, "aux_id.wgsl");
    app.add_plugins(MaterialPlugin::<AuxMaterial>::default());
}
