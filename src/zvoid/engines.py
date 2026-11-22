"""Engines: each model family lives in engines/<id>/ with an engine.json spec and an engine.py.

Every engine gets its own Python env in .envs/<id> (they need clashing library versions),
and runs in a long-lived worker process so the model stays loaded between generations.
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from .paths import ENGINES_DIR, ENVS_DIR, WORKER


@dataclass
class Engine:
    id: str
    dir: Path
    spec: dict
    _proc: subprocess.Popen | None = field(default=None, repr=False)
    _lines: queue.Queue | None = field(default=None, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    where: str = "mac"          # "pc" = run this engine's worker on the second machine (see remote.json), over SSH
    _far: dict | None = field(default=None, repr=False)

    # ---- spec helpers -------------------------------------------------
    @property
    def name(self):
        return self.spec.get("name", self.id)

    @property
    def env_dir(self) -> Path:
        return ENVS_DIR / self.id

    @property
    def python(self) -> Path:
        return self.env_dir / "bin" / "python"

    @property
    def installed(self) -> bool:
        return (self.env_dir / ".zvoid-installed").exists()

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    # ---- install --------------------------------------------------------
    def install(self, log=print):
        """Create the env and install requirements. Yields nothing; calls log(line)."""
        uv = shutil.which("uv")
        if not uv:
            raise RuntimeError("uv is not installed. Run: brew install uv")
        py = self.spec.get("python", "3.11")
        reqs = self.spec.get("requirements", [])
        self.stop()
        marker = self.env_dir / ".zvoid-installed"
        marker.unlink(missing_ok=True)
        _stream([uv, "venv", "--allow-existing", "--python", py, str(self.env_dir)], log)
        if reqs:
            cmd = [uv, "pip", "install", "--python", str(self.python), *self.spec.get("pip_args", []), *reqs]
            _stream(cmd, log)
        for post in self.spec.get("post_install", []):
            _stream([str(self.python), "-c", post], log)
        marker.write_text(time.strftime("%Y-%m-%d %H:%M:%S"))
        log(f"✔ {self.name} installed")

    def uninstall(self):
        self.stop()
        shutil.rmtree(self.env_dir, ignore_errors=True)

    # ---- worker -------------------------------------------------------
    def start(self):
        if self.running:
            return
        if self.where == "pc":
            return self._start_far()
        self._far = None
        if not self.installed:
            raise RuntimeError(f"{self.name} isn't installed yet. Open “engines” (top right) to install it.")
        env = dict(os.environ)
        env.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        env.setdefault("TOKENIZERS_PARALLELISM", "false")
        env["PYTHONUNBUFFERED"] = "1"
        self._proc = subprocess.Popen(
            [str(self.python), "-u", "-I", str(WORKER), str(self.dir)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,  # libraries' chatter goes straight to the terminal running zvoid
            text=True,
            bufsize=1,
            cwd=str(self.dir),
            env=env,
        )
        self._pump()

    def _pump(self):
        self._lines = queue.Queue()
        proc, q = self._proc, self._lines

        def pump():
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    q.put(json.loads(line))
                except json.JSONDecodeError:
                    pass
            q.put({"type": "exit"})

        threading.Thread(target=pump, daemon=True).start()
        msg = q.get()
        if msg["type"] != "ready":
            self.stop()
            raise RuntimeError(msg.get("error", "worker failed to start") + "\n" + msg.get("trace", ""))

    # ---- the worker on a second machine ------------------------------------
    def _start_far(self):
        """Start the worker on the PC. Its code is sent over each time, so the PC always runs what this Mac has."""
        from . import gym

        r = gym.remote()
        if not r or not gym.remote_status(True).get("reachable"):
            raise RuntimeError("The PC is not reachable right now. Check that it is on, or set this engine to run on this Mac (in “engines”).")
        if gym._train.get("state") in ("running", "stopping") and gym._train.get("remote"):
            raise RuntimeError("The PC is busy training a creature. Wait for it to finish, or set this engine to run on this Mac (in “engines”).")
        others = [e for e in _ALL.values() if e is not self and e._far and e._proc is not None and e._proc.poll() is None]
        if others:                                            # its graphics card holds one big model comfortably, not two: make room if it is short
            try:
                free = int(gym._ps(r, "nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits").strip().splitlines()[0])
            except Exception:
                free = 0
            if free < int(self.spec.get("vram_mb", 9000)):
                for e in others:
                    e.stop()
        base = f"{r['dir']}\\app"
        gym._ps(r, f"New-Item -ItemType Directory -Force -Path {base}\\engines, {base}\\in, {base}\\out, {base}\\creatures | Out-Null")
        gym._tar_to(r, self.dir.parent, [self.id, "_common"], f"{base}\\engines")
        gym._tar_to(r, WORKER.parent, [WORKER.name], base)
        gym._tar_to(r, ENGINES_DIR.parent / "scripts" / "remote", ["run_engine.cmd"], base)
        home = gym._ps(r, "$env:USERPROFILE").strip()
        self._far = dict(r, base=f"{home}\\{r['dir']}\\app", rel=base)
        self._proc = subprocess.Popen(gym._ssh_base(r) + [f"{base}\\run_engine.cmd {self.id}"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None, text=True, bufsize=1)
        self._pump()

    def _far_params(self, params: dict, ctx_id: str) -> dict:
        """Send what this run needs to the PC (input audio, the creature's adapter) and point the parameters at the copies there."""
        from . import gym

        r, p = self._far, dict(params)
        for q in self.spec.get("params", []):
            v = p.get(q["name"])
            if q.get("type") in ("audio", "file") and v and Path(str(v)).is_file():
                src = Path(str(v))
                gym._tar_to(r, src.parent, [src.name], f"{r['rel']}\\in")
                p[q["name"]] = f"{r['base']}\\in\\{src.name}"
        slug = (p.get("creature") or "").strip()
        if slug:
            lora = gym._dir(slug) / "lora"
            at = Path(str(p.get("creature_at") or "")) if p.get("creature_at") else None
            if not (at and (at / "adapter_config.json").exists()):
                found = [x for x in [lora / "final", *(lora / "checkpoints").glob("epoch_*")] if (x / "adapter_config.json").exists()]
                if not found:
                    raise RuntimeError(f"Creature “{slug}” hasn't been trained yet. Train it in the vivarium first.")
                at = max(found, key=lambda x: (x / "adapter_config.json").stat().st_mtime)
            name = "gen_" + "".join(ch if ch.isalnum() else "_" for ch in at.name) + f"_{int((at / 'adapter_model.safetensors').stat().st_mtime)}"
            cdir = f"{r['rel']}\\creatures\\{slug}"
            if "yes" not in gym._ps(r, f"if (Test-Path {cdir}\\lora\\{name}\\adapter_model.safetensors) {{ 'yes' }}"):
                gym._ps(r, f"Get-ChildItem {cdir}\\lora -Directory -Filter gen_* -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force; New-Item -ItemType Directory -Force -Path {cdir}\\lora\\{name} | Out-Null")
                gym._tar_to(r, at, ["adapter_config.json", "adapter_model.safetensors"], f"{cdir}\\lora\\{name}")
            gym._tar_to(r, gym._dir(slug), ["creature.json"], cdir)
            p["creature_at"] = f"{r['base']}\\creatures\\{slug}\\lora\\{name}"
        return p

    def _far_fetch(self, rid: str, outputs: list, out_dir: Path) -> list:
        """Bring what the PC made back into this run's folder."""
        from pathlib import PureWindowsPath
        from . import gym

        r = self._far
        out_dir.mkdir(parents=True, exist_ok=True)
        a = subprocess.Popen(gym._ssh_base(r) + [f"tar -cf - -C {r['rel']}\\out\\{rid} ."], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        b = subprocess.run(["tar", "-xf", "-", "-C", str(out_dir)], stdin=a.stdout, capture_output=True, text=True)
        a.wait()
        if a.returncode or b.returncode:
            raise RuntimeError("The PC made it, but it could not be brought back.")
        try:
            gym._ps(r, f"Remove-Item -Recurse -Force {r['rel']}\\out\\{rid}", timeout=20)
        except Exception:
            pass
        return [dict(o, path=str(out_dir / PureWindowsPath(str(o.get("path", ""))).name)) for o in outputs]

    def stop(self):
        """Kill the worker. Frees the model from memory."""
        if self._proc is not None and self._far:
            try:
                from . import gym
                gym._ps(self._far, "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match 'worker.py' -and $_.CommandLine -match 'engines.%s' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" % self.id, timeout=20)
            except Exception:
                pass
        if self._proc is not None:
            try:
                self._proc.kill()
                self._proc.wait(timeout=5)
            except Exception:
                pass
        self._proc = None

    def run(self, params: dict, out_dir: Path):
        """Generator: yields ("progress", msg, frac) and finally ("result", outputs, info).
        The PC does one thing at a time: its graphics card holds one big model, and starting a second engine there while
        another is at work made them send the same files at once and push each other out of memory."""
        if self.where != "pc":
            yield from self._run(params, out_dir)
            return
        while not _FAR_TURN.acquire(timeout=1):
            yield ("progress", "waiting for the PC: another module is using it…", None)
        try:
            yield from self._run(params, out_dir)
        finally:
            _FAR_TURN.release()

    def _run(self, params: dict, out_dir: Path):
        with self._lock:
            if self.running and bool(self._far) != (self.where == "pc"):
                self.stop()                                   # it was moved to the other machine since it last ran
            if self.where == "pc":
                yield ("progress", "reaching the PC…", None)
            self.start()
            rid = ""
            if self._far:
                import uuid
                rid = uuid.uuid4().hex[:10]
                yield ("progress", "sending what it needs to the PC…", None)
                params, far_out = self._far_params(params, rid), f"{self._far['base']}\\out\\{rid}"
            self._proc.stdin.write(json.dumps({"cmd": "run", "params": params, "out_dir": far_out if self._far else str(out_dir)}) + "\n")
            self._proc.stdin.flush()
            while True:
                msg = self._lines.get()
                t = msg["type"]
                if t == "progress":
                    yield ("progress", msg.get("msg", ""), msg.get("frac"))
                elif t == "result":
                    outs = msg.get("outputs", [])
                    if self._far:
                        yield ("progress", "bringing it back from the PC…", None)
                        outs = self._far_fetch(rid, outs, Path(out_dir))
                    yield ("result", outs, msg.get("info", {}))
                    return
                elif t == "error":
                    raise RuntimeError(msg["error"] + "\n\n" + msg.get("trace", ""))
                elif t == "exit":
                    self._proc = None
                    raise RuntimeError("The engine process quit unexpectedly (out of memory?). Check the terminal log.")


def _stream(cmd, log):
    log("$ " + " ".join(cmd))
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in p.stdout:
        log(line.rstrip())
    if p.wait() != 0:
        raise RuntimeError(f"Command failed ({p.returncode}): {' '.join(cmd)}")


_ALL: dict = {}
_FAR_TURN = threading.Lock()      # whose turn it is on the PC


def discover() -> dict[str, Engine]:
    engines = _ALL
    engines.clear()
    for d in sorted(ENGINES_DIR.iterdir()):
        spec_file = d / "engine.json"
        if d.is_dir() and spec_file.exists() and (d / "engine.py").exists():
            spec = json.loads(spec_file.read_text())
            engines[d.name] = Engine(id=d.name, dir=d, spec=spec)
    try:                                                      # which engines were set to run on the second machine
        from . import gym
        for eid, w in ((gym.remote() or {}).get("engines") or {}).items():
            if eid in engines and w == "pc":
                engines[eid].where = "pc"
    except Exception:
        pass
    return engines


def env_size(engine: Engine) -> str:
    if not engine.env_dir.exists():
        return "—"
    try:
        out = subprocess.run(["du", "-sh", str(engine.env_dir)], capture_output=True, text=True).stdout
        return out.split()[0]
    except Exception:
        return "?"


def cli_install(ids: list[str]):
    engines = discover()
    for i in ids or list(engines):
        if i not in engines:
            sys.exit(f"Unknown engine '{i}'. Known: {', '.join(engines)}")
        engines[i].install()
