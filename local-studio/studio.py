"""Run scripts explicitly submitted by a trusted user of the loopback server.

Each job has its own working directory. Scripts have this OS user's permissions.
"""
import codecs
import os
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import OrderedDict
from pathlib import Path

JOBS = OrderedDict()
LOCK = threading.RLock()
ROOT = tempfile.TemporaryDirectory(prefix="rea-studio-")
LOG_LIMIT = 32 * 1024
DOWNLOAD_LIMIT = 32 * 1024 * 1024
ARTIFACTS = {"output.png": "image/png", "output.mp4": "video/mp4"}
TIMEOUT = 300
MAX_JOBS = 5
CONTAINER = "rea-blender"


def _termux_prefix():
    prefix = os.environ.get("TERMUX__PREFIX") or os.environ.get("PREFIX", "")
    return Path(prefix) if prefix.startswith("/data/") and shutil.which("pkg") else None


def _container_root(prefix):
    return prefix / "var" / "lib" / "proot-distro" / "containers" / CONTAINER / "rootfs"


def _container_ready():
    prefix = _termux_prefix()
    return bool(prefix and shutil.which("proot-distro") and (_container_root(prefix) / "usr/bin/blender").exists())


def capabilities():
    return {"python": True, "blender": bool(shutil.which("blender") or _container_ready()),
            "can_install_blender": bool(_termux_prefix()), "timeout": TIMEOUT}


def _public(job):
    return {key: job[key] for key in ("id", "state", "log", "artifacts")}


def status(job_id):
    with LOCK:
        return _public(JOBS[job_id])


def start(engine, script):
    if engine not in ("python", "blender"):
        raise ValueError("Python या Blender चुनें।")
    if not isinstance(script, str) or not script.strip() or len(script.encode()) > 65536:
        raise ValueError("स्क्रिप्ट खाली है या 64 KB से बड़ी है।")
    if engine == "blender" and not capabilities()["blender"]:
        raise RuntimeError("इस सर्वर पर Blender इंस्टॉल करें।")
    return _launch(engine, script)


def install_blender():
    if not _termux_prefix():
        raise RuntimeError("ऐप से इंस्टॉल करने के लिए सर्वर Termux में चलाएँ।")
    if capabilities()["blender"]:
        raise RuntimeError("Blender उपलब्ध है।")
    return _launch("install", "")


def _launch(engine, script):
    with LOCK:
        if any(job["state"] in ("queued", "running") for job in JOBS.values()):
            raise RuntimeError("एक काम पहले से चल रहा है।")
        if len(JOBS) >= MAX_JOBS:
            _, oldest = JOBS.popitem(last=False)
            shutil.rmtree(oldest["dir"], ignore_errors=True)
        job_id = uuid.uuid4().hex
        directory = Path(ROOT.name, job_id)
        directory.mkdir(mode=0o700)
        if engine == "install":
            args = [sys.executable, "-u", str(Path(__file__).resolve()), "--install-blender"]
        else:
            (directory / "run.py").write_text(script, encoding="utf-8")
            if engine == "python":
                args = [sys.executable, "-u", "run.py"]
            else:
                render = ["blender", "--background", "--factory-startup", "--python-exit-code", "1", "--python", "run.py"]
                if shutil.which("blender"):
                    args = render
                else:
                    args = ["proot-distro", "login", CONTAINER, "--bind", f"{directory}:/mnt",
                            "--work-dir", "/mnt", "--", *render]
        job = dict(id=job_id, dir=directory, state="queued", log="", artifacts=[])
        JOBS[job_id] = job
        timeout = 1800 if engine == "install" else TIMEOUT
        threading.Thread(target=_run, args=(job, args, timeout), daemon=True).start()
        return _public(job)

def _append(job, data):
    with LOCK:
        job["log"] = (job["log"] + data)[-LOG_LIMIT:]


def _kill_group(process):
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _run(job, args, timeout):
    with LOCK:
        job["state"] = "running"
    state = "failed"
    process = None
    try:
        # Retain native tool/library paths, but keep provider credentials out of the environment.
        env = {k: os.environ[k] for k in (
            "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "PREFIX",
            "LD_LIBRARY_PATH", "ANDROID_ROOT", "ANDROID_DATA", "XDG_RUNTIME_DIR", "TERMUX__PREFIX",
            "EXTERNAL_STORAGE", "ANDROID_ART_ROOT", "TERMUX_VERSION"
        ) if k in os.environ}
        process = subprocess.Popen(
            args, cwd=job["dir"], env=env, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True
        )
        end = time.monotonic() + timeout
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map() or process.poll() is None:
                remaining = end - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError
                for key, _ in selector.select(min(0.25, remaining)):
                    data = os.read(key.fd, 8192)
                    if data:
                        _append(job, decoder.decode(data))
                    else:
                        selector.unregister(key.fd)
            _append(job, decoder.decode(b"", final=True))
        if process.returncode == 0:
            state = "done"
        else:
            _append(job, f"\nप्रक्रिया का निकास कोड {process.returncode} है।")
    except TimeoutError:
        _append(job, f"\n{timeout} सेकंड की समय सीमा पूरी हुई।")
    except OSError as exc:
        _append(job, f"\n{exc}")
    finally:
        if process:
            _kill_group(process)
            process.wait()
            process.stdout.close()
        outputs = []
        for name in ARTIFACTS:
            try:
                info = (job["dir"] / name).lstat()
                if stat.S_ISREG(info.st_mode) and 0 < info.st_size <= DOWNLOAD_LIMIT:
                    outputs.append(name)
                elif info.st_size > DOWNLOAD_LIMIT:
                    _append(job, f"\n{name} की फ़ाइल 32 MB से बड़ी है।")
            except FileNotFoundError:
                pass
        with LOCK:
            job.update(state=state, artifacts=outputs)


def artifact(job_id, name):
    with LOCK:
        job = JOBS[job_id]
        if name not in job["artifacts"]:
            raise KeyError(name)
        try:
            fd = os.open(job["dir"] / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError as exc:
            raise KeyError(name) from exc
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > DOWNLOAD_LIMIT:
            raise KeyError(name)
        data = source.read(DOWNLOAD_LIMIT + 1)
        if len(data) > DOWNLOAD_LIMIT:
            raise KeyError(name)
    return data, ARTIFACTS[name]


def _provision_blender():
    prefix = _termux_prefix()
    if not prefix:
        raise RuntimeError("यह इंस्टॉलर Termux में चलता है।")
    if not shutil.which("proot-distro"):
        subprocess.run(["pkg", "install", "-y", "proot-distro"], check=True)
    if not (_container_root(prefix) / "etc/debian_version").is_file():
        subprocess.run(["proot-distro", "install", "debian:trixie", "--name", CONTAINER], check=True)
    login = ["proot-distro", "login", CONTAINER, "--", "env", "DEBIAN_FRONTEND=noninteractive"]
    subprocess.run([*login, "apt-get", "update"], check=True)
    subprocess.run([*login, "apt-get", "install", "-y", "--no-install-recommends", "blender"], check=True)
    subprocess.run([*login, "blender", "--version"], check=True)


if __name__ == "__main__" and sys.argv[1:] == ["--install-blender"]:
    _provision_blender()
