#!/usr/bin/env python3
"""Fail-closed Linux geometry-worker confinement; not a VM/native-parser sandbox."""
import ctypes
import errno
import os
import platform
import resource
from pathlib import Path

libc = ctypes.CDLL(None, use_errno=True)

class Ruleset(ctypes.Structure):
    _fields_ = [('handled_access_fs', ctypes.c_uint64)]

class PathRule(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int)]

class ArgumentComparison(ctypes.Structure):
    _fields_ = [('arg', ctypes.c_uint), ('op', ctypes.c_int),
                ('datum_a', ctypes.c_uint64), ('datum_b', ctypes.c_uint64)]

def syscall(number, *args):
    result = libc.syscall(ctypes.c_long(number), *args)
    if result < 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return result

def confine(read_paths, output, cpu_seconds=90, memory_bytes=16 * 1024**3):
    if platform.machine() != 'x86_64':
        raise RuntimeError('Worker confinement currently requires Linux x86_64')
    abi = syscall(444, ctypes.c_void_p(), ctypes.c_size_t(0), ctypes.c_uint(1))
    if abi < 3:
        raise RuntimeError('Landlock ABI >= 3 required (read, write, refer and truncate control)')
    # All filesystem operations through ABI 3. Device creation is never granted.
    handled = (1 << 15) - 1
    ruleset = Ruleset(handled)
    fd = syscall(444, ctypes.byref(ruleset), ctypes.sizeof(ruleset), 0)
    def allow(path, access):
        path = Path(path).resolve(strict=True)
        entry = os.open(path, os.O_PATH | os.O_CLOEXEC)
        try:
            if not path.is_dir():
                access &= (1 << 0) | (1 << 1) | (1 << 2) | (1 << 14)
            rule = PathRule(access, entry)
            syscall(445, fd, 1, ctypes.byref(rule), 0)
        finally:
            os.close(entry)
    try:
        for path in read_paths:
            allow(path, (1 << 0) | (1 << 2) | (1 << 3))
        allow(output, (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 7) | (1 << 8) | (1 << 14))
        if libc.prctl(38, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), 'PR_SET_NO_NEW_PRIVS failed')
        syscall(446, fd, 0)
    finally:
        os.close(fd)
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
    resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    resource.setrlimit(resource.RLIMIT_FSIZE, (2 * 1024**3, 2 * 1024**3))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    return abi

def deny_authority():
    seccomp = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    seccomp.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int,
                                             ctypes.c_uint, ctypes.POINTER(ArgumentComparison)]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_attr_set.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_uint32]
    # Blender lazily creates geometry worker threads. Permit only threads sharing
    # this process and its inherited filters, not new processes or authority.
    deny = '''socket socketpair connect bind listen accept accept4 sendto sendmsg sendmmsg recvfrom recvmsg recvmmsg shutdown
        fork vfork execve execveat ptrace process_vm_readv process_vm_writev kill tkill pidfd_open pidfd_getfd pidfd_send_signal
        rt_sigqueueinfo rt_tgsigqueueinfo prlimit64 setpriority sched_setaffinity sched_setscheduler sched_setparam
        shmget shmat shmdt shmctl semget semop semtimedop semctl msgget msgsnd msgrcv msgctl
        mq_open mq_unlink mq_timedsend mq_timedreceive mq_notify mq_getsetattr
        inotify_init inotify_init1 inotify_add_watch fanotify_init fanotify_mark
        chmod fchmod fchmodat fchmodat2 chown fchown lchown fchownat utime utimes futimesat utimensat
        setxattr lsetxattr fsetxattr removexattr lremovexattr fremovexattr getxattr lgetxattr fgetxattr listxattr llistxattr flistxattr readlink readlinkat
        mount umount2 pivot_root chroot unshare setns open_by_handle_at name_to_handle_at bpf perf_event_open userfaultfd
        io_uring_setup io_uring_enter io_uring_register kexec_load kexec_file_load init_module finit_module delete_module
        reboot swapon swapoff keyctl add_key request_key personality prctl seccomp ioctl fcntl flock'''.split()
    context = seccomp.seccomp_init(0x7fff0000)
    if not context:
        raise RuntimeError('seccomp_init failed')
    try:
        if seccomp.seccomp_attr_set(context, 4, 1) != 0:
            raise RuntimeError('seccomp TSYNC unavailable')
        for name in deny:
            number = seccomp.seccomp_syscall_resolve_name(name.encode())
            if number >= 0 and seccomp.seccomp_rule_add(context, 0x00050000 | errno.EPERM, number, 0) != 0:
                raise RuntimeError('Cannot deny syscall ' + name)
        # clone3 hides flags behind a pointer; ENOSYS makes libc use filterable
        # clone instead. CLONE_THREAD is mandatory; the kernel also requires
        # CLONE_VM/CLONE_SIGHAND. tgkill may address only this process's threads.
        for name, error, comparison in (
            ('clone', errno.EPERM, ArgumentComparison(0, 7, 0x10000, 0)),
            ('clone3', errno.ENOSYS, None),
            ('tgkill', errno.EPERM, ArgumentComparison(0, 1, os.getpid(), 0)),
        ):
            number = seccomp.seccomp_syscall_resolve_name(name.encode())
            if number < 0 or seccomp.seccomp_rule_add_array(
                    context, 0x00050000 | error, number, 0 if comparison is None else 1,
                    None if comparison is None else ctypes.byref(comparison)) != 0:
                raise RuntimeError('Cannot constrain syscall ' + name)
        if seccomp.seccomp_load(context) != 0:
            raise RuntimeError('Cannot install seccomp filter')
    finally:
        seccomp.seccomp_release(context)

if __name__ == '__main__':
    import json
    import sys
    request = json.loads(Path(sys.argv[1]).read_text())
    confine(request['readPaths'], request['output'], request['cpuSeconds'], request['memoryBytes'])
    os.execv(request['command'][0], request['command'])
