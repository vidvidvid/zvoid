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
        return (self.env_dir / ".soundlab-installed").exists()

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
        marker = self.env_dir / ".soundlab-installed"
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
        if not self.installed:
            raise RuntimeError(f"{self.name} isn't installed yet. Install it in the Engines tab.")
        env = dict(os.environ)
        env.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        env.setdefault("TOKENIZERS_PARALLELISM", "false")
        env["PYTHONUNBUFFERED"] = "1"
        self._proc = subprocess.Popen(
            [str(self.python), "-u", "-I", str(WORKER), str(self.dir)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,  # libraries' chatter goes straight to the terminal running soundlab
            text=True,
            bufsize=1,
            cwd=str(self.dir),
            env=env,
        )
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

    def stop(self):
        """Kill the worker. Frees the model from memory."""
        if self._proc is not None:
            try:
                self._proc.kill()
                self._proc.wait(timeout=5)
            except Exception:
                pass
        self._proc = None

    def run(self, params: dict, out_dir: Path):
        """Generator: yields ("progress", msg, frac) and finally ("result", outputs, info)."""
        with self._lock:
            self.start()
            self._proc.stdin.write(json.dumps({"cmd": "run", "params": params, "out_dir": str(out_dir)}) + "\n")
            self._proc.stdin.flush()
            while True:
                msg = self._lines.get()
                t = msg["type"]
                if t == "progress":
                    yield ("progress", msg.get("msg", ""), msg.get("frac"))
                elif t == "result":
                    yield ("result", msg.get("outputs", []), msg.get("info", {}))
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


def discover() -> dict[str, Engine]:
    engines = {}
    for d in sorted(ENGINES_DIR.iterdir()):
        spec_file = d / "engine.json"
        if d.is_dir() and spec_file.exists() and (d / "engine.py").exists():
            spec = json.loads(spec_file.read_text())
            engines[d.name] = Engine(id=d.name, dir=d, spec=spec)
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
