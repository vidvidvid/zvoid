"""Moves: the things that can be done to a piece besides remaking a stretch of it.

Carving was the only move the night shift had. A piece can also have one of its parts (drums, bass, voice, the rest)
pulled out for a moment or pushed forward, on whole bars of its own beat, so the part leaves and returns on the pulse.
(Cutting the audio itself about, with stutters, reversed beats, tape halts and repeated bars, was tried and the artist
did not want it: glitches are left to the model.)
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from .paths import ENVS_DIR

STEMS = ("drums", "bass", "other", "vocals")


def beat_grid(path: str, bpm: float) -> dict:
    """Where the bars of a piece are. The tempo it was planned at is searched a little to either side for the tempo and
    the starting point at which the most hits land on beats; of the four beats, the one that carries the most low end
    is taken as the first of the bar. Returns the tempo found, the length of a beat and of a bar in seconds, the time
    of the first downbeat, and how sure it is (1 = every beat has a hit on it, 0 = the hits ignore the grid)."""
    x, sr = sf.read(path, always_2d=True, dtype="float32")
    mono, n, hop = x.mean(1), 1024, 256
    idx = np.arange(0, len(mono) - n, hop)
    S = np.abs(np.fft.rfft(mono[idx[:, None] + np.arange(n)] * np.hanning(n), axis=1))
    f = np.fft.rfftfreq(n, 1 / sr)
    flux = lambda sel: np.maximum(0, np.diff(np.log1p(S[:, sel] * 30).sum(1), prepend=0))
    low, all_ = flux((f >= 30) & (f < 180)), flux((f >= 30) & (f < 12000))
    env = low / (low.max() + 1e-9) + .5 * all_ / (all_.max() + 1e-9)
    fps, best = sr / hop, (0.0, float(bpm), 0.0)
    for t in np.arange(float(bpm) * .97, float(bpm) * 1.03 + 1e-6, .05):
        step = 60 / t * fps
        for ph in np.linspace(0, step, 24, endpoint=False):
            pos = np.arange(ph, len(env) - 1, step)
            v = float(env[pos.astype(int)].mean())
            if v > best[0]:
                best = (v, float(t), float(ph))
    v, t, ph = best
    step = 60 / t * fps
    pos = np.arange(ph, len(low) - 1, step).astype(int)
    first = int(np.argmax([low[pos[k::4]].mean() if len(pos[k::4]) else 0 for k in range(4)]))
    beat = 60 / t
    t0 = ph / fps + first * beat
    while t0 - 4 * beat >= 0:
        t0 -= 4 * beat
    return {"bpm": round(t, 2), "beat": beat, "bar": 4 * beat, "t0": t0, "sure": round(float(min(1, v / (float(env.mean()) * 4 + 1e-9))), 2), "bars": int((len(mono) / sr - t0) // (4 * beat))}


def bar_time(grid: dict, bar: float) -> float:
    """The time in seconds at which a bar begins (bars count from 0; a fraction is a place inside a bar)."""
    return grid["t0"] + bar * grid["bar"]


def snap(grid: dict, start: float, end: float, least: int = 4) -> tuple[float, float]:
    """A stretch given in seconds, moved onto whole bars: it begins on a downbeat and lasts a whole number of bars."""
    a = max(0, round((start - grid["t0"]) / grid["bar"]))
    b = max(a + least, round((end - grid["t0"]) / grid["bar"]))
    return bar_time(grid, a), bar_time(grid, b)


def stems(path: str, keep_dir: str = "") -> dict:
    """The piece split into its parts (drums, bass, voice, the rest), kept beside it so it is split only once. Runs in the
    Demucs environment. Returns the path of each part; each is as long as the piece and at its sample rate."""
    src = Path(path)
    keep = Path(keep_dir) if keep_dir else src.parent / (".parts_" + src.stem)
    stamp = f"{src.stat().st_size}:{int(src.stat().st_mtime)}"
    if (keep / "stamp").exists() and (keep / "stamp").read_text() == stamp and all((keep / f"{s}.wav").exists() for s in STEMS):
        return {s: str(keep / f"{s}.wav") for s in STEMS}
    keep.mkdir(exist_ok=True)
    code = (
        "import sys, numpy as np, soundfile as sf, torch, julius\n"
        "from demucs.pretrained import get_model\n"
        "from demucs.apply import apply_model\n"
        "src, out = sys.argv[1], sys.argv[2]\n"
        "x, sr = sf.read(src, always_2d=True, dtype='float32')\n"
        "m = get_model('htdemucs'); m.eval()\n"
        "w = torch.from_numpy(x.T.copy())\n"
        "if w.shape[0] == 1: w = w.repeat(2, 1)\n"
        "w = julius.resample_frac(w[:2], sr, m.samplerate)\n"
        "ref = w.mean(0); mean, std = ref.mean(), ref.std() + 1e-8\n"
        "y = None\n"
        "for dev in (['mps', 'cpu'] if torch.backends.mps.is_available() else ['cpu']):\n"
        "    try:\n"
        "        y = apply_model(m, ((w - mean) / std)[None], device=dev, shifts=1, split=True, overlap=.25, progress=False)[0]; break\n"
        "    except Exception: pass\n"
        "if y is None: raise SystemExit('separation failed')\n"
        "y = (y * std + mean).cpu()\n"
        "for i, name in enumerate(m.sources):\n"
        "    s = julius.resample_frac(y[i], m.samplerate, sr).numpy().T\n"
        "    s = np.pad(s, ((0, max(0, len(x) - len(s))), (0, 0)))[:len(x)]\n"
        "    sf.write(f'{out}/{name}.wav', s.astype('float32'), sr, subtype='FLOAT')\n"
        "print('ok')\n")
    r = subprocess.run([str(ENVS_DIR / "demucs" / "bin" / "python"), "-c", code, str(src), str(keep)], capture_output=True, text=True, timeout=900)
    if r.returncode:
        raise RuntimeError((r.stderr or "could not split the piece").strip()[-300:])
    (keep / "stamp").write_text(stamp)
    return {s: str(keep / f"{s}.wav") for s in STEMS}


def _fade(n: int, k: int) -> np.ndarray:
    """A window that is 1 across n samples with k-sample ramps at both ends."""
    w = np.ones(n, dtype="float32")
    k = max(1, min(k, n // 2))
    r = np.linspace(0, 1, k, dtype="float32")
    w[:k], w[-k:] = r, r[::-1]
    return w


def strip_lift(path: str, out: str, part: str, start: float, end: float, gain_db: float) -> dict:
    """Pull one part of the piece out for a moment, or push it forward. From `start` to `end` seconds (bar lines), the
    part is turned by gain_db: -60 takes it away entirely (drums gone before a drop: a real void), +4 brings it to the
    front. Everything else is untouched, and the part comes back in on the beat."""
    x, sr = sf.read(path, always_2d=True, dtype="float32")
    s, _ = sf.read(stems(path)[part], always_2d=True, dtype="float32")
    a, b = max(0, int(start * sr)), min(len(x), int(end * sr))
    if b - a < sr // 20:
        raise ValueError("that stretch is too short")
    g = 10 ** (float(gain_db) / 20) - 1
    y = x.copy()
    y[a:b] += s[a:b] * g * _fade(b - a, int(.004 * sr))[:, None]
    pk = float(np.abs(y).max())
    if pk > 1:
        y /= pk
    sf.write(out, y, sr, subtype=sf.info(path).subtype)
    return {"move": "lift" if gain_db > 0 else "strip", "part": part, "from": round(start, 2), "to": round(end, 2), "db": gain_db}


def place(path: str) -> dict:
    """Give every part of the piece its own place, so the sounds can be told apart and almost seen. The piece is split
    into drums, bass, voice and the rest, and each is set where it stays: kick and bass dead centre, the upper drums
    close and narrow, everything else spread wide and a little further back in a short room, the voices wide at the
    ear. Where the drums hit, the rest steps back a touch, so a hit is never buried. The artist's own example of a good
    sound image measured exactly this way: a centred low end, a wide top, and sounds that keep their place. The music
    is not changed, and the loudness is left as it was."""
    import shutil
    import tempfile
    x, sr = sf.read(path, always_2d=True, dtype="float64")
    if x.shape[1] < 2 or len(x) < sr * 10:
        return {"changed": False}
    tmp = tempfile.mkdtemp(prefix="zvoid_parts_")
    try:
        st = {k: sf.read(v, always_2d=True, dtype="float64")[0] for k, v in stems(path, tmp).items()}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    n = len(x)
    f = np.fft.rfftfreq(n, 1 / sr)

    def split(sig, hz):
        F = np.fft.rfft(sig, axis=0)
        lo = np.fft.irfft(F * (1 / (1 + (f / hz) ** 8))[:, None], n, axis=0)
        return lo, sig - lo

    def sides(sig, k):
        m, s = sig.mean(1), (sig[:, 0] - sig[:, 1]) / 2 * k
        return np.stack([m + s, m - s], 1)

    def centre(sig):
        m = sig.mean(1)
        return np.stack([m, m], 1)

    def room(sig, secs, wet, pre, cut, seed):
        rng = np.random.default_rng(seed)
        k = int(secs * sr)
        ir = np.concatenate([np.zeros((int(pre * sr), 2)), rng.standard_normal((k, 2)) * np.exp(-np.arange(k) / (secs * sr / 6.9))[:, None]])
        size = n + len(ir)
        Fi = np.fft.rfft(ir, size, axis=0) * (1 / (1 + (np.fft.rfftfreq(size, 1 / sr) / cut) ** 4))[:, None]
        y = np.fft.irfft(np.fft.rfft(sig, size, axis=0) * Fi, size, axis=0)[:n]
        y *= np.sqrt((sig ** 2).mean()) / (np.sqrt((y ** 2).mean()) + 1e-12)
        return sig * (1 - wet * .4) + y * wet

    rms = lambda z: float(np.sqrt((z.mean(1) ** 2).mean())) + 1e-12
    dl, dh = split(st["drums"], 200)
    ol, oh = split(st["other"], 300)
    drums = centre(dl) + sides(dh, .85)
    rest = room(centre(ol) + sides(oh, 1.45), .6, .18, .015, 7000, 2)
    voice = room(sides(st["vocals"], 1.5), .35, .10, .008, 9000, 3)
    w = int(.01 * sr)                                          # where the drums hit, everything else steps back by up to 2.5 dB and returns within a tenth of a second
    env = np.sqrt((st["drums"].mean(1)[:n // w * w].reshape(-1, w) ** 2).mean(1))
    env = env / (np.percentile(env, 99) + 1e-12)
    duck = 1 - np.clip(env, 0, 1) ** 1.5 * (1 - 10 ** (-2.5 / 20))
    for i in range(1, len(duck)):
        duck[i] = min(duck[i], duck[i - 1] + .03)              # it lets go slowly
    duck = np.interp(np.arange(n), np.arange(len(duck)) * w + w / 2, duck)[:, None]
    y = drums + centre(st["bass"]) + (rest + voice) * duck
    y *= rms(x) / rms(y)
    pk = float(np.abs(y).max())
    if pk > .99:
        y *= .99 / pk
    sf.write(path, y.astype("float32"), sr, subtype=sf.info(path).subtype)
    side = lambda z: float(np.sqrt((((z[:, 0] - z[:, 1]) / 2) ** 2).mean()) / rms(z))
    return {"changed": True, "width_before": round(side(x), 2), "width_after": round(side(y), 2)}


def describe(grid: dict) -> str:
    return json.dumps({k: (round(v, 3) if isinstance(v, float) else v) for k, v in grid.items()})
