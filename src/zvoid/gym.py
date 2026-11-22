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
    try:
        pop = _population()
        c["rel"] = pop.get("rel", {}).get(slug) or {}
        if not c.get("look"):
            c["look"] = (json.loads((_dir(slug) / "creature.json").read_text()).get("look")) if pop.get("ready") else None
        c["finger"] = finger(slug)
    except Exception:
        c["rel"], c["finger"] = {}, []
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
        lineage(_load(slug))
        return _view(_load(slug))
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
    y2, _ = sf.read(str(wav), start=max(0, (total - n) // 2), frames=n, dtype="float32", always_2d=True)
    y = y2.mean(axis=1)
    if len(y) < 2048:
        return {"secs": round(total / sr, 2), "fv": FEATURES_V}
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
    # what genre is made of (version 2): these tell a band from a beat-maker where the six numbers below cannot
    more = {}
    try:
        band = (freqs >= 200) & (freqs < 5000)
        P = mag[:, band] ** 2 + 1e-10
        loudf = rms > rms.mean() * .5                                            # judge the frames where something is playing
        flat = np.exp(np.log(P).mean(axis=1)) / P.mean(axis=1)
        more["tonal"] = float(np.clip(1 - np.sqrt(flat[loudf].mean()) * 1.8, 0, 1))                       # clear pitches (1) or noise and hits (0)
        raw = np.lib.stride_tricks.sliding_window_view(y, win)[::hop]
        crest = 20 * np.log10(np.abs(raw).max(axis=1)[loudf] / (np.sqrt((raw ** 2).mean(axis=1))[loudf] + 1e-9) + 1e-9)
        more["dist"] = float(np.clip((15 - crest.mean()) / 9, 0, 1))                                      # squashed and distorted (1) or open and dynamic (0)
        more["steady"] = float(np.clip((ac[lo:hi].max() / (ac[0] + 1e-9) - .15) / .6, 0, 1)) if hi < len(ac) and hi > lo else .3   # a beat like a machine (1) or loose (0)
        cb = (freqs >= 80) & (freqs < 2000)
        pc = (np.round(12 * np.log2(freqs[cb] / 440.0)) % 12).astype(int)
        chroma = np.stack([(mag[:, cb][:, pc == k] ** 2).sum(axis=1) for k in range(12)], axis=1)
        avg = chroma[loudf].mean(axis=0)
        avg = avg / (avg.sum() + 1e-12)
        more["harm"] = float(np.clip((-(avg * np.log(avg + 1e-12)).sum() / np.log(12) - .7) / .28, 0, 1))  # few notes (0) or all twelve (1)
        env = np.sqrt((mag[:, (freqs >= 300) & (freqs < 3400)] ** 2).sum(axis=1))
        env = env - env.mean()
        ms = np.abs(np.fft.rfft(env * np.hanning(len(env)))) ** 2
        mf = np.fft.rfftfreq(len(env), 1 / fps)
        more["voice"] = float(np.clip(ms[(mf >= 3) & (mf < 8)].sum() / (ms[(mf >= .5) & (mf < 20)].sum() + 1e-12) * 2.2, 0, 1))   # the mid band moves at the speed of syllables
        fx_ = np.maximum(0, np.diff(mag, axis=0)).sum(axis=1)
        more["attack"] = float(np.clip(np.percentile(fx_, 97) / (np.median(fx_) + 1e-9) / 14, 0, 1))      # sharp hits (1) or everything swells (0)
        cen = (mag * freqs).sum(axis=1) / (mag.sum(axis=1) + 1e-9)
        more["change"] = float(np.clip(cen[loudf].std() / (cen[loudf].mean() + 1e-9) * 1.6, 0, 1))        # the colour of the sound keeps changing (1) or holds (0)
        if y2.shape[1] >= 2:
            mid_, side = (y2[:, 0] + y2[:, 1]) / 2, (y2[:, 0] - y2[:, 1]) / 2
            more["wide"] = float(np.clip(np.sqrt((side ** 2).mean()) / (np.sqrt((mid_ ** 2).mean()) + 1e-9) * 1.6, 0, 1))
        else:
            more["wide"] = 0.0
        more = {k: (round(v, 4) if np.isfinite(v) else .3) for k, v in more.items()}
    except Exception:
        more = {}
    return {
        "fv": FEATURES_V, **more,
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


def remeasure():
    """Tracks fed before the newer measurements existed are measured again, quietly, one creature at a time."""
    for f in sorted(CREATURES_DIR.glob("*/creature.json")):
        try:
            c = json.loads(f.read_text())
            todo = [x["name"] for x in c.get("food", []) if x.get("fv") != FEATURES_V]
            if not todo:
                continue
            new = {}
            for name in todo:
                src = _dir(c["slug"]) / "food" / name
                try:
                    new[name] = {k: v for k, v in features(src).items() if k in EXTRA_KEYS or k == "fv"} if src.exists() else {"fv": FEATURES_V}
                except Exception:
                    new[name] = {"fv": FEATURES_V}
            with _lock:                                       # merge into whatever the file holds by now: it may have been trained or fed meanwhile
                c = json.loads(f.read_text())
                for x in c.get("food", []):
                    if x["name"] in new:
                        x.update(new[x["name"]])
                _save(c)
        except Exception as ex:
            print(f"[gym] could not re-measure {f.parent.name}: {ex}", flush=True)
    _pop.clear()


def finger(slug: str) -> list[float]:
    """A fingerprint of what a creature has learned: eight numbers read from the adapter itself (how strongly each depth
    of the model was changed, and how). Two creatures fed alike still differ here, and it shifts as one trains on."""
    ad = adapter_path(slug)
    f = ad / "adapter_model.safetensors" if ad else None
    if not f or not f.exists():
        return []
    key = (str(f), f.stat().st_mtime)
    if _fingers.get(slug, (None,))[0] == key:
        return _fingers[slug][1]
    out = []
    try:
        with open(f, "rb") as fh:
            n = int.from_bytes(fh.read(8), "little")
            head = json.loads(fh.read(n))
            base = 8 + n
            norms = []
            for name, t in sorted(head.items()):
                if name == "__metadata__" or "lora_B" not in name:
                    continue
                a, b = t["data_offsets"]
                fh.seek(base + a)
                raw = fh.read(b - a)
                dt = t["dtype"]
                x = (np.frombuffer(raw, "<f4") if dt == "F32" else np.frombuffer(raw, "<f2").astype("f4") if dt == "F16"
                     else (np.frombuffer(raw, "<u2").astype("<u4") << 16).view("<f4") if dt == "BF16" else None)
                if x is not None and len(x):
                    norms.append((float(np.sqrt((x.astype("f8") ** 2).mean())), float(np.abs(x).max())))
        if norms:
            v = np.array([a for a, _ in norms])
            parts = np.array([p.mean() for p in np.array_split(v, 6)])                 # from the model's first layers to its last
            parts = (parts - parts.min()) / (parts.max() - parts.min() + 1e-12)   # its own profile: where it changed most and least
            peaky = float(np.clip(np.mean([m / (a + 1e-12) for a, m in norms]) / 12, 0, 1))
            out = [round(float(x), 4) for x in [*parts, float(np.clip(np.log10(v.mean() + 1e-9) / 3 + 1.1, 0, 1)), peaky]]
    except Exception:
        out = []
    _fingers[slug] = (key, out)
    return out


PLANS = ("vertebrate", "bloom", "shell", "coral", "crystal", "medusa")
_pop: dict = {}


def _population() -> dict:
    """How every creature measures, next to the others. A trait only says something when it is compared: all four of the
    first creatures had almost the same bass and brightness, so the differences that exist are stretched to the full range."""
    if _pop and time.time() - _pop.get("at", 0) < 8:
        return _pop
    cs = []
    for f in sorted(CREATURES_DIR.glob("*/creature.json")):
        try:
            cs.append(json.loads(f.read_text()))
        except Exception:
            continue
    cs.sort(key=lambda c: c.get("born", ""))
    keys = (*LIMB_KEYS, *EXTRA_KEYS)
    means = {}
    for c in cs:
        food = [x for x in c.get("food", []) if "low" in x]
        w = np.array([x.get("secs") or 1 for x in food], float)
        means[c["slug"]] = {k: float(np.average([x.get(k, .3 if k != "bpm" else 110) for x in food], weights=w)) for k in keys} if food else None
    have = [m for m in means.values() if m]
    rel = {}
    for slug, m in means.items():
        if not m:
            rel[slug] = {}
            continue
        r = {}
        for k in keys:
            vals = np.array([x[k] for x in have])
            sd = vals.std()
            z = (m[k] - vals.mean()) / sd if len(have) >= 3 and sd > 1e-6 else 0.0
            absolute = float(np.clip((m[k] - 60) / 120 if k == "bpm" else m[k], 0, 1))
            r[k] = round(float(np.clip(.5 + z * .32, 0, 1)) * .75 + absolute * .25 if len(have) >= 3 else absolute, 3)   # mostly how it compares, a little of what it is
        rel[slug] = r
    # a species and a colour, given once and kept: who a creature is should not flip when another one hatches
    ready = all(x.get("fv") == FEATURES_V for c in cs for x in c.get("food", []))
    if ready:
        used_plans = [c["look"]["plan"] for c in cs if c.get("look")]
        used_hues = [c["look"]["hue"] for c in cs if c.get("look")]
        for c in cs:
            r = rel.get(c["slug"])
            if c.get("look") or not r:
                continue
            g = lambda k: r.get(k, .5)
            h = int.from_bytes(c["slug"].encode()[:4].ljust(4, b"z"), "little") % 1000 / 1000
            score = [g("steady") * .6 + (1 - g("tonal")) * .3 + g("low") * .3,                       # vertebrate: driven by a beat
                     g("tonal") * .5 + g("wide") * .4 + (1 - g("dist")) * .3,                        # bloom: lush, clean, harmonic
                     g("harm") * .4 + g("change") * .45 + (1 - g("steady")) * .3,                    # shell: restless, always turning into something else
                     g("voice") * .5 + g("dyn") * .4 + g("tonal") * .2,                              # coral: grown around a voice
                     g("bright") * .5 + g("attack") * .4 + g("dist") * .3,                           # crystal: bright, hard, sharp
                     (1 - g("attack")) * .4 + (1 - g("bpm")) * .4 + g("wide") * .2 + (1 - g("loud")) * .2]   # medusa: slow and soft
            cap = int(np.ceil(len(have) / len(PLANS)))                                               # no species is used twice while another is still free
            order = sorted(range(len(PLANS)), key=lambda i: -(score[i] + (h * 7 % 1) * .04 * i))
            plan = next((i for i in order if used_plans.count(i) < cap), order[0])
            want = (g("dist") * .1 + (1 - g("bright")) * .25 + g("harm") * .35 + g("voice") * .3 + h * .25) % 1 * 360
            gap = 360 / (len(have) + 1) * .8
            hue = min((want + k * 12 for k in range(30)), key=lambda x: (0 if all(min(abs(x % 360 - u), 360 - abs(x % 360 - u)) >= gap for u in used_hues) else 1, abs(x - want))) % 360
            c["look"] = {"plan": plan, "species": PLANS[plan], "hue": round(hue, 1), "hue2": round((hue + 110 + h * 140) % 360, 1)}
            used_plans.append(plan)
            used_hues.append(c["look"]["hue"])
            with _lock:
                cur = json.loads((_dir(c["slug"]) / "creature.json").read_text())
                cur["look"] = c["look"]
                _save(cur)
    _pop.clear()
    _pop.update(at=time.time(), rel=rel, ready=ready)
    return _pop


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
EXTRA_KEYS = ("tonal", "dist", "steady", "harm", "voice", "attack", "change", "wide")   # measured since version 2; they shape the look, not the limbs
FEATURES_V = 2
_fingers: dict = {}


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


def lineage(c: dict) -> bool:
    """For a bred creature: note which parent each of its tracks came from, and the word that parent learned for it.
    The child's adapter is its parents' put together, so it answers to their words, not to the new ones it was given.
    Returns True for a child that has not trained since it was bred (once it trains, it learns its own words)."""
    if not c.get("parents"):
        return False
    fresh = not c.get("history")
    if all("from" in f for f in c.get("food", [])) and c.get("lineage_v") == 1:
        return fresh
    parents = []
    for name in c["parents"]:
        try:
            parents.append(_load(slugify(name)))
        except Exception:
            continue
    where = {}
    for pc in parents:
        own = lineage(pc)                                     # a parent that was itself bred passes on its own parents' words
        trig = {l["id"]: l["trigger"] for l in pc.get("limbs", [])}
        for pf in pc.get("food", []):
            src = str((_dir(pc["slug"]) / "food" / pf["name"]).resolve())
            where[src] = (pc["slug"], pf.get("pwords") if own and pf.get("pwords") else [trig.get(pf.get("limb", 0), ""), pc.get("tag") or pc["slug"]])
    for f in c.get("food", []):
        src = str((_dir(c["slug"]) / "food" / f["name"]).resolve())
        f["from"], f["pwords"] = where.get(src, ("", []))
    styles = [x.strip() for x in (pc.get("style") or "" for pc in parents) if x.strip()]
    if styles and (c.get("style") or "").strip() in [""] + styles:
        c["style"] = ", ".join(dict.fromkeys(styles))[:300]
    c["lineage_v"] = 1
    c.setdefault("gain", 2.0)                                 # each parent is in it at half strength: this brings both back to full
    with _lock:
        cur = _load(c["slug"])
        cur.update(food=c["food"], style=c["style"], lineage_v=1, gain=c["gain"])
        _save(cur)
    return fresh


def bred_start(c: dict):
    """A bred creature's first training session starts from what its parents gave it, not from nothing. The trainer only
    continues from a checkpoint, so the inherited adapter is laid down as one ("epoch 0"). The trainer plays an adapter
    at twice the strength the merge was stored at, which is exactly each parent at full strength. Returns the adapter's
    size if this was done."""
    lora = _dir(c["slug"]) / "lora"
    final = lora / "final"
    if not c.get("parents") or c.get("history") or any((lora / "checkpoints").glob("epoch_*")) or not (final / "adapter_model.safetensors").exists():
        return None
    cfg = json.loads((final / "adapter_config.json").read_text())
    cp = lora / "checkpoints" / "epoch_0_bred"
    cp.mkdir(parents=True, exist_ok=True)
    shutil.copy(final / "adapter_model.safetensors", cp / "adapter_model.safetensors")
    (cp / "adapter_config.json").write_text(json.dumps(dict(cfg, lora_alpha=cfg["r"] * 2), indent=2))
    c["bred_epochs"], c["epochs"] = c.get("epochs", 0), 0  # its own count starts now; what it inherited is remembered apart
    return int(cfg["r"])


def bred_boost(params: dict) -> dict:
    """A bred creature that has not trained since holds each parent at half strength: play it at double."""
    slug = (params.get("creature") or "").strip()
    if not slug:
        return params
    try:
        c = _load(slug)
        if c.get("parents") and not c.get("history"):
            lineage(c)
            return dict(params, creature_strength=float(params.get("creature_strength") or 1) * float(c.get("gain") or 2.0))
    except Exception:
        pass
    return params


def seed(slug: str, limb=None, dur: float = 14.0, mode: str = "", track: str = "") -> dict:
    """What the creature sings from: a passage of one of its own tracks, different every time. ACE-Step then plays it back
    through what the creature has learned, so a song starts from its food and not from a list of words.

    "groove": one or two bars of a track, cut on a hit and looped, with small breaks and fills, and sometimes a short
    figure from another track of the same limb laid over it. It stays one coherent pattern: a first version that cut
    many pieces at random and pitched them came out as disconnected noodling.
    "slice": one unbroken passage, as it is."""
    c = _load(slug)
    d = _dir(slug)
    child = lineage(c)                                        # bred and not trained since: it sings from both parents at once
    food = [f for f in c["food"] if (d / "food" / f["name"]).exists()]
    mine = [f for f in food if limb is None or f.get("limb", 0) == limb] or food
    if not mine:
        raise RuntimeError("its tracks are gone (were the originals moved?)")
    rng = np.random.default_rng()
    sr, n = 44100, int(dur * 44100)
    mode = "groove" if child else mode if mode in ("groove", "slice") else ("groove" if rng.random() < .7 else "slice")

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
        other = [g for g in food if g.get("from") and g.get("from") != f.get("from")] if child else []
        if other:                                                # a child: a loop of the same length from its other parent, laid over the first
            g = other[int(rng.integers(len(other)))]
            lp2 = passage(g, unit, tries=3)
            if lp2 is not None:
                lp2, gain = edge(lp2.copy()), float(rng.uniform(.65, .9))
                for i0 in range(0, n, m):
                    seg = out[i0:i0 + len(lp2)]
                    seg += lp2[:len(seg)] * gain
                used.append(g["name"])
                moves.append("a loop from its other parent")
        others = [g for g in mine if g["name"] != f["name"]]
        if not other and others and rng.random() < .4:           # a short figure from a sister track, repeating over it
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
    words = []
    if c.get("parents"):                                      # the words its parents learned for the tracks it is singing from
        for name in used:
            for w in next((x.get("pwords") or [] for x in c["food"] if x["name"] == name), []):
                if w and w not in words:
                    words.append(w)
    return {"path": str(path), "tracks": used, "moves": moves, "bpm": round(bpm), "mode": mode, "words": words, "child": child, "style": c.get("style") or ""}


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


def remote_can() -> list[str]:
    """The engines that have been set up on the PC (their environment and models are there). remote.json lists them as "can"."""
    r = remote() or {}
    return list(r.get("can") or ["ace_step"]) if r else []


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
        if not fresh:
            r0 = bred_start(c)
            if r0:
                opt = dict(opt, rank=r0)                   # it has to keep the size its parents gave it
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
