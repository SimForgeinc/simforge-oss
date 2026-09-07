//! The service's local client endpoint (`--socket`).
//!
//! The wire format above this module is identical everywhere: u32-LE
//! length-prefixed msgpack frames (`proto`). What differs per OS is the
//! byte stream carrying them:
//!
//! * Unix: a stream Unix-domain socket bound at the given filesystem path
//!   (`std::os::unix::net`). Node connects with `net.connect(path)`.
//! * Windows: a local named pipe. `--socket` names the pipe endpoint,
//!   `\\.\pipe\<name>` (or `\\?\pipe\<name>`); Node connects with
//!   `net.connect('\\\\.\\pipe\\<name>')`. The pipe is created in byte mode
//!   with `PIPE_REJECT_REMOTE_CLIENTS` and a protected DACL that grants
//!   access only to the SID of the user the service runs as, so another
//!   local account cannot attach to a session's renderer. The name is
//!   claimed with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so a process that already
//!   owns the name makes startup fail instead of silently sharing it.
//!
//! Both flavours serve one connection at a time in the order they arrive,
//! which is the env-server `serveSocket` convention the Unix path always
//! had. On Windows the next pipe instance is created as soon as the current
//! one is connected, so the name never lapses while the service is alive.

use anyhow::{Context, Result};
use std::io::{self, Read, Write};

/// Bound endpoint accepting client connections.
pub struct Listener {
    inner: imp::Listener,
    endpoint: String,
}

/// One accepted client connection: the byte stream the framed protocol
/// runs over.
pub struct Connection {
    inner: imp::Connection,
}

impl Listener {
    /// Bind `endpoint` (see the module docs for its per-OS meaning).
    pub fn bind(endpoint: &str) -> Result<Self> {
        let inner = imp::Listener::bind(endpoint)
            .with_context(|| format!("bind {}", describe(endpoint)))?;
        Ok(Self { inner, endpoint: endpoint.to_owned() })
    }

    /// The endpoint as given on the command line.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Block until the next client connects.
    pub fn accept(&mut self) -> Result<Connection> {
        let inner = self
            .inner
            .accept()
            .with_context(|| format!("accept on {}", describe(&self.endpoint)))?;
        Ok(Connection { inner })
    }
}

impl Connection {
    /// The underlying Unix socket, for ancillary-data transfers (`gpu-interop`
    /// descriptor export rides `SCM_RIGHTS` on this stream).
    #[cfg(unix)]
    pub fn unix_stream(&self) -> &std::os::unix::net::UnixStream {
        &self.inner.stream
    }
}

impl Read for Connection {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.inner.read(buf)
    }
}

impl Write for Connection {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.inner.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Human description of an endpoint for logs and errors.
pub fn describe(endpoint: &str) -> String {
    if cfg!(windows) {
        format!("named pipe {endpoint}")
    } else {
        format!("unix socket {endpoint}")
    }
}

#[cfg(unix)]
mod imp {
    use std::io::{self, Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::Path;

    pub struct Listener {
        listener: UnixListener,
    }

    pub struct Connection {
        pub stream: UnixStream,
    }

    impl Listener {
        pub fn bind(endpoint: &str) -> io::Result<Self> {
            let path = Path::new(endpoint);
            // A stale socket file from a previous run of this workspace would
            // make bind fail with EADDRINUSE; nothing can be listening on it
            // once the owning process is gone.
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                Err(err) => return Err(err),
            }
            Ok(Self { listener: UnixListener::bind(path)? })
        }

        pub fn accept(&mut self) -> io::Result<Connection> {
            let (stream, _) = self.listener.accept()?;
            Ok(Connection { stream })
        }
    }

    impl Read for Connection {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.stream.read(buf)
        }
    }

    impl Write for Connection {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.stream.write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.stream.flush()
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::fs::File;
    use std::io::{self, Read, Write};
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use std::ptr;
    use windows_sys::core::PWSTR;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_INSUFFICIENT_BUFFER, ERROR_PIPE_CONNECTED,
        HANDLE, HLOCAL, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FlushFileBuffers, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
        PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// Per-direction pipe buffer; one request or response frame normally
    /// fits, larger ones simply stream through in pieces.
    const PIPE_BUFFER_BYTES: u32 = 1 << 20;

    /// Security descriptor from `ConvertStringSecurityDescriptorToSecurityDescriptorW`,
    /// freed with `LocalFree`.
    struct SecurityDescriptor(PSECURITY_DESCRIPTOR);

    impl SecurityDescriptor {
        /// Protected DACL: full access for exactly one SID, nothing inherited.
        fn for_sid(sid: &str) -> io::Result<Self> {
            let sddl = wide(&format!("D:P(A;;GA;;;{sid})"));
            let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
            // SAFETY: `sddl` is NUL-terminated and outlives the call; the
            // output pointer is valid for writes.
            let ok = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    ptr::null_mut(),
                )
            };
            if ok == 0 || descriptor.is_null() {
                return Err(io::Error::last_os_error());
            }
            Ok(Self(descriptor))
        }
    }

    impl Drop for SecurityDescriptor {
        fn drop(&mut self) {
            // SAFETY: the pointer came from the SDDL conversion, which
            // allocates with LocalAlloc.
            unsafe { LocalFree(self.0 as HLOCAL) };
        }
    }

    /// One created pipe instance (server end), closed on drop.
    struct Instance(HANDLE);

    impl Drop for Instance {
        fn drop(&mut self) {
            // SAFETY: handle from CreateNamedPipeW, closed exactly once.
            unsafe { CloseHandle(self.0) };
        }
    }

    pub struct Listener {
        name: Vec<u16>,
        descriptor: SecurityDescriptor,
        /// Instance waiting for the next client; always present while the
        /// listener lives so the name stays owned by this process.
        pending: Option<Instance>,
    }

    pub struct Connection {
        file: File,
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Validate a `--socket` value as a local named-pipe endpoint.
    fn validate_pipe_name(endpoint: &str) -> io::Result<()> {
        let lower = endpoint.to_ascii_lowercase();
        let rest = lower
            .strip_prefix(r"\\.\pipe\")
            .or_else(|| lower.strip_prefix(r"\\?\pipe\"));
        match rest {
            Some(name) if !name.is_empty() && !name.contains('\\') => Ok(()),
            _ => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "--socket on Windows must be a local named-pipe endpoint \\\\.\\pipe\\<name> \
                     (no further backslashes), got {endpoint:?}"
                ),
            )),
        }
    }

    /// String SID of the user this process runs as.
    fn current_user_sid() -> io::Result<String> {
        let mut token: HANDLE = ptr::null_mut();
        // SAFETY: the pseudo-handle from GetCurrentProcess needs no close;
        // `token` receives a real handle on success.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        struct Token(HANDLE);
        impl Drop for Token {
            fn drop(&mut self) {
                // SAFETY: opened above, closed once.
                unsafe { CloseHandle(self.0) };
            }
        }
        let token = Token(token);

        let mut needed = 0u32;
        // SAFETY: a zero-length query only reports the required size.
        let probe = unsafe { GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut needed) };
        // SAFETY: GetLastError is always safe to call.
        if probe == 0 && unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
            return Err(io::Error::last_os_error());
        }
        if needed == 0 {
            return Err(io::Error::new(io::ErrorKind::Other, "token user query reported no size"));
        }
        // u64 cells keep TOKEN_USER's pointer field aligned.
        let mut buffer = vec![0u64; (needed as usize).div_ceil(std::mem::size_of::<u64>())];
        // SAFETY: the buffer is at least `needed` bytes and suitably aligned.
        let ok = unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: on success the buffer starts with a TOKEN_USER whose SID
        // pointer targets bytes inside the same buffer.
        let user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
        let mut text: PWSTR = ptr::null_mut();
        // SAFETY: valid SID pointer; `text` is LocalAlloc'd on success.
        if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 || text.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: NUL-terminated UTF-16 from the conversion.
        let len = unsafe {
            let mut n = 0usize;
            while *text.add(n) != 0 {
                n += 1;
            }
            n
        };
        // SAFETY: `len` characters are initialised before the terminator.
        let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
        // SAFETY: allocated by ConvertSidToStringSidW.
        unsafe { LocalFree(text as HLOCAL) };
        Ok(sid)
    }

    impl Listener {
        pub fn bind(endpoint: &str) -> io::Result<Self> {
            validate_pipe_name(endpoint)?;
            let descriptor = SecurityDescriptor::for_sid(&current_user_sid()?)?;
            let mut listener = Self { name: wide(endpoint), descriptor, pending: None };
            let first = listener.create_instance(true)?;
            listener.pending = Some(first);
            Ok(listener)
        }

        fn create_instance(&self, first: bool) -> io::Result<Instance> {
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: self.descriptor.0,
                bInheritHandle: 0,
            };
            let mut open_mode = PIPE_ACCESS_DUPLEX;
            if first {
                open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
            }
            // SAFETY: the name is NUL-terminated and the attributes struct
            // (and the descriptor it points at) outlive the call.
            let handle = unsafe {
                CreateNamedPipeW(
                    self.name.as_ptr(),
                    open_mode,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    PIPE_UNLIMITED_INSTANCES,
                    PIPE_BUFFER_BYTES,
                    PIPE_BUFFER_BYTES,
                    0,
                    &attributes,
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                let err = io::Error::last_os_error();
                return Err(if first {
                    io::Error::new(
                        err.kind(),
                        format!("cannot claim the pipe name (another process may already own it): {err}"),
                    )
                } else {
                    err
                });
            }
            Ok(Instance(handle))
        }

        pub fn accept(&mut self) -> io::Result<Connection> {
            let instance = match self.pending.take() {
                Some(instance) => instance,
                None => self.create_instance(false)?,
            };
            // SAFETY: valid server-end pipe handle; synchronous (no OVERLAPPED).
            let ok = unsafe { ConnectNamedPipe(instance.0, ptr::null_mut()) };
            // SAFETY: GetLastError is always safe to call.
            if ok == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED {
                return Err(io::Error::last_os_error());
            }
            // Keep the name owned while this connection is served; the next
            // client queues on the fresh instance until we get back here.
            self.pending = Some(self.create_instance(false)?);
            let handle = instance.0;
            std::mem::forget(instance);
            // SAFETY: ownership of the connected handle moves into the File,
            // which closes it on drop (after Connection disconnects it).
            let file = unsafe { File::from_raw_handle(handle as _) };
            Ok(Connection { file })
        }
    }

    impl Read for Connection {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            // std maps ERROR_BROKEN_PIPE on ReadFile to Ok(0): client hangup
            // is EOF, as on the Unix socket.
            self.file.read(buf)
        }
    }

    impl Write for Connection {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.file.write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.file.flush()
        }
    }

    impl Drop for Connection {
        fn drop(&mut self) {
            // Let the client drain the last response before the instance is
            // detached; File's drop then closes the handle.
            let handle = self.file.as_raw_handle() as HANDLE;
            // SAFETY: the File still owns a valid server-end pipe handle.
            unsafe {
                FlushFileBuffers(handle);
                DisconnectNamedPipe(handle);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn pipe_names_must_be_local_pipe_endpoints() {
            assert!(validate_pipe_name(r"\\.\pipe\simforge-render-1").is_ok());
            assert!(validate_pipe_name(r"\\?\PIPE\simforge-render-1").is_ok());
            assert!(validate_pipe_name(r"C:\jobs\render.sock").is_err());
            assert!(validate_pipe_name(r"\\.\pipe\").is_err());
            assert!(validate_pipe_name(r"\\server\pipe\x").is_err());
        }

        #[test]
        fn current_user_dacl_builds() {
            let sid = current_user_sid().unwrap();
            assert!(sid.starts_with("S-1-"), "{sid}");
            SecurityDescriptor::for_sid(&sid).unwrap();
        }
    }
}
