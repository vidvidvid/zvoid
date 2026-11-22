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


# ---- one listing of everything that was made --------------------------------------------------
MIDI_EXT = {".mid", ".midi"}
IMAGE_EXT = {".png", ".jpg", ".jpeg"}
VIDEO_EXT = {".mp4", ".mov", ".webm"}
_STARS = OUTPUTS_DIR / ".stars.json"


def _stars() -> set:
    try:
        return set(json.loads(_STARS.read_text()))
    except Exception:
        return set()


def star(path: str, on: bool) -> bool:
    st = _stars()
    (st.add if on else st.discard)(path)
    _STARS.write_text(json.dumps(sorted(st)))
    return on


_TITLES = OUTPUTS_DIR / ".titles.json"


def _titles() -> dict:
    try:
        return dict(json.loads(_TITLES.read_text()))
    except Exception:
        return {}


def rename(path: Path, title: str) -> dict:
    """Give a made file a name of your own. Clips the modules made are renamed on disk too, so the name follows them into
    Finder and other programs; stills, films and recordings keep their file name (it carries their creature and date)
    and only show the new name here. An empty name goes back to the automatic one."""
    title = re.sub(r"\s+", " ", title or "").strip()[:120]
    t, new = _titles(), path
    t.pop(str(path), None)
    if title and (path.parent / "meta.json").exists():
        stem = re.sub(r"\s+", " ", re.sub(r'[/\\:*?"<>|\x00-\x1f]', " ", title)).strip(" .")[:100] or path.stem
        new, n = path.with_name(stem + path.suffix), 1
        while new.exists() and new != path:
            n += 1
            new = path.with_name(f"{stem} {n}{path.suffix}")
        if new != path:
            path.rename(new)
            meta = path.parent / "meta.json"
            try:                                              # the run's own record points at the file by name
                meta.write_text(meta.read_text().replace(json.dumps(str(path))[1:-1], json.dumps(str(new))[1:-1]))
            except Exception:
                pass
            if str(path) in _stars():
                star(str(path), False)
                star(str(new), True)
    if title:
        t[str(new)] = title
    _TITLES.write_text(json.dumps(t, indent=1, ensure_ascii=False))
    return {"path": str(new), "name": new.name, "title": title}


def _kind(p: Path) -> str:
    e = p.suffix.lower()
    return "audio" if e in AUDIO_EXT else "midi" if e in MIDI_EXT else "still" if e in IMAGE_EXT else "video" if e in VIDEO_EXT else "other"


def list_items(limit: int = 800) -> list[dict]:
    """Every file worth showing, newest first: what the modules made, plus stills, time-lapses, films and sound recordings."""
    stars, items, named = _stars(), [], _titles()
    for run in list_runs(400):
        params = run.get("params") or {}
        label = (run.get("label") or "").strip()
        files = [Path(f) for f in run_files(run["_dir"])]
        for f in files:
            k = _kind(f)
            if k == "other":
                continue
            part = re.sub(r"^(ace_[a-z0-9]+_\d+_seed\d+|\d{6}_)", "", f.stem).replace("_", " ").strip()
            title = label or f.stem
            take = re.match(r"ace_[a-z0-9]+_(\d+)_seed", f.stem)
            norm = lambda x: re.sub(r"[^a-z0-9]", "", x.lower())
            shown = len([x for x in files if _kind(x) != "other"])
            is_ace = (run.get("engine") or "") == "ace_step"
            if not is_ace and re.match(r"ace[-_]", label) and run.get("engine") in ("demucs", "basic_pitch"):
                title = "stems of an ace-step clip" if run.get("engine") == "demucs" else "notes of an ace-step clip"   # the label is only the input's file name: say what this is
            if run.get("engine") == "demucs":
                part = f.stem.rsplit("_", 1)[-1]            # drums, bass, other, vocals
            elif run.get("engine") == "basic_pitch":
                part = "MIDI" if f.suffix.lower() in (".mid", ".midi") else "MIDI preview"
            if take and shown > 1 and is_ace:
                title = f"{title} · take {take.group(1)}"
            elif shown > 1 and part and norm(part) not in norm(title):
                title = f"{title} · {part}"                 # stems and other multi-file results are told apart by their part: drums, bass, vocals…
            items.append({"path": str(f), "name": f.name, "kind": k, "title": title[:120], "when": (run.get("created") or "")[:19].replace("T", " "),
                          "source": run.get("engine_name") or run.get("engine") or "", "engine": run.get("engine") or "",
                          "creature": params.get("creature") or "", "seed": params.get("seed"), "model": params.get("model") or "",
                          "size": f.stat().st_size, "star": str(f) in stars})
    for sub, default in (("captures", "still"), ("recordings", "time-lapse")):
        d = OUTPUTS_DIR / sub
        for f in (sorted(d.iterdir()) if d.is_dir() else []):
            k = _kind(f)
            if not f.is_file() or k == "other" or ".raw." in f.name:
                continue
            m = re.match(r"(.+?)-(film-|sound-)?(\d{8})-(\d{6})", f.stem)
            creature, tag, when = (m.group(1), m.group(2) or "", f"{m.group(3)[:4]}-{m.group(3)[4:6]}-{m.group(3)[6:]} {m.group(4)[:2]}:{m.group(4)[2:4]}:{m.group(4)[4:]}") if m else (
                "", "", time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(f.stat().st_mtime)))
            source = "still" if k == "still" else "film" if tag == "film-" else "sound recording" if tag == "sound-" else default
            items.append({"path": str(f), "name": f.name, "kind": k, "title": f"{creature.replace('-', ' ')} · {source}" if creature else f.stem, "when": when,
                          "source": source, "engine": "", "creature": creature, "seed": None, "model": "", "size": f.stat().st_size, "star": str(f) in stars})
    for it in items:
        if it["path"] in named:
            it["title"], it["renamed"] = named[it["path"]], True
    items.sort(key=lambda i: i["when"], reverse=True)
    return items[:limit]


def trash(path: Path) -> dict:
    """Move one made file to the macOS Trash. An emptied run folder goes with it. Returns what is needed to put it back."""
    bin_ = Path.home() / ".Trash"
    dst = bin_ / path.name
    n = 1
    while dst.exists():
        n += 1
        dst = bin_ / f"{path.stem} {n}{path.suffix}"
    was_star, title = str(path) in _stars(), _titles().get(str(path))
    path.rename(dst)
    if title:
        t = _titles()
        t.pop(str(path), None)
        _TITLES.write_text(json.dumps(t, indent=1, ensure_ascii=False))
    star(str(path), False)
    parent, meta = path.parent, None
    if (parent / "meta.json").exists() and not any(p.name != "meta.json" for p in parent.iterdir()):
        meta = (parent / "meta.json").read_text()
        (parent / "meta.json").unlink()
        parent.rmdir()
    return {"path": str(path), "trash": str(dst), "meta": meta, "star": was_star, "title": title}


def restore(rec: dict) -> None:
    """Put a file that was just moved to the Trash back where it was (undo)."""
    src, dst = Path(rec["trash"]), Path(rec["path"])
    if src.parent != Path.home() / ".Trash" or OUTPUTS_DIR.resolve() not in dst.resolve().parents:
        raise FileNotFoundError("that cannot be put back")
    if not src.exists():
        raise FileNotFoundError("it is no longer in the Trash")
    if dst.exists():
        raise FileNotFoundError("something with that name is already there")
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    if rec.get("meta") and not (dst.parent / "meta.json").exists():
        (dst.parent / "meta.json").write_text(rec["meta"])
    if rec.get("star"):
        star(str(dst), True)
    if rec.get("title"):
        t = _titles()
        t[str(dst)] = rec["title"]
        _TITLES.write_text(json.dumps(t, indent=1, ensure_ascii=False))


def peaks(path: Path, n: int = 600) -> dict:
    """The outline of a sound for drawing its waveform: n pairs of lowest and highest level, made once and kept in outputs/.thumbs."""
    import hashlib
    import subprocess
    from array import array
    d = OUTPUTS_DIR / ".thumbs"
    d.mkdir(exist_ok=True)
    out = d / (hashlib.sha1(f"{path}|{path.stat().st_mtime}|peaks{n}".encode()).hexdigest()[:20] + ".json")
    if out.exists():
        return json.loads(out.read_text())
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], capture_output=True)
    a = array("h")
    a.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
    if not len(a):
        raise FileNotFoundError("no sound in that file")
    step = max(1, len(a) // n)
    lo, hi = [], []
    for i in range(0, len(a) - step + 1, step):
        seg = a[i:i + step]
        lo.append(round(min(seg) / 32768, 3))
        hi.append(round(max(seg) / 32768, 3))
    res = {"secs": round(len(a) / 8000, 2), "lo": lo[:n], "hi": hi[:n]}
    out.write_text(json.dumps(res))
    return res


def thumb(path: Path, width: int = 360) -> Path:
    """A small JPEG of a still or of a video's first second, made once and kept in outputs/.thumbs."""
    import hashlib
    import subprocess
    d = OUTPUTS_DIR / ".thumbs"
    d.mkdir(exist_ok=True)
    out = d / (hashlib.sha1(f"{path}|{path.stat().st_mtime}|{width}".encode()).hexdigest()[:20] + ".jpg")
    if out.exists():
        return out
    if _kind(path) == "video":
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "1", "-i", str(path), "-frames:v", "1", "-vf", f"scale={width}:-2", str(out)], capture_output=True)
        if not out.exists():
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(path), "-frames:v", "1", "-vf", f"scale={width}:-2", str(out)], capture_output=True)
    else:
        subprocess.run(["sips", "-s", "format", "jpeg", "-Z", str(width * 2), str(path), "--out", str(out)], capture_output=True)
    if not out.exists():
        raise FileNotFoundError("no preview for that file")
    return out
