"""Library: every run is a folder in outputs/<date>/<time>_<engine>_<slug>/ with a meta.json."""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

from .paths import OUTPUTS_DIR

AUDIO_EXT = {".wav", ".mp3", ".flac", ".ogg", ".aiff", ".aif", ".m4a"}


def new_run_dir(engine_id: str, label: str) -> Path:
    slug = re.sub(r"[^a-z0-9]+", "-", (label or "").lower()).strip("-")[:40] or "run"
    d = OUTPUTS_DIR / time.strftime("%Y-%m-%d") / f"{time.strftime('%H%M%S')}_{engine_id}_{slug}"
    n = 1
    base = d
    while d.exists():
        n += 1
        d = base.with_name(f"{base.name}-{n}")
    d.mkdir(parents=True)
    return d


def write_meta(run_dir: Path, meta: dict):
    (run_dir / "meta.json").write_text(json.dumps(meta, indent=2, default=str))


def list_runs(limit: int = 300) -> list[dict]:
    runs = []
    for meta_file in sorted(OUTPUTS_DIR.glob("*/*/meta.json"), reverse=True)[:limit]:
        try:
            meta = json.loads(meta_file.read_text())
        except Exception:
            continue
        meta["_dir"] = str(meta_file.parent)
        runs.append(meta)
    runs.sort(key=lambda m: m.get("created", ""), reverse=True)
    return runs


def run_files(run_dir: str) -> list[str]:
    return [str(p) for p in sorted(Path(run_dir).iterdir()) if p.name != "meta.json" and p.is_file()]


def latest_audio() -> str | None:
    for run in list_runs(50):
        for f in run_files(run["_dir"]):
            if Path(f).suffix.lower() in AUDIO_EXT:
                return f
    return None


def all_audio(limit: int = 200) -> list[tuple[str, str]]:
    """(label, path) pairs for dropdowns, newest first."""
    items = []
    for run in list_runs(limit):
        when = run.get("created", "")[5:16]
        who = run.get("engine_name", run.get("engine", ""))
        what = (run.get("label") or "")[:40]
        for f in run_files(run["_dir"]):
            if Path(f).suffix.lower() in AUDIO_EXT:
                items.append((f"{when} · {who} · {what} · {Path(f).name}", f))
    return items


def latest_run_dir(engine_id: str | None = None) -> str | None:
    for run in list_runs(100):
        if engine_id is None or run.get("engine") == engine_id:
            return run["_dir"]
    return None
