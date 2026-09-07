//! Windows implementation; see the table in `platform/mod.rs`.
//!
//! Termination requests: Windows has no SIGTERM. A runner process publishes a
//! manual-reset named event `Local\SimForgeRunner.Terminate.<pid>`; anyone in
//! the same session who observed that pid holding an owner lock signals it
//! ([`request_termination`]) and the runner's waiter thread marks
//! termination. Provider children are created in their own process group and
//! asked to stop with `CTRL_BREAK_EVENT` ([`request_child_termination`]),
//! which Python surfaces as `signal.SIGBREAK`.

use std::fs::{self, File, OpenOptions};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};

use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_LOCK_VIOLATION, FALSE, GENERIC_WRITE, HANDLE, TRUE, WAIT_OBJECT_0,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, LockFileEx, MoveFileExW, UnlockFileEx, FILE_FLAG_BACKUP_SEMANTICS,
    LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, MOVEFILE_REPLACE_EXISTING,
    MOVEFILE_WRITE_THROUGH,
};
use windows_sys::Win32::System::Console::{
    GenerateConsoleCtrlEvent, SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT,
    CTRL_C_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT,
};
use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows_sys::Win32::System::Threading::{
    CreateEventW, OpenEventW, SetEvent, WaitForSingleObject, CREATE_NEW_PROCESS_GROUP,
    CREATE_NO_WINDOW, EVENT_MODIFY_STATE, INFINITE,
};
use windows_sys::Win32::System::IO::OVERLAPPED;

/// Name of the termination request in error messages.
pub const TERMINATION_REQUEST: &str = "CTRL_BREAK";

/// Byte locked to represent ownership. It lies far past any owner record so
/// the record stays readable by other processes while the lock is held.
pub const LOCK_BYTE_OFFSET: u64 = 0x7FFF_FFFF_FFFF_FFF0;

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

fn wide_str(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn check(status: BOOL) -> std::io::Result<()> {
    if status != FALSE {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn lock_range() -> OVERLAPPED {
    // SAFETY: OVERLAPPED is plain data; all-zero is a valid value.
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    overlapped.Anonymous.Anonymous.Offset = LOCK_BYTE_OFFSET as u32;
    overlapped.Anonymous.Anonymous.OffsetHigh = (LOCK_BYTE_OFFSET >> 32) as u32;
    overlapped
}

/// `Ok(true)` when this process now holds the exclusive lock, `Ok(false)`
/// when another process holds it. Byte-range locks are released by the
/// kernel when the owning process ends.
pub fn try_lock_exclusive(file: &File) -> std::io::Result<bool> {
    let mut overlapped = lock_range();
    // SAFETY: `file` is an open handle for the duration of the call and
    // `overlapped` outlives it; the lock is synchronous (FAIL_IMMEDIATELY).
    let status = unsafe {
        LockFileEx(
            file.as_raw_handle() as HANDLE,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            &mut overlapped,
        )
    };
    if status != FALSE {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_LOCK_VIOLATION as i32) {
        Ok(false)
    } else {
        Err(error)
    }
}

pub fn unlock(file: &File) -> std::io::Result<()> {
    let mut overlapped = lock_range();
    // SAFETY: same handle and range as `try_lock_exclusive`.
    check(unsafe { UnlockFileEx(file.as_raw_handle() as HANDLE, 0, 1, 0, &mut overlapped) })
}

/// Runs the child in its own process group without a visible console window,
/// so it is not addressed by the launcher's console events and survives the
/// launching UI or terminal going away.
pub fn detach_command(command: &mut Command) {
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

/// Provider children get their own process group so `CTRL_BREAK_EVENT` can be
/// addressed to exactly that child.
pub fn prepare_terminable_child(command: &mut Command) {
    command.creation_flags(CREATE_NEW_PROCESS_GROUP);
}

fn termination_event_name(pid: u32) -> Vec<u16> {
    wide_str(&format!("Local\\SimForgeRunner.Terminate.{pid}"))
}

/// Asks the runner process `pid` to stop at its next safe boundary by
/// signalling its termination event. Fails when `pid` is not a runner in
/// this session (no such event).
pub fn request_termination(pid: u32) -> std::io::Result<()> {
    let name = termination_event_name(pid);
    // SAFETY: `name` is a NUL-terminated UTF-16 string; the returned handle is
    // closed below.
    let handle = unsafe { OpenEventW(EVENT_MODIFY_STATE, FALSE, name.as_ptr()) };
    if handle.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let result = check(unsafe { SetEvent(handle) });
    unsafe {
        CloseHandle(handle);
    }
    result
}

/// Asks a provider child spawned with [`prepare_terminable_child`] to
/// checkpoint and exit 130. Requires that this process has a console (the
/// child inherited it); without one the request cannot be delivered and the
/// caller must fall back to killing the child.
pub fn request_child_termination(child: &Child) -> std::io::Result<()> {
    // SAFETY: plain Win32 call with a process-group id we created.
    check(unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, child.id()) })
}

static TERMINATED: AtomicBool = AtomicBool::new(false);

unsafe extern "system" fn on_console_event(event: u32) -> BOOL {
    match event {
        CTRL_C_EVENT | CTRL_BREAK_EVENT | CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT
        | CTRL_SHUTDOWN_EVENT => {
            TERMINATED.store(true, Ordering::SeqCst);
            TRUE
        }
        _ => FALSE,
    }
}

/// Installs the console control handler and publishes this process's
/// termination event, served by a waiter thread. Idempotent; the result of
/// the first call is what every later call reports.
pub fn install_termination_handlers() -> std::io::Result<()> {
    static INSTALLED: std::sync::OnceLock<std::io::Result<()>> = std::sync::OnceLock::new();
    match INSTALLED.get_or_init(install_once) {
        Ok(()) => Ok(()),
        Err(error) => Err(std::io::Error::new(error.kind(), error.to_string())),
    }
}

fn install_once() -> std::io::Result<()> {
    // SAFETY: the handler only stores to an atomic.
    check(unsafe { SetConsoleCtrlHandler(Some(on_console_event), TRUE) })?;
    let name = termination_event_name(std::process::id());
    // SAFETY: NUL-terminated name; manual-reset, initially unsignalled event
    // owned by the waiter thread for the life of the process.
    let handle = unsafe { CreateEventW(std::ptr::null(), TRUE, FALSE, name.as_ptr()) };
    if handle.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    let raw = handle as usize;
    std::thread::Builder::new()
        .name("simforge-runner-terminate".into())
        .spawn(move || {
            // SAFETY: the handle stays open until process exit.
            if unsafe { WaitForSingleObject(raw as HANDLE, INFINITE) } == WAIT_OBJECT_0 {
                TERMINATED.store(true, Ordering::SeqCst);
            }
        })?;
    Ok(())
}

/// Whether a termination request has been delivered to this process.
pub fn termination_requested() -> bool {
    TERMINATED.load(Ordering::SeqCst)
}

/// Sets `FILE_ATTRIBUTE_READONLY` on a published file.
pub fn set_read_only(path: &Path) -> std::io::Result<()> {
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions)
}

fn clear_read_only(path: &Path) -> std::io::Result<bool> {
    let mut permissions = fs::metadata(path)?.permissions();
    if !permissions.readonly() {
        return Ok(false);
    }
    permissions.set_readonly(false);
    fs::set_permissions(path, permissions)?;
    Ok(true)
}

/// Removes a file even when it carries the read-only attribute, which
/// `DeleteFileW` otherwise refuses.
pub fn remove_file_force(path: &Path) -> std::io::Result<()> {
    clear_read_only(path)?;
    fs::remove_file(path)
}

/// Flushes a file's data and metadata. `FlushFileBuffers` needs a writable
/// handle, so a read-only file is made writable for the flush and restored.
pub fn sync_file(path: &Path) -> std::io::Result<()> {
    let was_read_only = clear_read_only(path)?;
    let result = OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all());
    if was_read_only {
        set_read_only(path)?;
    }
    result
}

/// Flushes a directory's metadata (its index and file records) so a rename
/// or link that completed inside it is on disk. Directory handles need
/// `FILE_FLAG_BACKUP_SEMANTICS`; the flush needs write access.
pub fn sync_dir(dir: &Path) -> std::io::Result<()> {
    OpenOptions::new()
        .access_mode(GENERIC_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(dir)?
        .sync_all()
}

fn move_file(from: &Path, to: &Path, flags: u32) -> std::io::Result<()> {
    let from = wide(from);
    let to = wide(to);
    // SAFETY: both are NUL-terminated UTF-16 paths.
    check(unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) })
}

/// Atomically replaces the file `to` with `from`, written through to disk
/// before returning.
pub fn rename_file_replace(from: &Path, to: &Path) -> std::io::Result<()> {
    move_file(from, to, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)
}

/// Renames the directory `from` to `to`; fails with `AlreadyExists` if `to`
/// is present (`MOVEFILE_REPLACE_EXISTING` is not valid for directories).
pub fn rename_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    move_file(from, to, MOVEFILE_WRITE_THROUGH)
}

/// Moves `temp` to `target`, failing with `AlreadyExists` if `target` is
/// present: a rename without `REPLACE_EXISTING` is the exclusive publication
/// primitive here, so two racing publishers cannot both win. Unlike the Unix
/// `link(2)` variant this consumes `temp`; callers tolerate its absence.
pub fn publish_file_exclusive(temp: &Path, target: &Path) -> std::io::Result<()> {
    move_file(temp, target, MOVEFILE_WRITE_THROUGH)
}

pub fn physical_memory_bytes() -> u64 {
    // SAFETY: MEMORYSTATUSEX is plain data; dwLength tells the kernel the size.
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut status) } == FALSE {
        return 0;
    }
    status.ullTotalPhys
}

/// Bytes available to this user on the volume holding `dir`.
pub fn free_bytes(dir: &Path) -> u64 {
    let path = wide(dir);
    let mut available: u64 = 0;
    let mut total: u64 = 0;
    let mut free: u64 = 0;
    // SAFETY: NUL-terminated path and three valid out-pointers.
    let status = unsafe {
        GetDiskFreeSpaceExW(path.as_ptr(), &mut available, &mut total, &mut free)
    };
    if status == FALSE {
        return 0;
    }
    available
}

/// Default writable worker state when no root is configured:
/// `%LOCALAPPDATA%\simforge\native-runtime-state`. `None` when the variable
/// is unavailable.
pub fn default_state_root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(|base| {
            PathBuf::from(base)
                .join("simforge")
                .join("native-runtime-state")
        })
}

/// Environment variables consulted by [`default_state_root`], for messages.
pub const STATE_ROOT_ENV_HINT: &str = "LOCALAPPDATA";
