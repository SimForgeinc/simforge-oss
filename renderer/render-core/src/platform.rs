//! Operating-system edges of the headless renderer.
//!
//! Two things differ between the Linux, macOS and Windows builds of the
//! baseline local renderer and nothing else in the render path does:
//!
//! * which wgpu backend the headless `App` is allowed to create its device
//!   on ([`baseline_backends`]) — the renderer's shaders and readback rely on
//!   a modern explicit API (compute, storage buffers, 256-byte row copies),
//!   so only backends this crate is actually qualified on are enabled and a
//!   host without one fails device creation instead of degrading through GL;
//! * how an absolute filesystem path becomes a Bevy asset path
//!   ([`asset_path`]) for the tile, vegetation and actor GLBs every entry
//!   point loads.
//!
//! The Linux NVIDIA Vulkan→CUDA bridge (`gpu_interop`, feature
//! `gpu-interop`) is deliberately *not* part of this module: it is an
//! optional Linux capability, rejected at compile time elsewhere.

use anyhow::{bail, Result};
use bevy::asset::AssetPlugin;
use bevy::render::settings::{Backends, RenderCreation, WgpuSettings};
use bevy::render::RenderPlugin;
use std::path::Path;

/// Filesystem root every headless app mounts as its default asset source.
///
/// Absolute paths handed to the asset server replace this root when joined
/// (`Path::join` semantics), so the value only has to exist. `/` is the
/// filesystem root on Unix and the current drive's root on Windows.
pub const ASSET_ROOT: &str = "/";

/// Baseline graphics backends selected for this OS; each target needs runtime qualification.
///
/// * Linux: Vulkan (the qualified reference path; also the only backend the
///   optional `gpu-interop` bridge can attach to).
/// * macOS: Metal, the platform's supported graphics API. MoltenVK is not
///   required and not used.
/// * Windows: Vulkan or DirectX 12 through the installed driver, whichever
///   wgpu ranks first for the selected adapter.
///
/// `WGPU_BACKEND` still overrides this for diagnostics (see
/// [`wgpu_settings`]).
pub fn baseline_backends() -> Backends {
    if cfg!(target_os = "macos") {
        Backends::METAL
    } else if cfg!(target_os = "windows") {
        Backends::VULKAN | Backends::DX12
    } else {
        Backends::VULKAN
    }
}

/// Bevy's default wgpu settings restricted to [`baseline_backends`].
///
/// Everything else (high-performance power preference, `WGPU_SETTINGS_PRIO`,
/// DX12 compiler selection, instance flags) keeps Bevy's defaults so the
/// Linux path is exactly what was qualified before this restriction.
pub fn wgpu_settings() -> WgpuSettings {
    let mut settings = WgpuSettings::default();
    settings.backends = Some(Backends::from_env().unwrap_or_else(baseline_backends));
    settings
}

/// `RenderPlugin` for a headless app on this OS.
///
/// `synchronous_pipeline_compilation` is passed through for the finite
/// command-line tools, which exit right after their last capture and must
/// not leave a compilation task running past device teardown.
pub fn render_plugin(synchronous_pipeline_compilation: bool) -> RenderPlugin {
    RenderPlugin {
        render_creation: RenderCreation::Automatic(Box::new(wgpu_settings())),
        synchronous_pipeline_compilation,
        ..Default::default()
    }
}

/// `AssetPlugin` rooted at [`ASSET_ROOT`].
pub fn asset_plugin() -> AssetPlugin {
    AssetPlugin {
        file_path: ASSET_ROOT.into(),
        ..Default::default()
    }
}

/// Convert an absolute filesystem path into the asset path the default
/// source resolves back to that file.
///
/// * Unix: the leading `/` is dropped — the path is joined onto
///   [`ASSET_ROOT`], which yields the original file and keeps the asset ids
///   the Linux renderer has always used.
/// * Windows: the path stays absolute with forward slashes, `C:/maps/a.glb`
///   or `//server/share/a.glb`; joining an absolute path replaces the root.
///   Verbatim (`\\?\`) prefixes are folded into their drive/UNC form because
///   a forward-slash verbatim prefix is not a prefix to the path parser, and
///   a bare `//?/` would be read as a UNC server named `?`.
///
/// Relative paths are rejected: every caller has already resolved its GLBs
/// against a map or catalog directory and a relative name here would load
/// from the wrong root silently.
pub fn asset_path(path: &Path) -> Result<String> {
    if !path.is_absolute() {
        bail!("asset paths must be absolute: {}", path.display());
    }
    if !cfg!(windows) {
        return Ok(path.to_string_lossy().trim_start_matches('/').to_owned());
    }
    use std::path::{Component, Prefix};
    let mut out = String::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => match prefix.kind() {
                Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
                    out.push(char::from(letter));
                    out.push(':');
                }
                Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                    out.push_str("//");
                    out.push_str(&server.to_string_lossy());
                    out.push('/');
                    out.push_str(&share.to_string_lossy());
                }
                Prefix::Verbatim(_) | Prefix::DeviceNS(_) => {
                    bail!("asset path prefix is not a file location: {}", path.display())
                }
            },
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => out.push_str("/.."),
            Component::Normal(name) => {
                out.push('/');
                out.push_str(&name.to_string_lossy());
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn baseline_backends_never_include_gl() {
        assert!(!baseline_backends().contains(Backends::GL));
        assert!(!baseline_backends().contains(Backends::BROWSER_WEBGPU));
    }

    #[cfg(unix)]
    #[test]
    fn unix_asset_paths_drop_the_root() {
        assert_eq!(asset_path(Path::new("/maps/rfs/master.gltf")).unwrap(), "maps/rfs/master.gltf");
        assert!(asset_path(Path::new("maps/rfs/master.gltf")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_asset_paths_keep_the_drive() {
        assert_eq!(
            asset_path(Path::new(r"C:\maps\rfs\master.gltf")).unwrap(),
            "C:/maps/rfs/master.gltf"
        );
        assert_eq!(asset_path(Path::new(r"\\?\C:\maps\a.glb")).unwrap(), "C:/maps/a.glb");
        assert_eq!(
            asset_path(Path::new(r"\\server\share\maps\a.glb")).unwrap(),
            "//server/share/maps/a.glb"
        );
        assert!(asset_path(Path::new(r"maps\rfs\master.gltf")).is_err());
    }
}
