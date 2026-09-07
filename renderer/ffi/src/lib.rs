//! `simforge_render` (`libsimforge_render.so` / `libsimforge_render.dylib` /
//! `simforge_render.dll`): the native render service as an in-process C ABI.
//!
//! Same resident scene, same V5 request/response contract as the socket
//! service (`service::proto`), driven by JSON documents instead of
//! msgpack frames, so a host talks to the renderer on its own thread
//! without a socket hop. Host frames go through the shm ring the handle was
//! created with (a regular file on every OS), which the host maps
//! read-only. Device streams hand their exported descriptors over directly
//! ([`simforge_render_take_export`]) for `ImportedStream.from_handles`;
//! that path exists only in Linux `gpu-interop` builds
//! ([`simforge_render_gpu_interop`] reports it) and returns nothing
//! elsewhere.
//!
//! Threading: every function on one handle must be called from a single
//! thread (the Bevy `App` is not `Send`); the handle owns that thread's
//! renderer until [`simforge_render_close`].
//!
//! Strings returned by this library are NUL-terminated, allocated here and
//! must be released with [`simforge_render_free_string`].
use service::proto::{decode_request_json, WireResponse};
use service::server::{prewarm, SceneSpec, ServiceState};
use service::shm::ShmRing;
use std::ffi::{c_char, c_int, CStr, CString};
use std::path::Path;
use std::ptr;

/// Opaque resident renderer.
pub struct Renderer {
    state: ServiceState,
    #[cfg(feature = "gpu-interop")]
    export: Option<render_core::gpu_interop::ExportedStream>,
}

/// ABI revision of this library; bumps with any signature change.
pub const SIMFORGE_RENDER_ABI: c_int = 1;

#[no_mangle]
pub extern "C" fn simforge_render_abi() -> c_int {
    SIMFORGE_RENDER_ABI
}

/// Wire protocol version served by [`simforge_render_request`].
#[no_mangle]
pub extern "C" fn simforge_render_protocol() -> c_int {
    service::proto::NATIVE_SERVICE_PROTOCOL_VERSION as c_int
}

/// 1 when this library was built with `gpu-interop` (device-stream ops
/// answer), 0 when those ops are rejected.
#[no_mangle]
pub extern "C" fn simforge_render_gpu_interop() -> c_int {
    c_int::from(cfg!(feature = "gpu-interop"))
}

fn c_string(value: String) -> *mut c_char {
    CString::new(value)
        .unwrap_or_else(|_| CString::new("string contained NUL").expect("literal"))
        .into_raw()
}

fn set_error(error: *mut *mut c_char, message: String) {
    if !error.is_null() {
        // SAFETY: caller passes a valid out-pointer.
        unsafe { *error = c_string(message) };
    }
}

/// # Safety
/// `ptr` must be NUL-terminated and valid for the call.
unsafe fn str_arg<'a>(ptr: *const c_char, name: &str) -> Result<&'a str, String> {
    if ptr.is_null() {
        return Err(format!("{name} is null"));
    }
    CStr::from_ptr(ptr)
        .to_str()
        .map_err(|_| format!("{name} is not UTF-8"))
}

/// Prewarm a scene and return a renderer handle, or null with `error` set.
///
/// `scene_json` is the same document `native-render-service --scene` reads;
/// `shm_path` is the ring file host frames are published to (created here,
/// `shm_size_bytes` total).
///
/// # Safety
/// C strings must be NUL-terminated; `error` may be null.
#[no_mangle]
pub unsafe extern "C" fn simforge_render_open(
    scene_json: *const c_char,
    shm_path: *const c_char,
    shm_size_bytes: u64,
    error: *mut *mut c_char,
) -> *mut Renderer {
    let opened = (|| -> Result<Renderer, String> {
        let scene = str_arg(scene_json, "scene_json")?;
        let shm_path = str_arg(shm_path, "shm_path")?;
        let spec: SceneSpec = serde_json::from_str(scene).map_err(|e| format!("parse scene: {e}"))?;
        let app = prewarm(&spec).map_err(|e| format!("prewarm: {e:#}"))?;
        let shm = ShmRing::create(Path::new(shm_path), shm_size_bytes as usize)
            .map_err(|e| format!("create shm ring: {e:#}"))?;
        let state = ServiceState::new(app, &spec, shm_path.to_string(), shm)
            .map_err(|e| format!("service state: {e:#}"))?;
        Ok(Renderer {
            state,
            #[cfg(feature = "gpu-interop")]
            export: None,
        })
    })();
    match opened {
        Ok(renderer) => Box::into_raw(Box::new(renderer)),
        Err(message) => {
            set_error(error, message);
            ptr::null_mut()
        }
    }
}

/// Serve one V5 request (`{"i": .., "op": "..", ...}` as JSON) and return the
/// response document as JSON. Errors in the request itself are answered
/// with the protocol's `{"ok": false, "error": ..}` shape, never null.
///
/// # Safety
/// `handle` must come from [`simforge_render_open`] and not be closed;
/// `request_json` must be NUL-terminated.
#[no_mangle]
pub unsafe extern "C" fn simforge_render_request(
    handle: *mut Renderer,
    request_json: *const c_char,
) -> *mut c_char {
    let Some(renderer) = handle.as_mut() else {
        return c_string(error_json(0, "null renderer handle"));
    };
    let request = match str_arg(request_json, "request_json").and_then(decode_request_json) {
        Ok(request) => request,
        Err(message) => return c_string(error_json(0, &message)),
    };
    let response = service::server::dispatch(&mut renderer.state, request);
    #[cfg(feature = "gpu-interop")]
    if let Some(exported) = renderer.state.take_export() {
        renderer.export = Some(exported);
    }
    c_string(serde_json::to_string(&response).unwrap_or_else(|e| error_json(0, &e.to_string())))
}

fn error_json(i: u64, message: &str) -> String {
    serde_json::to_string(&WireResponse::error(i, message)).expect("error response serialises")
}

/// Take the descriptors of the last acknowledged `export_device_stream`:
/// writes up to `capacity` raw fds (manifest `handle_order` per slot:
/// memory, ready, release) into `fds`, returns the manifest JSON, and sets
/// `*count` to the number of fds. Ownership of the fds transfers to the
/// caller. Returns null with `*count = 0` when no export is pending, or
/// when `capacity` is too small (nothing is consumed in that case; `*count`
/// then holds the required capacity).
///
/// # Safety
/// `fds` must point at `capacity` writable `c_int`s; `count` must be valid.
#[no_mangle]
pub unsafe extern "C" fn simforge_render_take_export(
    handle: *mut Renderer,
    fds: *mut c_int,
    capacity: usize,
    count: *mut usize,
) -> *mut c_char {
    if count.is_null() {
        return ptr::null_mut();
    }
    *count = 0;
    let Some(renderer) = handle.as_mut() else {
        return ptr::null_mut();
    };
    #[cfg(feature = "gpu-interop")]
    {
        use std::os::fd::IntoRawFd;
        let needed = renderer.export.as_ref().map_or(0, |e| e.fds().len());
        if needed == 0 {
            return ptr::null_mut();
        }
        if capacity < needed || fds.is_null() {
            *count = needed;
            return ptr::null_mut();
        }
        let exported = renderer.export.take().expect("checked above");
        let (manifest, owned) = exported.into_parts();
        for (index, fd) in owned.into_iter().enumerate() {
            *fds.add(index) = fd.into_raw_fd();
        }
        *count = needed;
        return c_string(serde_json::to_string(&manifest).expect("manifest serialises"));
    }
    #[cfg(not(feature = "gpu-interop"))]
    {
        let _ = (renderer, fds, capacity);
        ptr::null_mut()
    }
}

/// Release a string returned by this library.
///
/// # Safety
/// `s` must have been returned by this library and not freed before.
#[no_mangle]
pub unsafe extern "C" fn simforge_render_free_string(s: *mut c_char) {
    if !s.is_null() {
        drop(CString::from_raw(s));
    }
}

/// Tear the renderer down. Device streams are destroyed without grace;
/// consumers holding imported memory keep it alive through their imports.
///
/// # Safety
/// `handle` must come from [`simforge_render_open`] and not be closed twice.
#[no_mangle]
pub unsafe extern "C" fn simforge_render_close(handle: *mut Renderer) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}
