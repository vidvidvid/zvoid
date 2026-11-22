"""The gym: creatures are LoRA adapters for ACE-Step that you raise on your own audio.

creatures/<slug>/
    creature.json     name, style, tag, what it ate (with audio features), training history
    food/             the audio you fed it (converted to wav)
    tensors/          digested food (training tensors)
    lora/             checkpoints/ and final/ (the adapter the ace-step module loads)
"""

from __future__ import annotations

import unicodedata
import json
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from .paths import CREATURES_DIR, ENGINES_DIR, ENVS_DIR, ROOT, UPLOADS_DIR

_lock = threading.Lock()
_train: dict = {"slug": None, "proc": None, "state": "idle", "msg": "", "stage": "", "epoch": 0, "max_epochs": 0,
                "loss": None, "step": 0, "error": None, "started": 0, "audio_secs": 0, "tracks": 0, "from_epoch": 0,
                "epoch_t0": 0, "epoch_time": 0, "step0": 0, "steps_per_epoch": 1, "stage_t0": 0, "first_loss": None}


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


def adapter_path(slug: str) -> Path | None:
    """The newest usable adapter: the final one, or the latest checkpoint if training was paused."""
    lora = _dir(slug) / "lora"
    found = [d for d in [lora / "final", *(lora / "checkpoints").glob("epoch_*")] if (d / "adapter_config.json").exists()]
    return max(found, key=lambda d: (d / "adapter_config.json").stat().st_mtime) if found else None


def _view(c: dict) -> dict:
    slug = c["slug"]
    c = dict(c, trained=adapter_path(slug) is not None,
             minutes=round(sum(f.get("secs", 0) for f in c.get("food", [])) / 60, 2))
    c["training"] = dict({k: v for k, v in _train.items() if k != "proc"}) if _train["slug"] == slug else None
    if c["training"] and c["training"]["state"] == "running":
        tr = c["training"]
        tr["now"] = time.time()                           # lets the window animate smoothly between polls
        if tr["stage"] in ("digest", "start") and not tr.get("remote"):   # on the PC, _remote_count keeps this number
            tr["digested"] = len(list((_dir(slug) / "tensors").glob("*.pt")))
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
    if "tag" in patch:
        regroup(c)
    if "captions" in patch:
        for f in c["food"]:
            if f["name"] in patch["captions"]:
                f["caption"] = str(patch["captions"][f["name"]])[:400]
    _save(c)
    return _view(c)


def breed(a: str, b: str, name: str) -> dict:
    """Breed two trained creatures. The child's adapter is the exact average of its parents' (see engines/ace_step/breed.py),
    it inherits links to all of their food, and it can be trained further like any other creature."""
    pa, pb = adapter_path(a), adapter_path(b)
    if a == b:
        raise ValueError("a creature cannot breed with itself")
    if pa is None or pb is None:
        raise ValueError("both parents must have trained first: an untrained creature has nothing to pass on")
    ca, cb = _load(a), _load(b)
    child = hatch(name or f"{ca['name']} × {cb['name']}")
    slug, d = child["slug"], _dir(child["slug"])
    try:
        py = ENVS_DIR / "ace_step" / "bin" / "python"
        r = subprocess.run([str(py), str(ENGINES_DIR / "ace_step" / "breed.py"), str(pa), str(pb), str(d / "lora" / "final")],
                           capture_output=True, text=True, cwd=str(ROOT))
        last = (r.stdout or "").strip().splitlines()[-1:] or ["{}"]
        try:
            res = json.loads(last[0])
        except ValueError:
            res = {"ok": False, "error": (r.stderr or r.stdout or "the merge failed").strip()[-300:]}
        if not res.get("ok"):
            raise RuntimeError(res.get("error") or "the merge failed")
        c = _load(slug)
        seen = set()
        for parent, pc in ((a, ca), (b, cb)):
            for f in pc["food"]:
                src = (_dir(parent) / "food" / f["name"]).resolve()
                if str(src) in seen or not src.exists():
                    continue
                seen.add(str(src))
                dst = d / "food" / f["name"]
                i = 2
                while dst.exists() or dst.is_symlink():
                    dst = d / "food" / f"{Path(f['name']).stem}-{i}{Path(f['name']).suffix}"
                    i += 1
                dst.symlink_to(src)
                c["food"].append(dict(f, name=dst.name, src=str(src), caption=""))
        c.update(epochs=round((ca.get("epochs", 0) + cb.get("epochs", 0)) / 2), parents=[ca["name"], cb["name"]],
                 style=", ".join(x for x in (ca.get("style"), cb.get("style")) if x)[:300],
                 settings=dict(ca.get("settings") or {}, rank=res.get("rank")))
        regroup(c)
        _save(c)
        return _view(c)
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise


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
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vn", "-ar", "48000", "-ac", "2", str(dst)], capture_output=True, text=True)
    if r.returncode != 0 or not dst.exists():
        raise RuntimeError("Could not read that audio file. " + r.stderr.strip()[-200:])
    f = dict(features(dst), name=dst.name, caption="", fed=time.strftime("%Y-%m-%d %H:%M:%S"))
    c["food"].append(f)
    regroup(c)
    _save(c)
    return _view(c)


LIMB_KEYS = ("low", "bright", "dyn", "noise", "bpm", "loud")


def _describe(m: dict) -> list[str]:
    words = ["sub-heavy" if m["low"] > .6 else "airy" if m["low"] < .25 else "balanced",
             "slow" if m["bpm"] < 95 else "fast" if m["bpm"] > 135 else "mid-tempo",
             "punchy" if m["dyn"] > .6 else "smooth" if m["dyn"] < .3 else "",
             "gritty" if m["noise"] > .45 else "bright" if m["bright"] > .5 else "dark" if m["bright"] < .2 else ""]
    return [w for w in words if w]


def regroup(c: dict):
    """Sort the food into limbs: groups of tracks that sound alike (k-means on the audio features).
    Each limb gets a description and its own trigger word, so one creature can hold several sub-styles."""
    food = [f for f in c["food"] if "low" in f]
    n = len(food)
    k = 1 if n < 6 else int(np.clip(round((n / 2) ** .5), 2, 6))
    for f in c["food"]:
        f["limb"] = 0
    if not n:
        c["limbs"] = []
        return
    X = np.array([[f[key] / (200 if key == "bpm" else 1) for key in LIMB_KEYS] for f in food], dtype=float)
    Z = (X - X.mean(0)) / (X.std(0) + 1e-6)
    cent = [Z[int(np.argmax(Z[:, 0]))]]                       # farthest-point start: same result every time
    while len(cent) < k:
        dist = np.min([((Z - m) ** 2).sum(1) for m in cent], axis=0)
        cent.append(Z[int(np.argmax(dist))])
    cent = np.array(cent)
    for _ in range(25):
        lab = np.argmin(((Z[:, None, :] - cent[None]) ** 2).sum(2), axis=1)
        cent = np.array([Z[lab == j].mean(0) if (lab == j).any() else cent[j] for j in range(k)])
    order = sorted(range(k), key=lambda j: -(lab == j).sum())
    limbs = []
    for new, j in enumerate([j for j in order if (lab == j).any()]):
        idx = np.where(lab == j)[0]
        mean = {key: float(np.mean([food[i][key] for i in idx])) for key in LIMB_KEYS}
        dist = ((Z[idx] - cent[j]) ** 2).sum(1)
        for rank_, i in enumerate(idx[np.argsort(dist)]):
            food[i]["limb"], food[i]["core"] = new, rank_   # core 0 = the most typical track of its limb
        limbs.append({"id": new, "count": int(len(idx)), "tags": _describe(mean), "mean": {a: round(b, 3) for a, b in mean.items()},
                      "trigger": f"{c.get('tag') or c['slug']}-{chr(97 + new)}"})
    c["limbs"] = limbs


def training_set(c: dict, max_tracks: int = 0) -> list[dict]:
    """Which tracks a session trains on. With a budget, take the most typical tracks of every limb, in proportion."""
    food = c["food"]
    if not max_tracks or max_tracks >= len(food):
        return food
    picked = []
    limbs = c.get("limbs") or [{"id": 0, "count": len(food)}]
    for limb in limbs:
        share = max(1, round(max_tracks * limb["count"] / len(food)))
        members = sorted((f for f in food if f.get("limb", 0) == limb["id"]), key=lambda f: f.get("core", 0))
        picked += members[:share]
    return picked[:max_tracks]


def auto_caption(c: dict, f: dict) -> str:
    limbs = c.get("limbs") or []
    limb = next((x for x in limbs if x["id"] == f.get("limb", 0)), None)
    parts = [limb["trigger"] if limb and len(limbs) > 1 else "", c.get("style", ""), ", ".join(limb["tags"]) if limb else ""]
    return f.get("caption") or ", ".join(p for p in parts if p) or Path(f["name"]).stem


VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"}            # videos are fine: only their sound is used
AUDIO_EXT = {".wav", ".aif", ".aiff", ".flac", ".mp3", ".ogg", ".m4a", ".opus"} | VIDEO_EXT


def _probe_secs(f: Path):
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "format=duration", "-of", "csv=p=0", str(f)],
                           capture_output=True, text=True, timeout=8)
        return round(float(r.stdout.strip()), 1)
    except Exception:
        return None


def scan(folder: str) -> dict:
    """List the audio in a folder (and its subfolders) so the user can choose what to feed."""
    root = Path(folder).expanduser().resolve()
    home = Path.home().resolve()
    if not root.is_dir() or not (home in root.parents or root == home or str(root).startswith("/Volumes/")):
        raise ValueError("Pick a folder inside your home folder or on an external drive.")
    files = []
    for f in sorted(root.rglob("*")):
        if len(files) >= 3000:
            break
        if f.suffix.lower() not in AUDIO_EXT or not f.is_file() or any(part.startswith(".") for part in f.relative_to(root).parts):
            continue
        try:
            info = sf.info(str(f))
            secs = round(info.frames / info.samplerate, 1)
        except Exception:
            secs = _probe_secs(f)
            if secs is None and f.suffix.lower() in VIDEO_EXT:
                continue                                 # a video with no sound in it
        rel = f.relative_to(root)
        files.append({"path": str(f), "rel": str(rel), "group": rel.parts[0] if len(rel.parts) > 1 else "", "secs": secs,
                      "mb": round(f.stat().st_size / 1e6, 1), "video": f.suffix.lower() in VIDEO_EXT})
    return {"folder": str(root), "name": root.name, "files": files}


def feed_links(slug: str, paths: list[str]) -> dict:
    """Feed files where they are: the creature keeps a link, not a copy. Returns the creature plus what was skipped."""
    c = _load(slug)
    food = _dir(slug) / "food"
    known = {f.get("src") for f in c["food"]}
    skipped = []
    for raw in paths:
        src = Path(raw).expanduser().resolve()
        if str(src) in known:
            continue
        if not src.is_file() or src.suffix.lower() not in AUDIO_EXT:
            skipped.append(src.name)
            continue
        stem = re.sub(r"[^\w\- ]+", "_", src.stem)[:60] or "track"
        try:
            sf.info(str(src))
            dst = food / f"{stem}{src.suffix.lower()}"
            i = 2
            while dst.exists() or dst.is_symlink():
                dst = food / f"{stem}-{i}{src.suffix.lower()}"
                i += 1
            dst.symlink_to(src)
            feats = features(dst)
        except Exception:
            try:                                        # a format we can't read directly: fall back to a converted copy
                _save(c)
                c = _load(slug) if feed(slug, src, src.name) else c
                c["food"][-1]["src"] = str(src)
                known.add(str(src))
            except Exception:
                skipped.append(src.name)
            continue
        c["food"].append(dict(feats, name=dst.name, caption="", src=str(src), fed=time.strftime("%Y-%m-%d %H:%M:%S")))
        known.add(str(src))
    regroup(c)
    _save(c)
    return dict(_view(c), skipped=skipped)


def _cut(src: Path, start: float, secs: float, sr: int = 44100) -> np.ndarray:
    """A stretch of any audio or video file, as stereo samples."""
    r = subprocess.run(["ffmpeg", "-v", "error", "-ss", f"{max(0, start):.3f}", "-t", f"{secs:.3f}", "-i", str(src), "-vn", "-ac", "2", "-ar", str(sr), "-f", "f32le", "-"],
                       capture_output=True)
    return np.frombuffer(r.stdout[:len(r.stdout) // 8 * 8], dtype="<f4").reshape(-1, 2).copy()


def seed(slug: str, limb=None, dur: float = 14.0, mode: str = "", track: str = "") -> dict:
    """What the creature sings from: a passage of one of its own tracks, different every time. ACE-Step then plays it back
    through what the creature has learned, so a song starts from its food and not from a list of words.

    "groove": one or two bars of a track, cut on a hit and looped, with small breaks and fills, and sometimes a short
    figure from another track of the same limb laid over it. It stays one coherent pattern: a first version that cut
    many pieces at random and pitched them came out as disconnected noodling.
    "slice": one unbroken passage, as it is."""
    c = _load(slug)
    d = _dir(slug)
    food = [f for f in c["food"] if (d / "food" / f["name"]).exists()]
    mine = [f for f in food if limb is None or f.get("limb", 0) == limb] or food
    if not mine:
        raise RuntimeError("its tracks are gone (were the originals moved?)")
    rng = np.random.default_rng()
    sr, n = 44100, int(dur * 44100)
    mode = mode if mode in ("groove", "slice") else ("groove" if rng.random() < .7 else "slice")

    def passage(f, secs, tries=4):
        """The loudest of a few random stretches of a track, starting on its strongest hit."""
        L, best = float(f.get("secs") or 60), None
        for _ in range(tries):
            x = _cut(d / "food" / f["name"], rng.uniform(L * .08, max(L * .1, L * .92 - secs - 1)), secs + 1.0)
            if len(x) < sr * (secs + .2):
                continue
            h = 441                                              # 10 ms frames
            e = np.sqrt((x[:sr].mean(1)[:sr // h * h].reshape(-1, h) ** 2).mean(1))
            k = int(np.argmax(np.diff(e, prepend=e[0]))) * h     # where the level jumps most in the first second
            x = x[max(0, k - 220):][:int(secs * sr)]
            lv = float(np.sqrt((x ** 2).mean()))
            if len(x) >= int(secs * sr) - 2 and (best is None or lv > best[1]):
                best = (x, lv)
        return best[0] if best else None

    def edge(x, ms=5):
        k = min(len(x) // 2, int(sr * ms / 1000))
        if k:
            x[:k] *= np.linspace(0, 1, k)[:, None]
            x[-k:] *= np.linspace(1, 0, k)[:, None]
        return x

    f = next((x for x in food if x["name"] == track), None) if track else None      # a track you chose, or one of the limb's at random
    if track and not f:
        raise FileNotFoundError("that track is gone (was the original moved?)")
    if f:
        mine = [x for x in food if x.get("limb", 0) == f.get("limb", 0)] or food
    f = f or mine[int(rng.integers(len(mine)))]
    bpm = float(np.clip(f.get("bpm") or 120, 70, 180))
    beat = 60 / bpm
    used, moves = [f["name"]], []
    if mode == "slice":
        x = passage(f, dur)
        if x is None:
            raise RuntimeError("could not read its tracks")
        out = edge(x.copy(), 30)
        moves.append("one unbroken passage")
    else:
        bars = int(rng.choice([1, 2, 2, 4]))
        unit = beat * 4 * bars
        loop = passage(f, unit)
        if loop is None:
            raise RuntimeError("could not read its tracks")
        loop = edge(loop.copy())
        m, b = len(loop), int(beat * sr)
        out = np.zeros((n, 2), "float32")
        moves.append(f"a {bars}-bar loop")
        for r in range(int(np.ceil(n / m))):
            x = loop.copy()
            u = rng.random()
            if r and u < .22:                                    # a fill: the last beat becomes a stutter of the loop's first hit
                k = b // int(rng.choice([2, 4, 4, 8]))
                x[-b:] = np.concatenate([edge(loop[:k].copy(), 3)] * int(np.ceil(b / k)))[:b]
                moves.append("stutter fill")
            elif r and u < .36:                                  # a break: half a bar of silence
                x[-2 * b:] = 0
                moves.append("break")
            elif r and u < .46:                                  # the last beat turned round
                x[-b:] = edge(x[-b:][::-1].copy())
                moves.append("reversed beat")
            seg = out[r * m:(r + 1) * m]
            seg += x[:len(seg)]
        others = [g for g in mine if g["name"] != f["name"]]
        if others and rng.random() < .4:                         # a short figure from a sister track, repeating over it
            g = others[int(rng.integers(len(others)))]
            fig = passage(g, beat * float(rng.choice([1, 2, 2, 4])), tries=3)
            if fig is not None:
                if rng.random() < .25:                           # an octave down
                    idx = np.arange(0, len(fig) - 1, .5)
                    fig = np.stack([np.interp(idx, np.arange(len(fig)), fig[:, ch]) for ch in (0, 1)], 1).astype("float32")
                fig, every, gain = edge(fig.copy()), int(beat * 4 * int(rng.choice([1, 2])) * sr), float(rng.uniform(.3, .55))
                for i0 in range(int(rng.choice([0, 2])) * b, n, every):
                    seg = out[i0:i0 + len(fig)]
                    seg += fig[:len(seg)] * gain
                used.append(g["name"])
                moves.append("a figure from another track")
    pk = float(np.abs(out).max())
    if pk < 1e-4:
        raise RuntimeError("could not read its tracks")
    out = np.tanh(out / pk * 1.2) / np.tanh(1.2) * .9
    k = int(.05 * sr)
    out[-k:] *= np.linspace(1, 0, k)[:, None]
    sd = UPLOADS_DIR / "seeds"                                # with the other input audio, where the engines are allowed to read
    sd.mkdir(parents=True, exist_ok=True)
    for old in sorted(sd.glob(f"{slug}_seed_*.wav"))[:-6]:
        old.unlink(missing_ok=True)
    path = sd / f"{slug}_seed_{time.strftime('%Y%m%d-%H%M%S')}_{int(rng.integers(1000)):03d}.wav"
    sf.write(path, out, sr, subtype="PCM_16")
    return {"path": str(path), "tracks": used, "moves": moves, "bpm": round(bpm), "mode": mode}


def grain(slug: str, name: str) -> Path:
    """A mono excerpt of a fed track: up to a minute of it, unbroken, from a fifth of the way in. The creature's own voice
    is made of these, and dragging along a limb scrubs through one, so it has to be continuous."""
    d = _dir(slug)
    src = d / "food" / Path(name).name
    if not src.exists():
        raise FileNotFoundError("that track is gone (was the original moved?)")
    out = d / "grains" / (src.stem + ".m60.wav")
    if out.exists() and out.stat().st_size > 1000:
        return out
    out.parent.mkdir(exist_ok=True)
    secs = next((f.get("secs") for f in _load(slug).get("food", []) if f.get("name") == src.name), None) or _probe_secs(src) or 60
    start = 0 if secs < 75 else secs * .2
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.2f}", "-t", "60", "-i", str(src), "-vn", "-ac", "1", "-ar", "22050", str(out)],
                       capture_output=True, text=True)
    if r.returncode or not out.exists():
        raise RuntimeError("could not read that track: " + (r.stderr or "").strip()[-200:])
    return out


def unfeed(slug: str, name: str) -> dict:
    c = _load(slug)
    c["food"] = [f for f in c["food"] if f["name"] != name]
    (_dir(slug) / "food" / Path(name).name).unlink(missing_ok=True)
    regroup(c)
    _save(c)
    return _view(c)


# ---- a second machine: train on a PC with an Nvidia card, over SSH ----------------------------
# remote.json in the project folder (never committed) says where it is:
#   {"host": "10.0.1.10", "user": "me", "key": "~/.ssh/zvoid_pc", "dir": "zvoid", "name": "PC · RTX 4080"}
# The PC needs the folder set up once (uv, ACE-Step, the model); see scripts/remote/.
REMOTE_FILE = ROOT / "remote.json"
_remote_seen = {"t": 0.0, "status": None}


def remote() -> dict | None:
    try:
        r = json.loads(REMOTE_FILE.read_text())
        return dict(r, dir=r.get("dir") or "zvoid", name=r.get("name") or r["host"], key=str(Path(r.get("key", "~/.ssh/id_ed25519")).expanduser()))
    except Exception:
        return None


def _ssh_base(r: dict) -> list[str]:
    return ["ssh", "-i", r["key"], "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-o", "LogLevel=ERROR", "-o", "ServerAliveInterval=20", f"{r['user']}@{r['host']}"]


def _ps(r: dict, script: str, timeout: float = 60) -> str:
    """Run one line of PowerShell on the PC and return what it printed."""
    script = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " + script     # file names with č, š, ž or curly quotes must arrive readable
    out = subprocess.run(_ssh_base(r) + ["powershell -NoProfile -Command \"" + script.replace('"', "'") + "\""], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout or "the PC did not answer").strip()[-300:])
    return out.stdout


def remote_status(fresh: bool = False) -> dict:
    r = remote()
    if not r:
        return {"configured": False}
    if not fresh and _remote_seen["status"] and time.time() - _remote_seen["t"] < 25:
        return _remote_seen["status"]
    st = {"configured": True, "name": r["name"], "host": r["host"], "reachable": False, "gpu": ""}
    try:
        out = subprocess.run(_ssh_base(r) + ["nvidia-smi --query-gpu=name,memory.total --format=csv,noheader"], capture_output=True, text=True, timeout=9)
        if out.returncode == 0 and out.stdout.strip():
            st.update(reachable=True, gpu=out.stdout.strip().splitlines()[0])
    except Exception:
        pass
    _remote_seen.update(t=time.time(), status=st)
    return st


def _tar_to(r: dict, local_dir: Path, names: list[str], remote_dir: str):
    """Send files or folders to the PC (links are followed, so linked tracks arrive as real files)."""
    a = subprocess.Popen(["tar", "-chf", "-", "-C", str(local_dir), *names], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    b = subprocess.run(_ssh_base(r) + [f"tar -xf - -C {remote_dir}"], stdin=a.stdout, capture_output=True, text=True)
    a.wait()
    if a.returncode or b.returncode:
        raise RuntimeError("could not send files to the PC: " + (b.stderr or "").strip()[-200:])


def _remote_prepare(slug: str, run: dict, r: dict, fresh: bool):
    """Mirror what this session needs onto the PC: the runner, the tracks, the newest checkpoint and the options."""
    base, d = f"{r['dir']}\\app", _dir(slug)
    cdir = f"{base}\\creatures\\{slug}"
    _ps(r, f"New-Item -ItemType Directory -Force -Path {base}\\engines\\ace_step, {cdir}\\food | Out-Null; Remove-Item -Recurse -Force {cdir}\\lora -ErrorAction SilentlyContinue; "
           f"New-Item -ItemType Directory -Force -Path {cdir}\\lora\\checkpoints | Out-Null")
    _tar_to(r, ENGINES_DIR / "ace_step", ["gym.py", "breed.py"], f"{base}\\engines\\ace_step")
    _tar_to(r, ROOT / "scripts" / "remote", ["run_gym.ps1"], base)
    have = {}
    for line in _ps(r, f"Get-ChildItem {cdir}\\food | ForEach-Object {{ $_.Name + '|' + $_.Length }}").splitlines():
        if "|" in line:
            n, _, sz = line.strip().rpartition("|")
            have[unicodedata.normalize("NFC", n)] = int(sz) if sz.strip().isdigit() else 0
    need = [n for n in run["only"] if (d / "food" / n).exists() and have.get(unicodedata.normalize("NFC", n)) != (d / "food" / n).stat().st_size]
    if need:
        _train.update(msg=f"sending {len(need)} track{'s' if len(need) != 1 else ''} to {r['name']}…")
        _tar_to(r, d / "food", need, f"{cdir}\\food")
    if not fresh:
        cps = [(int(p.name.split("_")[1]), p) for p in (d / "lora" / "checkpoints").glob("epoch_*") if p.name.split("_")[1].isdigit()]
        if cps:
            _train.update(msg=f"sending what it has learned so far to {r['name']}…")
            _tar_to(r, d / "lora" / "checkpoints", [max(cps)[1].name], f"{cdir}\\lora\\checkpoints")
    tmp = d / "opt.remote.json"
    tmp.write_text(json.dumps(run, ensure_ascii=False), encoding="utf-8")
    _tar_to(r, d, [tmp.name], cdir)
    _ps(r, f"Move-Item -Force {cdir}\\{tmp.name} {cdir}\\opt.json")
    tmp.unlink(missing_ok=True)


def _remote_fetch(slug: str, r: dict):
    """Bring back the newest checkpoint and the finished adapter, then leave only that checkpoint on the PC."""
    cdir, lora = f"{r['dir']}\\app\\creatures\\{slug}", _dir(slug) / "lora"
    names = [x.strip() for x in _ps(r, f"Get-ChildItem {cdir}\\lora\\checkpoints -Directory | ForEach-Object {{ $_.Name }}").splitlines() if x.strip().startswith("epoch_")]
    cps = sorted((int(n.split("_")[1]), n) for n in names if n.split("_")[1].isdigit())
    has_final = "yes" in _ps(r, f"if (Test-Path {cdir}\\lora\\final\\adapter_config.json) {{ 'yes' }}")
    want = (["final"] if has_final else []) + ([f"checkpoints/{cps[-1][1]}"] if cps else [])
    if not want:
        return None
    (lora / "checkpoints").mkdir(parents=True, exist_ok=True)
    if has_final and (lora / "final").exists():
        shutil.rmtree(lora / "final")
    a = subprocess.Popen(_ssh_base(r) + [f"tar -cf - -C {cdir}\\lora " + " ".join(want)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    b = subprocess.run(["tar", "-xf", "-", "-C", str(lora)], stdin=a.stdout, capture_output=True, text=True)
    a.wait()
    if a.returncode or b.returncode:
        raise RuntimeError("could not bring the result back from the PC")
    try:
        _remote_stages(slug, r, cps)
    except Exception:
        pass                                           # hearing its stages later is a nicety: never let it block bringing the result home
    for _, n in cps[:-1]:
        _ps(r, f"Remove-Item -Recurse -Force {cdir}\\lora\\checkpoints\\{n}")
    return cps[-1][0] if cps else None


def stage_dirs(slug: str) -> dict:
    """The creature as it was at earlier points of its training: epoch -> a folder holding that adapter."""
    d, out = _dir(slug), {}
    for p in list((d / "lora" / "checkpoints").glob("epoch_*")) + list((d / "stages").glob("epoch_*")):
        n = p.name.split("_")[1] if p.is_dir() else ""
        if n.isdigit() and (p / "adapter_config.json").exists() and (p / "adapter_model.safetensors").exists():
            out[int(n)] = p
    return out


def _remote_stages(slug: str, r: dict, cps: list):
    """Before the PC's older checkpoints are cleared, keep a few of them (the adapter only) so the time-lapse can let you hear how it learned."""
    if len(cps) < 2:
        return
    cdir, st = f"{r['dir']}\\app\\creatures\\{slug}", _dir(slug) / "stages"
    st.mkdir(exist_ok=True)
    pick = sorted({cps[round(i * (len(cps) - 2) / 6)] for i in range(7)} if len(cps) > 8 else set(cps[:-1]))
    pick = [(e, n) for e, n in pick if not (st / f"epoch_{e}").exists() and not (st / f"epoch_{e}.wav").exists()]
    if not pick:
        return
    want = " ".join(f"{n}/adapter_config.json {n}/adapter_model.safetensors" for _, n in pick)
    a = subprocess.Popen(_ssh_base(r) + [f"tar -cf - -C {cdir}\\lora\\checkpoints " + want], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    b = subprocess.run(["tar", "-xf", "-", "-C", str(st)], stdin=a.stdout, capture_output=True, text=True)
    a.wait()
    for e, n in pick:
        if (st / n).is_dir():
            (st / n).rename(st / f"epoch_{e}")


def _remote_kill(r: dict):
    try:
        _ps(r, "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match 'gym.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }", timeout=20)
    except Exception:
        pass


# ---- training --------------------------------------------------------------
def train(slug: str, opt: dict, before=None) -> dict:
    c = _load(slug)
    if not c["food"]:
        raise RuntimeError("Feed the creature some audio first.")
    py = ENVS_DIR / "ace_step" / "bin" / "python"
    far = remote() if opt.get("where") == "pc" else None
    if opt.get("where") == "pc":
        if not far or not remote_status(True).get("reachable"):
            raise RuntimeError("The PC is not reachable right now. Check that it is on and on the same network, or train on this Mac.")
    elif not (ENVS_DIR / "ace_step" / ".zvoid-installed").exists():
        raise RuntimeError("The ACE-Step engine isn't installed yet. Install it from “engines” first.")
    with _lock:
        if _train["state"] == "running":
            raise RuntimeError(f"“{_train['slug']}” is training right now. One creature at a time.")
        if before:
            before(far is not None)                   # free the generation model's memory on the machine that is about to train
        more = max(1, int(opt.get("epochs", 100)))
        fresh = bool(opt.get("fresh"))
        lora = _dir(slug) / "lora"
        if not fresh and not any((lora / "checkpoints").glob("epoch_*")) and c["epochs"]:
            c["history"], c["epochs"] = [], 0          # an earlier session died before its first checkpoint: nothing to resume
        if not fresh:
            saved = [int(p.name.split("_")[1]) for p in (lora / "checkpoints").glob("epoch_*") if p.name.split("_")[1].isdigit()]
            if saved and c["epochs"] > max(saved):     # it was stopped between two checkpoints: training resumes from the last one saved,
                c["epochs"] = max(saved)               # so the epochs after it do not count
                c["history"] = [h for h in c["history"] if h[0] <= max(saved)]
        base = 0 if fresh else c["epochs"]
        if fresh:
            shutil.rmtree(_dir(slug) / "lora", ignore_errors=True)
            c["history"], c["epochs"] = [], 0
        if "limbs" not in c:
            regroup(c)
        chosen = training_set(c, int(opt.get("max_tracks") or 0))
        maxd = float(opt.get("max_duration", 240))
        audio_secs = sum(min(f.get("secs", 0), maxd) for f in chosen)
        run = dict(opt, target_epochs=base + more, style=c.get("style", ""), tag=c.get("tag", ""),
                   only=[f["name"] for f in chosen], captions={f["name"]: auto_caption(c, f) for f in chosen},
                   save_every=max(1, min(int(opt.get("save_every", 5)), more)))
        run.pop("epochs", None)
        run.pop("where", None)
        if far:                                        # an Nvidia card trains in half precision; epochs are quick there, so save less often
            want, end = min(10, max(5, more // 4)), base + more   # checkpoints land on multiples, so pick one that also lands on the last epoch
            fits = [d for d in range(max(2, want // 2), want * 2 + 1) if end % d == 0]
            run.update(precision="bf16", device="cuda", save_every=min(fits, key=lambda d: abs(d - want)) if fits else want)
        c["sessions"] = c.get("sessions", 0) + 1
        c["settings"] = {k: run[k] for k in ("rank", "lr", "dropout", "max_duration") if k in run}
        _save(c)
        log = open(_dir(slug) / "train.log", "a")
        proc = None if far else subprocess.Popen([str(py), "-u", str(ENGINES_DIR / "ace_step" / "gym.py"), str(_dir(slug)), json.dumps(run)],
                                                 stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1, cwd=str(ROOT))
        _train.update(slug=slug, proc=proc, state="running", msg=f"reaching {far['name']}…" if far else "waking up…", stage="start", epoch=base, max_epochs=base + more,
                      remote=far["name"] if far else "", digested=0,
                      loss=None, step=0, error=None, started=time.time(), audio_secs=audio_secs, tracks=len(chosen), from_epoch=base,
                      epoch_t0=0, epoch_time=0, step0=0, stage_t0=time.time(), first_loss=None,
                      steps_per_epoch=max(1, -(-len(chosen) // (int(run.get("batch_size", 1)) * int(run.get("grad_accum", 4))))))
    if far:
        threading.Thread(target=_remote_session, args=(slug, run, far, fresh, log), daemon=True).start()
    else:
        threading.Thread(target=_watch, args=(slug, proc), daemon=True).start()
    return get(slug)


def _remote_session(slug: str, run: dict, far: dict, fresh: bool, log):
    """One training session on the PC: send what it needs, run it there, read its progress, bring the result back."""
    try:
        _remote_prepare(slug, run, far, fresh)
        if _train.get("state") == "stopping":
            _train.update(proc=None, state="idle", error=None, msg="stopped", stage="")
            return
        proc = subprocess.Popen(_ssh_base(far) + [f"powershell -NoProfile -ExecutionPolicy Bypass -File {far['dir']}\\app\\run_gym.ps1 -Slug {slug}"],
                                stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1)
        _train.update(proc=proc)
    except Exception as ex:
        _train.update(proc=None, state="error", error=f"Could not start on the PC: {ex}", msg="failed", stage="")
        return
    threading.Thread(target=_remote_count, args=(slug, proc, far), daemon=True).start()
    _watch(slug, proc, far)


def _remote_count(slug: str, proc, far: dict):
    """While the PC turns tracks into training data, ask it now and then how many are done."""
    while proc.poll() is None and _train.get("stage") in ("start", "digest"):
        try:
            n = _ps(far, f"(Get-ChildItem {far['dir']}\\app\\creatures\\{slug}\\tensors -Filter *.pt -ErrorAction SilentlyContinue | Measure-Object).Count", timeout=15).strip()
            if n.isdigit():
                _train["digested"] = int(n)
        except Exception:
            pass
        time.sleep(4)


def _watch(slug: str, proc, far: dict | None = None):
    err = None
    for line in proc.stdout:
        try:
            m = json.loads(line)
        except ValueError:
            continue
        t = m.get("type")
        if t == "stage":
            _train.update(stage=m["stage"], msg=m["msg"], stage_t0=time.time())
            if m["stage"] == "train":
                _train.update(epoch_t0=time.time(), step0=0)
        elif t == "update":
            kind = m.get("kind")
            if kind == "step":
                if _train["first_loss"] is None:
                    _train["first_loss"] = m["loss"]
                _train.update(step=m["step"], loss=m["loss"], msg=f"epoch {m['epoch']}/{m['max_epochs']} · loss {m['loss']:.4f}")
            elif kind == "epoch":
                c = _load(slug)
                c["epochs"] = max(c["epochs"], int(m["epoch"]))
                c["history"].append([int(m["epoch"]), round(float(m["loss"]), 5)])
                c["history"] = c["history"][-4000:]
                if m.get("epoch_time") and _train.get("audio_secs"):   # how fast this Mac really trains, for honest estimates
                    pace, key = float(m["epoch_time"]) / _train["audio_secs"], "pace_pc" if far else "pace"
                    c[key] = round(pace if not c.get(key) else c[key] * .7 + pace * .3, 5)
                _save(c)
                _train.update(epoch=int(m["epoch"]), loss=m["loss"], epoch_t0=time.time(), step0=_train["step"],
                              epoch_time=float(m.get("epoch_time") or 0) or _train["epoch_time"])
            elif kind in ("info", "warn", "checkpoint") and _train["stage"] != "train":
                _train.update(msg=m["msg"].replace("[INFO] ", "").replace("[OK] ", "")[:120])
        elif t == "error":
            err = m.get("error", "training failed")
    code = proc.wait()
    stopped = _train.get("state") == "stopping"
    if code != 0 and not stopped and not err:
        err = "Training stopped unexpectedly. See train.log in the creature's folder." if not far else "Training on the PC stopped unexpectedly (see train_err.log in the creature's folder on the PC)."
    if far:                                            # whatever happened, bring back what was saved there
        try:
            _train.update(msg=f"bringing it back from {far['name']}…")
            got = _remote_fetch(slug, far)
            c = _load(slug)
            if stopped or err:                         # an unfinished session counts up to its last saved checkpoint
                kept = got if got is not None else max([int(p.name.split("_")[1]) for p in (_dir(slug) / "lora" / "checkpoints").glob("epoch_*") if p.name.split("_")[1].isdigit()], default=0)
                c["epochs"] = kept
                c["history"] = [h for h in c["history"] if h[0] <= kept]
                _save(c)
        except Exception as ex:
            err = err or f"Trained on the PC, but could not bring the result back: {ex}"
    _train.update(proc=None, state="idle" if (stopped or not err) else "error", error=None if stopped else err,
                  msg="stopped" if stopped else ("failed" if err else "training complete"), stage="")


def stop(slug: str):
    if _train["slug"] == slug and _train["state"] == "running":
        _train["state"] = "stopping"
        far = remote() if _train.get("remote") else None
        if far:
            _remote_kill(far)                          # ending the connection alone would leave it running on the PC
        if _train["proc"]:
            _train["proc"].terminate()


def shutdown():
    if _train.get("proc"):
        _train["proc"].terminate()
