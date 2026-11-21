"""The gym: creatures are LoRA adapters for ACE-Step that you raise on your own audio.

creatures/<slug>/
    creature.json     name, style, tag, what it ate (with audio features), training history
    food/             the audio you fed it (converted to wav)
    tensors/          digested food (training tensors)
    lora/             checkpoints/ and final/ (the adapter the ace-step module loads)
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from .paths import CREATURES_DIR, ENGINES_DIR, ENVS_DIR, ROOT

_lock = threading.Lock()
_train: dict = {"slug": None, "proc": None, "state": "idle", "msg": "", "stage": "", "epoch": 0, "max_epochs": 0,
                "loss": None, "step": 0, "error": None, "started": 0}


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:32]
    if not s:
        raise ValueError("Give the creature a name with letters or numbers.")
    return s


def _dir(slug: str) -> Path:
    if not re.fullmatch(r"[a-z0-9\-]{1,32}", slug):
        raise ValueError("bad creature id")
    return CREATURES_DIR / slug


def _load(slug: str) -> dict:
    f = _dir(slug) / "creature.json"
    if not f.exists():
        raise FileNotFoundError(f"no creature called {slug}")
    return json.loads(f.read_text())


def _save(c: dict):
    (_dir(c["slug"]) / "creature.json").write_text(json.dumps(c, indent=2))


def _view(c: dict) -> dict:
    slug = c["slug"]
    c = dict(c, trained=(_dir(slug) / "lora" / "final" / "adapter_config.json").exists(),
             minutes=round(sum(f.get("secs", 0) for f in c.get("food", [])) / 60, 2))
    c["training"] = dict({k: v for k, v in _train.items() if k != "proc"}) if _train["slug"] == slug else None
    return c


def list_creatures() -> list[dict]:
    out = []
    for f in sorted(CREATURES_DIR.glob("*/creature.json")):
        try:
            out.append(_view(json.loads(f.read_text())))
        except Exception:
            continue
    return sorted(out, key=lambda c: c.get("born", ""))


def trained_slugs() -> list[str]:
    return [c["slug"] for c in list_creatures() if c["trained"]]


def get(slug: str) -> dict:
    return _view(_load(slug))


def hatch(name: str) -> dict:
    slug = slugify(name)
    d = _dir(slug)
    if d.exists():
        raise ValueError(f"A creature called “{slug}” already exists.")
    (d / "food").mkdir(parents=True)
    c = {"slug": slug, "name": name.strip()[:40], "born": time.strftime("%Y-%m-%d %H:%M:%S"), "style": "", "tag": slug,
         "food": [], "epochs": 0, "history": [], "sessions": 0}
    _save(c)
    return _view(c)


def update(slug: str, patch: dict) -> dict:
    c = _load(slug)
    for k in ("style", "tag", "name"):
        if k in patch:
            c[k] = str(patch[k])[:300]
    if "captions" in patch:
        for f in c["food"]:
            if f["name"] in patch["captions"]:
                f["caption"] = str(patch["captions"][f["name"]])[:400]
    _save(c)
    return _view(c)


def release(slug: str):
    if _train["slug"] == slug and _train["state"] == "running":
        stop(slug)
    shutil.rmtree(_dir(slug), ignore_errors=True)


# ---- feeding ---------------------------------------------------------------
def features(wav: Path) -> dict:
    """A few cheap numbers that describe how a track sounds. They shape the creature."""
    info = sf.info(str(wav))
    sr, total = info.samplerate, info.frames
    n = min(total, sr * 90)
    y, _ = sf.read(str(wav), start=max(0, (total - n) // 2), frames=n, dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if len(y) < 2048:
        return {"secs": round(total / sr, 2)}
    hop, win = 512, 2048
    frames = np.lib.stride_tricks.sliding_window_view(y, win)[::hop] * np.hanning(win)
    mag = np.abs(np.fft.rfft(frames, axis=1))
    freqs = np.fft.rfftfreq(win, 1 / sr)
    power = (mag ** 2).mean(axis=0)
    tot = power.sum() + 1e-12
    rms = np.sqrt((frames ** 2).mean(axis=1))
    flux = np.maximum(0, np.diff(mag, axis=0)).sum(axis=1)          # onset strength
    flux = flux - flux.mean()
    ac = np.correlate(flux, flux, "full")[len(flux) - 1:]
    fps = sr / hop
    lo, hi = int(fps * 60 / 180), int(fps * 60 / 60)                # look for a beat between 60 and 180 bpm
    bpm = 60 * fps / (lo + int(np.argmax(ac[lo:hi]))) if hi < len(ac) and hi > lo else 120
    return {
        "secs": round(total / sr, 2),
        "loud": float(np.clip(rms.mean() * 4, 0, 1)),
        "dyn": float(np.clip(rms.std() / (rms.mean() + 1e-9), 0, 1.5)),
        "low": float(power[freqs < 200].sum() / tot),
        "mid": float(power[(freqs >= 200) & (freqs < 4000)].sum() / tot),
        "high": float(power[freqs >= 4000].sum() / tot),
        "bright": float(np.clip(np.sqrt((freqs * power).sum() / tot / 8000), 0, 1)),
        "noise": float(np.clip(np.mean(np.abs(np.diff(np.sign(y)))) / 2 * 6, 0, 1)),
        "bpm": round(float(bpm), 1),
    }


def feed(slug: str, src: Path, name: str) -> dict:
    """Give the creature a track: convert to wav, measure it, remember it."""
    c = _load(slug)
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg is needed to feed creatures. Install it with: brew install ffmpeg")
    stem = re.sub(r"[^\w\- ]+", "_", Path(name).stem)[:60] or "track"
    food = _dir(slug) / "food"
    dst = food / f"{stem}.wav"
    i = 2
    while dst.exists():
        dst = food / f"{stem}-{i}.wav"
        i += 1
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-ar", "48000", "-ac", "2", str(dst)], capture_output=True, text=True)
    if r.returncode != 0 or not dst.exists():
        raise RuntimeError("Could not read that audio file. " + r.stderr.strip()[-200:])
    f = dict(features(dst), name=dst.name, caption="", fed=time.strftime("%Y-%m-%d %H:%M:%S"))
    c["food"].append(f)
    _save(c)
    return _view(c)


def unfeed(slug: str, name: str) -> dict:
    c = _load(slug)
    c["food"] = [f for f in c["food"] if f["name"] != name]
    (_dir(slug) / "food" / Path(name).name).unlink(missing_ok=True)
    _save(c)
    return _view(c)


# ---- training --------------------------------------------------------------
def train(slug: str, opt: dict, before=None) -> dict:
    c = _load(slug)
    if not c["food"]:
        raise RuntimeError("Feed the creature some audio first.")
    py = ENVS_DIR / "ace_step" / "bin" / "python"
    if not (ENVS_DIR / "ace_step" / ".zvoid-installed").exists():
        raise RuntimeError("The ACE-Step engine isn't installed yet. Install it from “engines” first.")
    with _lock:
        if _train["state"] == "running":
            raise RuntimeError(f"“{_train['slug']}” is training right now. One creature at a time.")
        if before:
            before()                                  # free the generation model's memory
        more = max(1, int(opt.get("epochs", 100)))
        fresh = bool(opt.get("fresh"))
        base = 0 if fresh else c["epochs"]
        if fresh:
            shutil.rmtree(_dir(slug) / "lora", ignore_errors=True)
            c["history"], c["epochs"] = [], 0
        run = dict(opt, target_epochs=base + more, style=c.get("style", ""), tag=c.get("tag", ""),
                   captions={f["name"]: f.get("caption", "") for f in c["food"]},
                   save_every=max(1, min(int(opt.get("save_every", 10)), more)))
        run.pop("epochs", None)
        c["sessions"] = c.get("sessions", 0) + 1
        c["settings"] = {k: run[k] for k in ("rank", "lr", "dropout", "max_duration") if k in run}
        _save(c)
        log = open(_dir(slug) / "train.log", "a")
        proc = subprocess.Popen([str(py), "-u", str(ENGINES_DIR / "ace_step" / "gym.py"), str(_dir(slug)), json.dumps(run)],
                                stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1, cwd=str(ROOT))
        _train.update(slug=slug, proc=proc, state="running", msg="waking up…", stage="start", epoch=base, max_epochs=base + more,
                      loss=None, step=0, error=None, started=time.time())
    threading.Thread(target=_watch, args=(slug, proc), daemon=True).start()
    return get(slug)


def _watch(slug: str, proc):
    err = None
    for line in proc.stdout:
        try:
            m = json.loads(line)
        except ValueError:
            continue
        t = m.get("type")
        if t == "stage":
            _train.update(stage=m["stage"], msg=m["msg"])
        elif t == "update":
            kind = m.get("kind")
            if kind == "step":
                _train.update(step=m["step"], loss=m["loss"], epoch=m["epoch"] or _train["epoch"], msg=f"epoch {m['epoch']}/{m['max_epochs']} · loss {m['loss']:.4f}")
            elif kind == "epoch":
                c = _load(slug)
                c["epochs"] = max(c["epochs"], int(m["epoch"]))
                c["history"].append([int(m["epoch"]), round(float(m["loss"]), 5)])
                c["history"] = c["history"][-4000:]
                _save(c)
                _train.update(epoch=int(m["epoch"]), loss=m["loss"])
            elif kind in ("info", "warn", "checkpoint") and _train["stage"] != "train":
                _train.update(msg=m["msg"].replace("[INFO] ", "").replace("[OK] ", "")[:120])
        elif t == "error":
            err = m.get("error", "training failed")
    code = proc.wait()
    stopped = _train.get("state") == "stopping"
    if code != 0 and not stopped and not err:
        err = "Training stopped unexpectedly. See train.log in the creature's folder."
    _train.update(proc=None, state="idle" if (stopped or not err) else "error", error=None if stopped else err,
                  msg="stopped" if stopped else ("failed" if err else "training complete"), stage="")


def stop(slug: str):
    if _train["slug"] == slug and _train["proc"]:
        _train["state"] = "stopping"
        _train["proc"].terminate()


def shutdown():
    if _train.get("proc"):
        _train["proc"].terminate()
