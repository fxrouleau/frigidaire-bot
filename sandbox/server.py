#!/usr/bin/env python3
"""Code-execution sidecar for Frigidaire Bot (Python stdlib only).

The bot's `run_code` tool POSTs snippets here instead of running them in its own container, which holds
the Discord token and the OpenRouter key. This container holds no secrets, so a prompt-injected snippet
can burn CPU or scribble in /workspace but has nothing worth stealing.

    POST /run     {"language": "python"|"bash"|"node", "code": "...", "timeout_seconds": 20,
                   "reset_workspace": false}
               -> {"stdout", "stderr", "exit_code", "signal", "timed_out", "duration_ms",
                   "stdout_truncated", "stderr_truncated", "files", "files_omitted", "workspace_reset"}
    GET  /health  -> {"ok", "busy", "queued", "workspace_writable", "languages"}

Each run executes as this server's own unprivileged user in the workspace, in a fresh session/process
group with rlimits (CPU, data segment, file size, process count, open files) applied by a tiny exec
launcher. Everything the run started is SIGKILLed when it ends: the process group first, then any
descendant that escaped it with setsid() (this server is a child subreaper, so orphans reparent to it
rather than to PID 1 and can be found). Files the run wrote to <workspace>/out/ are returned base64
encoded; that directory is emptied before every run. Runs are serialized behind one lock with a short
waiting queue; the container is sized for one run at a time.

A run can't start runs of its own: /run refuses clients on this machine (loopback or the container's own
addresses; the bot always connects from its own container), and a queued request whose client has hung up
is dropped when its turn comes. Otherwise a run could POST its own code back before it is killed and keep
itself going forever. The bearer token alone is not relied on for that: runs share this server's uid.

Everything else in the workspace persists between runs on purpose (saved files, `pip install --user`,
`npm install`), so one run can leave things behind for the next, within a size and file-count limit: the
workspace is a volume on the host's disk, and filling that disk would take the bot's databases down with
it. A run that pushes the workspace over the limit is killed, and a workspace found over it after a run is
wiped (see WorkspaceQuota).

What a run leaves behind must not change how the *tools* behave in later runs: Python runs with -P and
without the workspace on sys.path (a planted json.py can't shadow the stdlib), the workspace's bin
directories come after the system ones on PATH (a planted `jq` can't shadow /usr/bin/jq), node's builtins
can't be shadowed by design and its package lookups are pinned to the run's own directory (see
prepare_run_dir). Installed packages themselves are trusted
until a run asks for "reset_workspace": true, which starts it on an empty workspace.

Environment (all optional):
    SANDBOX_TOKEN            bearer token required on /run (unset => no auth; keep the port private)
    SANDBOX_HOST / _PORT     bind address (default 0.0.0.0:8080; port 0 picks a free port). Bound to a
                             loopback address (local development, tests), local clients are allowed.
    SANDBOX_WORKSPACE        working directory and HOME for runs (default /workspace)
    SANDBOX_MEMORY_MB        per-process RLIMIT_DATA (default 768)
    SANDBOX_FILE_SIZE_MB     per-file RLIMIT_FSIZE (default 100)
    SANDBOX_WORKSPACE_MAX_MB     disk the whole workspace may use (default 2048)
    SANDBOX_WORKSPACE_MAX_FILES  files and directories the workspace may hold (default 200000)
    SANDBOX_MAX_PROCESSES    RLIMIT_NPROC for the run's user (default 128)
    SANDBOX_QUEUE_SIZE       runs allowed to wait for the lock (default 3)
    SANDBOX_QUEUE_WAIT_SECONDS  how long a queued run waits before giving up (default 30)
"""

from __future__ import annotations

import base64
import contextlib
import ctypes
import hmac
import ipaddress
import json
import logging
import math
import os
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

log = logging.getLogger('sandbox')

DEFAULT_TIMEOUT_SECONDS = 20
MAX_TIMEOUT_SECONDS = 60
MAX_BODY_BYTES = 1024 * 1024
MAX_CODE_BYTES = 256 * 1024
# Output kept per stream. The head carries most of the signal; a short tail keeps the last lines (a final
# answer after a long loop, the exception at the end of a traceback) when a run is chatty.
OUTPUT_HEAD_BYTES = 12 * 1024
OUTPUT_TAIL_BYTES = 4 * 1024
MAX_OUT_FILES = 5
MAX_OUT_BYTES = 8 * 1024 * 1024
# How long to wait for the output pipes to drain after every process of the run is gone.
READER_JOIN_SECONDS = 2.0

# -P (3.11+): don't put the script's directory (or, for -c/-m, the cwd) first on sys.path. The script sits
# in a fresh temp dir so that alone is harmless, but the flag documents the rule: nothing a run can write is
# searched before the stdlib. PYTHONSAFEPATH (child_env) extends it to Python processes the run starts itself.
PYTHON_SAFE_PATH = ['-P'] if sys.version_info >= (3, 11) else []

# The run directory's package.json (see prepare_run_dir) has no "type" on purpose, so node detects ESM vs
# CommonJS per file; node then warns on stderr about every ESM file, which the model would read as a problem.
NODE_FLAGS = ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON']

LANGUAGES: dict[str, tuple[list[str], str]] = {
    'python': ([sys.executable, *PYTHON_SAFE_PATH], 'main.py'),
    'bash': (['bash'], 'main.sh'),
    'node': (['node', *NODE_FLAGS], 'main.js'),
}

# Environment variables a run may inherit from the server. Everything else (notably SANDBOX_TOKEN, and
# anything an operator mistakenly passes in) never reaches user code; the server's own environment is
# sealed by harden_self(). Nothing relies on the token staying unknown to runs, though (see is_local_client).
PASSTHROUGH_ENV = (
    'PATH',
    'LANG',
    'LC_ALL',
    'TZ',
    'OPENBLAS_NUM_THREADS',
    'OMP_NUM_THREADS',
    'MKL_NUM_THREADS',
    'NUMEXPR_NUM_THREADS',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
)

# Runs inside the child right before exec: applies the rlimits, then replaces itself with the real
# interpreter. A separate launcher instead of subprocess's preexec_fn because preexec_fn is unsafe in a
# threaded server (the forked child can deadlock on a lock another thread held at fork time).
# RLIMIT_DATA is per process, so a run that forks can still fill the container's memory cap; the maximum
# OOM score (raising it needs no privilege, and children inherit it) makes the kernel kill the run then,
# not this server.
LAUNCHER = r"""
import os, resource, sys
try:
    with open('/proc/self/oom_score_adj', 'w') as handle:
        handle.write('1000')
except OSError:
    pass
spec = sys.argv[1]
for item in spec.split(','):
    name, value = item.split('=')
    res = getattr(resource, name)
    want = int(value)
    soft, hard = resource.getrlimit(res)
    if hard != resource.RLIM_INFINITY:
        want = min(want, hard)
    extra = 2 if name == 'RLIMIT_CPU' else 0
    new_hard = want + extra
    if hard != resource.RLIM_INFINITY:
        new_hard = min(new_hard, hard)
    resource.setrlimit(res, (want, new_hard))
os.execvp(sys.argv[2], sys.argv[2:])
"""


def env_int(name: str, fallback: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, '').strip()
    if not raw:
        return fallback
    try:
        value = int(raw)
    except ValueError:
        return fallback
    return value if minimum <= value <= maximum else fallback


class Settings:
    def __init__(self) -> None:
        self.token = os.environ.get('SANDBOX_TOKEN', '').strip() or None
        self.host = os.environ.get('SANDBOX_HOST', '').strip() or '0.0.0.0'
        self.port = env_int('SANDBOX_PORT', 8080, 0, 65535)
        self.workspace = os.path.abspath(os.environ.get('SANDBOX_WORKSPACE', '').strip() or '/workspace')
        self.memory_bytes = env_int('SANDBOX_MEMORY_MB', 768, 64, 65536) * 1024 * 1024
        self.file_size_bytes = env_int('SANDBOX_FILE_SIZE_MB', 100, 1, 65536) * 1024 * 1024
        self.workspace_max_bytes = env_int('SANDBOX_WORKSPACE_MAX_MB', 2048, 16, 1_048_576) * 1024 * 1024
        self.workspace_max_files = env_int('SANDBOX_WORKSPACE_MAX_FILES', 200_000, 100, 100_000_000)
        self.max_processes = env_int('SANDBOX_MAX_PROCESSES', 128, 8, 1_000_000)
        self.queue_size = env_int('SANDBOX_QUEUE_SIZE', 3, 0, 100)
        self.queue_wait_seconds = env_int('SANDBOX_QUEUE_WAIT_SECONDS', 30, 1, 600)
        # A server bound to loopback can only ever be reached from this machine (local development, the
        # bot's test suite): there, local clients are the legitimate ones.
        self.allow_local_clients = _is_loopback_host(self.host)

    @property
    def out_dir(self) -> str:
        return os.path.join(self.workspace, 'out')


def _is_loopback_host(host: str) -> bool:
    if host.lower() == 'localhost':
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


# ---- who is calling ---------------------------------------------------------------------------------


def is_local_client(client_address: tuple[Any, ...]) -> bool:
    """True when the peer address belongs to this machine: loopback, or any address this host can bind.

    Runs share the server's network namespace, so every connection a run makes to this server comes from
    one of these (127.0.0.1, or the container's own address when it dials that); the bot's never does.
    The bind probe covers every local interface without having to list them.
    """
    host = str(client_address[0]).split('%', 1)[0]
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    if address.is_loopback or address.is_unspecified:
        return True
    try:
        if isinstance(address, ipaddress.IPv6Address):
            scope = client_address[3] if len(client_address) > 3 else 0
            with socket.socket(socket.AF_INET6, socket.SOCK_STREAM) as probe:
                probe.bind((str(address), 0, 0, scope))
        else:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                probe.bind((str(address), 0))
    except OSError:
        return False
    return True


# The most a client may have sent past its request body; a real client sends nothing more.
_MAX_TRAILING_BYTES = 64 * 1024


def client_disconnected(connection: socket.socket) -> bool:
    """True when the client has closed or reset the connection (checked without blocking).

    Anything still unread (bytes past the request body) is drained first, since a client that sent extra
    bytes and then died would otherwise look alive. HTTP/1.0: nothing more is read from the connection.
    """
    previous = connection.gettimeout()
    drained = 0
    try:
        connection.setblocking(False)
        while drained <= _MAX_TRAILING_BYTES:
            chunk = connection.recv(8192)
            if not chunk:
                return True
            drained += len(chunk)
        return True
    except (BlockingIOError, InterruptedError):
        return False
    except OSError:
        return True
    finally:
        with contextlib.suppress(OSError):
            connection.settimeout(previous)


# ---- process hygiene --------------------------------------------------------------------------------

_PR_SET_DUMPABLE = 4
_PR_SET_CHILD_SUBREAPER = 36


def _prctl(option: int, value: int) -> bool:
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        result: int = libc.prctl(option, value, 0, 0, 0)
        return result == 0
    except (OSError, AttributeError):
        return False


def harden_self() -> None:
    """Linux-only protections for the server process itself (no-ops elsewhere).

    Runs execute as the same uid as this server (the container drops every capability, so there is no
    second user to switch to). Non-dumpable keeps user code from reading this process's memory or
    /proc/<pid>/environ (where SANDBOX_TOKEN lives) and from ptrace-attaching to it. The container starts
    this server as PID 1 (no init in front of it), which also makes it immune to a run's `kill -STOP` or
    `kill -9`: the kernel never delivers those to a PID namespace's init from inside the namespace.
    Subreaper makes orphaned descendants of a run reparent here (when the server is not PID 1, e.g. in
    tests), which is what lets the post-run sweep find processes that escaped the run's process group.
    """
    if not sys.platform.startswith('linux'):
        return
    if not _prctl(_PR_SET_DUMPABLE, 0):
        log.warning('could not mark the server non-dumpable')
    if not _prctl(_PR_SET_CHILD_SUBREAPER, 1):
        log.warning('could not become a child subreaper; escaped background processes may survive a run')


def _process_table() -> dict[int, tuple[int, str]]:
    """pid -> (ppid, state letter) for every visible process (empty when /proc is unavailable)."""
    table: dict[int, tuple[int, str]] = {}
    try:
        entries = os.listdir('/proc')
    except OSError:
        return table
    for entry in entries:
        if not entry.isdigit():
            continue
        try:
            with open(f'/proc/{entry}/stat', 'rb') as handle:
                raw = handle.read()
        except OSError:
            continue
        # The command name is wrapped in parentheses and may itself contain spaces or ')'.
        fields = raw[raw.rfind(b')') + 2 :].split()
        if len(fields) >= 2:
            table[int(entry)] = (int(fields[1]), fields[0].decode('ascii', errors='replace'))
    return table


def _descendants(root: int) -> dict[int, str]:
    """pid -> state letter for every descendant of `root` ('Z' = exited, waiting to be reaped)."""
    table = _process_table()
    children: dict[int, list[int]] = {}
    for pid, (ppid, _state) in table.items():
        children.setdefault(ppid, []).append(pid)
    found: dict[int, str] = {}
    stack = list(children.get(root, []))
    while stack:
        pid = stack.pop()
        found[pid] = table[pid][1]
        stack.extend(children.get(pid, []))
    return found


def _reap_children() -> None:
    """Collects the exit statuses of every child that has exited (orphans reparent here: subreaper).

    Only safe once the run's own Popen child has been waited for: reaping it here would lose its exit code.
    Runs are serialized, so at that point every child of this server belongs to the finished run.
    """
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def kill_process_group(pgid: int) -> None:
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(pgid, signal.SIGKILL)


def sweep_descendants(deadline_seconds: float = 2.0) -> int:
    """SIGKILLs and reaps every remaining descendant of this server; returns how many were still alive.

    This catches what the process-group kill cannot: a background job that called setsid() (or
    `setsid`, `nohup … &` with a new group) to outlive the run. Loops because a dying process's own
    children reparent here in turn, and because a fork loop can race a single pass.
    """
    me = os.getpid()
    alive: set[int] = set()
    deadline = time.monotonic() + deadline_seconds
    while True:
        leftovers = _descendants(me)
        if not leftovers:
            break
        alive.update(pid for pid, state in leftovers.items() if state != 'Z')
        for pid in leftovers:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.kill(pid, signal.SIGKILL)
        _reap_children()
        if time.monotonic() >= deadline:
            log.warning('%d process(es) from the last run survived SIGKILL', len(_descendants(me)))
            break
        time.sleep(0.01)
    _reap_children()
    return len(alive)


# ---- output capture ---------------------------------------------------------------------------------


class CappedReader(threading.Thread):
    """Drains one pipe to EOF, keeping the first OUTPUT_HEAD_BYTES and the last OUTPUT_TAIL_BYTES.

    Draining past the cap matters: a child blocked on a full pipe would otherwise hang until the timeout.
    """

    def __init__(self, fd: int) -> None:
        super().__init__(daemon=True)
        self.fd = fd
        self.head = bytearray()
        self.tail = bytearray()
        self.total = 0

    def run(self) -> None:
        try:
            while True:
                chunk = os.read(self.fd, 65536)
                if not chunk:
                    break
                self.total += len(chunk)
                room = OUTPUT_HEAD_BYTES - len(self.head)
                if room > 0:
                    self.head += chunk[:room]
                    chunk = chunk[room:]
                if chunk:
                    self.tail += chunk
                    if len(self.tail) > OUTPUT_TAIL_BYTES:
                        del self.tail[: len(self.tail) - OUTPUT_TAIL_BYTES]
        except OSError:
            pass
        finally:
            with contextlib.suppress(OSError):
                os.close(self.fd)

    @property
    def truncated(self) -> bool:
        return self.total > len(self.head) + len(self.tail)

    def text(self) -> str:
        head = self.head.decode('utf-8', errors='replace')
        if not self.tail:
            return head
        tail = self.tail.decode('utf-8', errors='replace')
        omitted = self.total - len(self.head) - len(self.tail)
        if omitted <= 0:
            return head + tail
        return f'{head}\n... [{omitted} bytes omitted] ...\n{tail}'


# ---- workspace files --------------------------------------------------------------------------------


def reset_out_dir(out_dir: str) -> None:
    """Empties <workspace>/out/ (whatever the last run left there, even a symlink, a plain file or a
    read-only directory: a run must not be able to break every later one by `chmod 500 out/x`)."""
    try:
        info = os.lstat(out_dir)
    except FileNotFoundError:
        info = None
    if info is not None:
        if stat.S_ISDIR(info.st_mode):
            remove_tree(out_dir)
        else:
            os.unlink(out_dir)
    os.mkdir(out_dir, 0o755)


def collect_out_files(out_dir: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    files: list[dict[str, Any]] = []
    omitted: list[dict[str, Any]] = []
    try:
        entries = sorted(os.scandir(out_dir), key=lambda e: e.name)
    except OSError:
        return files, omitted
    total = 0
    for entry in entries:
        try:
            info = entry.stat(follow_symlinks=False)
        except OSError:
            continue
        if not stat.S_ISREG(info.st_mode):
            omitted.append(
                {
                    'name': entry.name,
                    'size': None,
                    'reason': 'not a regular file (only files directly in out/ are returned)',
                }
            )
            continue
        if len(files) >= MAX_OUT_FILES:
            omitted.append({'name': entry.name, 'size': info.st_size, 'reason': f'more than {MAX_OUT_FILES} files'})
            continue
        if total + info.st_size > MAX_OUT_BYTES:
            omitted.append(
                {
                    'name': entry.name,
                    'size': info.st_size,
                    'reason': f'over the {MAX_OUT_BYTES // (1024 * 1024)} MB total limit',
                }
            )
            continue
        data = _read_regular_file(entry.path, info.st_size)
        if data is None:
            omitted.append({'name': entry.name, 'size': info.st_size, 'reason': 'unreadable'})
            continue
        total += len(data)
        files.append({'name': entry.name, 'size': len(data), 'content_base64': base64.b64encode(data).decode('ascii')})
    return files, omitted


def _read_regular_file(path: str, expected_size: int) -> bytes | None:
    # O_NOFOLLOW/O_NONBLOCK + fstat: never follow a symlink swapped in after the scan, never block on a FIFO.
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        chunks: list[bytes] = []
        remaining = expected_size
        while remaining > 0:
            chunk = os.read(fd, min(remaining, 1024 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b''.join(chunks)
    except OSError:
        return None
    finally:
        os.close(fd)


def _make_owner_writable(path: str) -> None:
    """Gives the owner rwx on a directory (never through a symlink) so its entries can be listed and removed."""
    with contextlib.suppress(OSError):
        info = os.lstat(path)
        if stat.S_ISDIR(info.st_mode) and (info.st_mode & 0o700) != 0o700:
            os.chmod(path, stat.S_IMODE(info.st_mode) | 0o700)


def _make_tree_owner_writable(root: str) -> None:
    """_make_owner_writable on `root` and every directory under it (symlinks are never followed).

    A run may have left read-only or unreadable directories behind; it shares this server's uid, so the
    owner bits can always be put back. os.walk descends only after the chmod, so unreadable ones are walked.
    """
    _make_owner_writable(root)
    for dirpath, dirnames, _files in os.walk(root):
        for name in dirnames:
            _make_owner_writable(os.path.join(dirpath, name))


def remove_tree(path: str) -> None:
    """shutil.rmtree that also removes directories a run made read-only or unreadable."""
    _make_tree_owner_writable(path)
    shutil.rmtree(path)


def wipe_workspace(workspace: str) -> int:
    """Deletes everything inside the workspace (not the directory itself: it is the mounted volume).

    Symlinks are removed, never followed. Returns how many top-level entries were removed; raises OSError
    when something could not be.
    """
    _make_tree_owner_writable(workspace)
    removed = 0
    with os.scandir(workspace) as entries:
        paths = [entry.path for entry in entries]
    for path in paths:
        info = os.lstat(path)
        if stat.S_ISDIR(info.st_mode):
            shutil.rmtree(path)
        else:
            os.unlink(path)
        removed += 1
    return removed


def _make_owner_listable(path: str, info: os.stat_result) -> None:
    """Gives the owner r-x on a directory so its entries can be counted (a run can't hide files from it)."""
    if (info.st_mode & 0o500) != 0o500:
        with contextlib.suppress(OSError):
            os.chmod(path, stat.S_IMODE(info.st_mode) | 0o500)


def workspace_usage(workspace: str, max_bytes: int, max_files: int) -> tuple[int, int]:
    """(allocated bytes, entries) under the workspace. Stops counting as soon as either limit is passed,
    so a run that planted millions of files costs one bounded walk. Symlinks are counted, never followed."""
    total_bytes = 0
    total_files = 0
    stack = [workspace]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    try:
                        info = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    total_files += 1
                    # st_blocks: what the file really occupies (a sparse file costs next to nothing).
                    total_bytes += info.st_blocks * 512
                    if total_bytes > max_bytes or total_files > max_files:
                        return total_bytes, total_files
                    if stat.S_ISDIR(info.st_mode):
                        _make_owner_listable(entry.path, info)
                        stack.append(entry.path)
        except OSError:
            continue
    return total_bytes, total_files


def _filesystem_usage(path: str) -> tuple[int, int]:
    """(bytes, inodes) in use on the filesystem holding `path`; (0, 0) when it can't be read."""
    try:
        info = os.statvfs(path)
    except OSError:
        return 0, 0
    return (info.f_blocks - info.f_bfree) * info.f_frsize, max(0, info.f_files - info.f_ffree)


class WorkspaceQuota:
    """Keeps the workspace under SANDBOX_WORKSPACE_MAX_MB / _MAX_FILES.

    RLIMIT_FSIZE only caps each file, and the workspace is a volume on the host's disk: without this, one
    60 s run (or a few runs in a row) could write tens of GB there and fill the disk the bot's databases
    live on. The exact size comes from walking the workspace after every run. During a run, the
    filesystem's own usage (statvfs, cheap) is polled; only when the last exact size plus that growth
    could be over the limit is the workspace walked again, and the run is killed if it really is.
    """

    POLL_SECONDS = 0.25

    def __init__(self, settings: Settings) -> None:
        self.workspace = settings.workspace
        self.max_bytes = settings.workspace_max_bytes
        self.max_files = settings.workspace_max_files
        self.known_bytes = 0
        self.known_files = 0
        self._baseline = (0, 0)

    @property
    def limit_mb(self) -> int:
        return self.max_bytes // (1024 * 1024)

    def measure(self) -> bool:
        """Walks the workspace; True when it is over a limit."""
        self.known_bytes, self.known_files = workspace_usage(self.workspace, self.max_bytes, self.max_files)
        self._baseline = _filesystem_usage(self.workspace)
        return self.known_bytes > self.max_bytes or self.known_files > self.max_files

    def start_run(self) -> None:
        self._baseline = _filesystem_usage(self.workspace)

    def run_over_limit(self) -> bool:
        """Called while a run is going: True once the workspace is over a limit."""
        used_bytes, used_files = _filesystem_usage(self.workspace)
        grown_bytes = used_bytes - self._baseline[0]
        grown_files = used_files - self._baseline[1]
        if self.known_bytes + grown_bytes <= self.max_bytes and self.known_files + grown_files <= self.max_files:
            return False
        # Maybe the run, maybe something else on the same disk: only the workspace itself counts.
        return self.measure()

    def describe(self) -> str:
        return f'{self.known_bytes // (1024 * 1024)} MB in {self.known_files} entries'


def workspace_writable(settings: Settings) -> bool:
    return os.path.isdir(settings.workspace) and os.access(settings.workspace, os.W_OK | os.X_OK)


# ---- running code -----------------------------------------------------------------------------------


def child_env(settings: Settings, run_dir: str) -> dict[str, str]:
    env = {key: os.environ[key] for key in PASSTHROUGH_ENV if key in os.environ}
    home = settings.workspace
    base_path = env.get('PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')
    env.update(
        {
            'HOME': home,
            'PWD': home,
            'TMPDIR': run_dir,
            # `pip install --user` and `npm install` land in the workspace and persist between runs. Their
            # bin directories come last, so an installed tool is found but can't shadow a system command.
            'PATH': f'{base_path}:{home}/.local/bin:{home}/node_modules/.bin',
            # No PYTHONPATH: the workspace is deliberately not importable by default (see PYTHON_SAFE_PATH).
            'PYTHONSAFEPATH': '1',
            'PYTHONUNBUFFERED': '1',
            'PYTHONDONTWRITEBYTECODE': '1',
            'PYTHONIOENCODING': 'utf-8',
            'PIP_DISABLE_PIP_VERSION_CHECK': '1',
            'PIP_NO_CACHE_DIR': '1',
            'NODE_PATH': f'{home}/node_modules',
            'NPM_CONFIG_UPDATE_NOTIFIER': 'false',
            'NPM_CONFIG_FUND': 'false',
            'MPLBACKEND': 'Agg',
            'NO_COLOR': '1',
            'TERM': 'dumb',
        }
    )
    env.setdefault('LANG', 'C.UTF-8')
    env.setdefault('TZ', 'America/New_York')
    return env


def rlimit_spec(settings: Settings, timeout_seconds: float) -> str:
    limits = {
        'RLIMIT_CPU': math.ceil(timeout_seconds) + 1,
        'RLIMIT_DATA': settings.memory_bytes,
        'RLIMIT_FSIZE': settings.file_size_bytes,
        'RLIMIT_NPROC': settings.max_processes,
        'RLIMIT_NOFILE': 1024,
        'RLIMIT_CORE': 0,
    }
    return ','.join(f'{name}={value}' for name, value in limits.items())


def _wait_for_exit(pid: int, deadline: float, quota: WorkspaceQuota | None = None) -> str:
    """Waits (without reaping) until the child exits ('exited'), the deadline passes ('timeout') or the
    workspace goes over its limit ('disk').

    Not reaping keeps the child's pid, and so its process-group id, reserved until the group is killed.
    """
    next_disk_check = time.monotonic() + WorkspaceQuota.POLL_SECONDS
    while True:
        try:
            if os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                return 'exited'
        except ChildProcessError:
            return 'exited'
        now = time.monotonic()
        if now >= deadline:
            return 'timeout'
        if quota is not None and now >= next_disk_check:
            if quota.run_over_limit():
                return 'disk'
            next_disk_check = time.monotonic() + WorkspaceQuota.POLL_SECONDS
        time.sleep(0.01)


def prepare_run_dir(run_dir: str, workspace: str) -> None:
    """Pins node's lookups for the script to the run's own directory.

    node resolves packages and the module type through every ancestor of the script: without these two
    entries a run could plant /tmp/node_modules/<pkg> or /tmp/package.json and change later runs. The
    node_modules link (dangling until something is installed) makes workspace packages win over anything
    planted further up and lets `import` (ESM ignores NODE_PATH) find them; the empty package.json keeps
    ESM/CommonJS detection per file.
    """
    os.symlink(os.path.join(workspace, 'node_modules'), os.path.join(run_dir, 'node_modules'))
    with open(os.path.join(run_dir, 'package.json'), 'w', encoding='utf-8') as handle:
        handle.write('{}\n')


class WorkspaceResetError(Exception):
    """The requested wipe did not complete; the run must not start on a half-wiped workspace."""


def execute(
    settings: Settings,
    language: str,
    code: str,
    timeout_seconds: float,
    reset_workspace: bool = False,
    quota: WorkspaceQuota | None = None,
) -> dict[str, Any]:
    command, filename = LANGUAGES[language]
    if reset_workspace:
        try:
            removed = wipe_workspace(settings.workspace)
        # RecursionError: shutil.rmtree recurses before Python 3.13 and a run can plant a very deep tree.
        except (OSError, RecursionError) as error:
            raise WorkspaceResetError(str(error)) from error
        log.info('workspace reset: removed %d entries', removed)
        if quota is not None:
            quota.measure()
    reset_out_dir(settings.out_dir)
    run_dir = tempfile.mkdtemp(prefix='run-')
    try:
        prepare_run_dir(run_dir, settings.workspace)
        script = os.path.join(run_dir, filename)
        with open(script, 'w', encoding='utf-8') as handle:
            handle.write(code)
        argv = [sys.executable, '-I', '-S', '-c', LAUNCHER, rlimit_spec(settings, timeout_seconds), *command, script]

        out_read, out_write = os.pipe()
        err_read, err_write = os.pipe()
        started = time.monotonic()
        try:
            proc = subprocess.Popen(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=out_write,
                stderr=err_write,
                cwd=settings.workspace,
                env=child_env(settings, run_dir),
                start_new_session=True,
                close_fds=True,
            )
        except BaseException:
            for fd in (out_read, err_read):
                os.close(fd)
            raise
        finally:
            os.close(out_write)
            os.close(err_write)

        stdout_reader = CappedReader(out_read)
        stderr_reader = CappedReader(err_read)
        stdout_reader.start()
        stderr_reader.start()

        if quota is not None:
            quota.start_run()
        outcome = _wait_for_exit(proc.pid, started + timeout_seconds, quota)
        duration_ms = int((time.monotonic() - started) * 1000)
        # The run is over when its main process exits; background jobs die with it. Kill the group while
        # the leader is still an unreaped zombie (so its pgid cannot have been recycled), reap the leader,
        # then sweep whatever escaped the group. Only then can the output pipes reach EOF.
        kill_process_group(proc.pid)
        try:
            returncode = proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            log.error('run process %d did not die after SIGKILL', proc.pid)
            returncode = -signal.SIGKILL
        strays = sweep_descendants()
        stdout_reader.join(READER_JOIN_SECONDS)
        stderr_reader.join(READER_JOIN_SECONDS)

        files, omitted = collect_out_files(settings.out_dir)
        result: dict[str, Any] = {
            'stdout': stdout_reader.text(),
            'stderr': stderr_reader.text(),
            'exit_code': returncode,
            'signal': signal_name(returncode),
            'timed_out': outcome == 'timeout',
            'duration_ms': duration_ms,
            'stdout_truncated': stdout_reader.truncated,
            'stderr_truncated': stderr_reader.truncated,
            'files': files,
            'files_omitted': omitted,
            'workspace_reset': reset_workspace,
            'disk_limit_exceeded': outcome == 'disk',
            'workspace_over_limit': False,
        }
        if strays:
            log.info('killed %d background process(es) left behind by the run', strays)
        if quota is not None:
            result['workspace_limit_mb'] = quota.limit_mb
            result['workspace_over_limit'] = enforce_quota(settings, quota)
        return result
    finally:
        shutil.rmtree(run_dir, ignore_errors=True)


def enforce_quota(settings: Settings, quota: WorkspaceQuota) -> bool:
    """Wipes the workspace when it is over its limit (after a run, or at startup). True when it was over."""
    if not quota.measure():
        return False
    log.warning(
        'workspace over its limit (%s; max %d MB / %d entries): wiping it',
        quota.describe(),
        quota.limit_mb,
        quota.max_files,
    )
    try:
        wipe_workspace(settings.workspace)
    except (OSError, RecursionError) as error:
        log.error('could not wipe the over-limit workspace: %s', error)
    quota.measure()
    return True


def signal_name(returncode: int) -> str | None:
    """'SIGKILL' for a process killed by signal 9 (Popen reports it as -9); None for a normal exit."""
    if returncode >= 0:
        return None
    try:
        return signal.Signals(-returncode).name
    except ValueError:
        return f'signal {-returncode}'


# ---- one run at a time ------------------------------------------------------------------------------


class RunGate:
    """A lock with a bounded waiting line: at most `queue_size` requests wait, each for `wait_seconds`."""

    def __init__(self, queue_size: int, wait_seconds: float) -> None:
        self._cond = threading.Condition()
        self._busy = False
        self._waiting = 0
        self.queue_size = queue_size
        self.wait_seconds = wait_seconds

    def acquire(self) -> str:
        with self._cond:
            if not self._busy:
                self._busy = True
                return 'ok'
            if self._waiting >= self.queue_size:
                return 'queue_full'
            self._waiting += 1
            try:
                deadline = time.monotonic() + self.wait_seconds
                while self._busy:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return 'timeout'
                    self._cond.wait(remaining)
                self._busy = True
                return 'ok'
            finally:
                self._waiting -= 1

    def release(self) -> None:
        with self._cond:
            self._busy = False
            self._cond.notify()

    def snapshot(self) -> tuple[bool, int]:
        with self._cond:
            return self._busy, self._waiting


# ---- HTTP -------------------------------------------------------------------------------------------


class RequestError(Exception):
    def __init__(self, status: HTTPStatus, message: str) -> None:
        super().__init__(message)
        self.status = status


def parse_run_request(body: bytes) -> tuple[str, str, float, bool]:
    try:
        payload = json.loads(body.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise RequestError(HTTPStatus.BAD_REQUEST, 'body must be a JSON object') from None
    if not isinstance(payload, dict):
        raise RequestError(HTTPStatus.BAD_REQUEST, 'body must be a JSON object')
    language = payload.get('language')
    if language not in LANGUAGES:
        raise RequestError(HTTPStatus.BAD_REQUEST, f'language must be one of: {", ".join(LANGUAGES)}')
    code = payload.get('code')
    if not isinstance(code, str) or not code.strip():
        raise RequestError(HTTPStatus.BAD_REQUEST, 'code must be a non-empty string')
    if len(code.encode('utf-8')) > MAX_CODE_BYTES:
        raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, f'code is over {MAX_CODE_BYTES // 1024} KB')
    timeout = payload.get('timeout_seconds', DEFAULT_TIMEOUT_SECONDS)
    if timeout is None:
        timeout = DEFAULT_TIMEOUT_SECONDS
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout):
        raise RequestError(HTTPStatus.BAD_REQUEST, 'timeout_seconds must be a number')
    reset = payload.get('reset_workspace', False)
    if reset is None:
        reset = False
    if not isinstance(reset, bool):
        raise RequestError(HTTPStatus.BAD_REQUEST, 'reset_workspace must be a boolean')
    return language, code, float(min(MAX_TIMEOUT_SECONDS, max(1, timeout))), reset


def make_handler(settings: Settings, gate: RunGate, quota: WorkspaceQuota) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = 'frigidaire-sandbox/1'
        # Socket timeout for reading the request; a run itself is bounded by its own timeout.
        timeout = 30

        def log_message(self, format: str, *args: Any) -> None:
            log.debug('%s %s', self.address_string(), format % args)

        def send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            if status == HTTPStatus.UNAUTHORIZED:
                self.send_header('WWW-Authenticate', 'Bearer')
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path.split('?', 1)[0] != '/health':
                self.send_json(HTTPStatus.NOT_FOUND, {'error': 'not found'})
                return
            busy, queued = gate.snapshot()
            writable = workspace_writable(settings)
            self.send_json(
                HTTPStatus.OK if writable else HTTPStatus.SERVICE_UNAVAILABLE,
                {
                    'ok': writable,
                    'busy': busy,
                    'queued': queued,
                    'workspace_writable': writable,
                    'languages': list(LANGUAGES),
                },
            )

        def do_POST(self) -> None:
            if self.path.split('?', 1)[0] != '/run':
                self.send_json(HTTPStatus.NOT_FOUND, {'error': 'not found'})
                return
            if not settings.allow_local_clients and is_local_client(self.client_address):
                log.warning(
                    'refused /run from %s: a local client (a run trying to start another run)', self.client_address[0]
                )
                self.send_json(HTTPStatus.FORBIDDEN, {'error': 'runs cannot start other runs'})
                return
            if not self.authorized():
                log.warning('rejected /run from %s: bad or missing bearer token', self.address_string())
                self.send_json(HTTPStatus.UNAUTHORIZED, {'error': 'unauthorized'})
                return
            try:
                language, code, timeout, reset = parse_run_request(self.read_body())
            except RequestError as error:
                self.send_json(error.status, {'error': str(error)})
                return

            queued_at = time.monotonic()
            verdict = gate.acquire()
            if verdict != 'ok':
                log.warning('run refused: sandbox busy (%s)', verdict)
                status = HTTPStatus.TOO_MANY_REQUESTS if verdict == 'queue_full' else HTTPStatus.SERVICE_UNAVAILABLE
                self.send_json(status, {'error': 'sandbox is busy with another run'})
                return
            try:
                waited_ms = int((time.monotonic() - queued_at) * 1000)
                # Nobody is waiting for this result any more. Besides wasted work, this is what stops a run
                # from POSTing a follow-up run before it ends: by now every process of that run is dead.
                if client_disconnected(self.connection):
                    log.warning(
                        'dropped a queued run: its client disconnected while it waited (waited_ms=%d)', waited_ms
                    )
                    return
                # The workspace directory is this server's, not the run's: undo a `chmod a-w /workspace` a
                # previous run may have done to break every later run.
                _make_owner_writable(settings.workspace)
                if not workspace_writable(settings):
                    log.error('workspace %s is not writable by uid %d', settings.workspace, os.getuid())
                    self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {'error': 'sandbox workspace is not writable'})
                    return
                try:
                    result = execute(settings, language, code, timeout, reset, quota)
                except WorkspaceResetError as error:
                    log.error('workspace reset failed: %s', error)
                    self.send_json(
                        HTTPStatus.INTERNAL_SERVER_ERROR, {'error': f'could not reset the workspace: {error}'}
                    )
                    return
                except (OSError, RecursionError) as error:
                    log.exception('run failed to start')
                    reason = (error.strerror if isinstance(error, OSError) else None) or error
                    self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {'error': f'could not start the run: {reason}'})
                    return
            finally:
                gate.release()

            log.info(
                'run language=%s exit=%s timed_out=%s duration_ms=%d waited_ms=%d stdout=%dB stderr=%dB files=%d%s%s%s',
                language,
                result['exit_code'],
                result['timed_out'],
                result['duration_ms'],
                waited_ms,
                len(result['stdout']),
                len(result['stderr']),
                len(result['files']),
                ' reset=True' if reset else '',
                ' disk_limit=True' if result['disk_limit_exceeded'] else '',
                ' wiped_over_limit=True' if result['workspace_over_limit'] else '',
            )
            self.send_json(HTTPStatus.OK, result)

        def authorized(self) -> bool:
            if settings.token is None:
                return True
            header = self.headers.get('Authorization', '')
            scheme, _, value = header.partition(' ')
            if scheme.lower() != 'bearer':
                return False
            return hmac.compare_digest(value.strip().encode('utf-8'), settings.token.encode('utf-8'))

        def read_body(self) -> bytes:
            length_header = self.headers.get('Content-Length')
            if length_header is None:
                raise RequestError(HTTPStatus.LENGTH_REQUIRED, 'Content-Length is required')
            try:
                length = int(length_header)
            except ValueError:
                raise RequestError(HTTPStatus.BAD_REQUEST, 'invalid Content-Length') from None
            if length < 0 or length > MAX_BODY_BYTES:
                raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, 'request body too large')
            return self.rfile.read(length)

    return Handler


class SandboxServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(levelname)s %(message)s',
        stream=sys.stdout,
    )
    settings = Settings()
    harden_self()
    try:
        os.makedirs(settings.out_dir, exist_ok=True)
    except OSError as error:
        log.error(
            'cannot create %s (%s); mount a volume writable by uid %d at the workspace',
            settings.out_dir,
            error,
            os.getuid(),
        )
    if not workspace_writable(settings):
        log.error('workspace %s is not writable by uid %d; runs will fail until it is', settings.workspace, os.getuid())

    quota = WorkspaceQuota(settings)
    if workspace_writable(settings):
        enforce_quota(settings, quota)
        log.info('workspace holds %s (limit %d MB / %d entries)', quota.describe(), quota.limit_mb, quota.max_files)

    gate = RunGate(settings.queue_size, settings.queue_wait_seconds)
    server = SandboxServer((settings.host, settings.port), make_handler(settings, gate, quota))
    host, port = server.server_address[:2]
    log.info(
        'sandbox listening on %s:%d (workspace=%s, auth=%s)',
        host,
        port,
        settings.workspace,
        'on' if settings.token else 'off',
    )

    def stop(signum: int, _frame: Any) -> None:
        log.info('received %s, shutting down', signal.Signals(signum).name)
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
