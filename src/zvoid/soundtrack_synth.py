"""Make the soundtrack of a training time-lapse. Run with the ACE-Step environment's Python (it needs numpy and soundfile):

    python soundtrack_synth.py spec.json

Three layers, all optional except the first:
  1. Its voice, growing up: grains of the creature's own tracks. Early on they are short, scattered and detuned; as the
     loss falls they get longer, truer, and start to follow the music in order. Every epoch lands as a soft pulse.
  2. What it could really make at each stage: short clips generated from the creature as it was at that point, in order.
  3. The finished creature sings, over a held last frame.
"""
import json
import sys

import numpy as np
import soundfile as sf

SR = 44100


def load(path, sr=SR):
    x, s = sf.read(path, always_2d=True, dtype="float32")
    if s != sr:
        n = int(len(x) * sr / s)
        idx = np.linspace(0, len(x) - 1, n)
        x = np.stack([np.interp(idx, np.arange(len(x)), x[:, c]) for c in range(x.shape[1])], 1).astype("float32")
    return x


def main(spec):
    rng = np.random.default_rng(spec.get("seed", 7))
    dur, tail = float(spec["dur"]), float(spec.get("tail", 0))
    n = int((dur + tail) * SR) + SR
    out = np.zeros((n, 2), "float32")
    e0, e1 = float(spec.get("e0", 0)), float(spec.get("e1", 1))
    hist = [h for h in spec.get("history", []) if h[1] is not None]
    he = np.array([h[0] for h in hist] or [0, 1], float)
    hl = np.array([h[1] for h in hist] or [1, 1], float)
    if len(hl) > 4:                                           # smooth the loss a little: single epochs jump around
        k = np.ones(5) / 5
        hl = np.convolve(np.pad(hl, 2, mode="edge"), k, "valid")
    lmax, lmin = float(hl.max()), float(hl.min())

    def pure(t):                                              # 0 = knows nothing, 1 = as good as this run got
        u = min(1.0, max(0.0, t / dur))
        ln = (lmax - float(np.interp(e0 + u * (e1 - e0), he, hl))) / (lmax - lmin + 1e-6)
        return float(np.clip(.6 * ln + .4 * u, 0, 1) ** .85)

    clips = [dict(c, x=load(c["path"])) for c in spec.get("clips", []) if c.get("path")]
    bed_gain = .45 if clips else 1.0

    # ---- 1. its voice
    limbs = [dict(l, bufs=[load(p, 22050)[:, 0] for p in l["tracks"]]) for l in spec.get("limbs", []) if l.get("tracks")]
    share = np.array([max(.05, l.get("share", 1)) for l in limbs]) if limbs else np.array([])
    t = 0.0
    while limbs and t < dur + min(tail, 2.5):
        p = pure(t)
        u = min(1.0, t / dur)
        live = [i for i in range(len(limbs)) if u >= i * .1] or [0]                # the limbs join in one by one, as their frames build
        w = share[live] / share[live].sum()
        li = int(rng.choice(live, p=w))
        limb = limbs[li]
        buf = limb["bufs"][int(t * .08 + li) % len(limb["bufs"])]                  # it stays with one track for a while, then moves on
        L = len(buf) / 22050
        gd = (.05 + .5 * p) * rng.uniform(.7, 1.3)
        seq = (t * 1.0 + li * 7.3) % max(1.0, L - 1.5)                             # a playhead that runs on in real time: this is what makes it turn into music
        pos = seq if rng.random() < p else rng.uniform(0, max(.1, L - gd - .1))
        pos = float(np.clip(pos + rng.normal(0, (1 - p) * 1.5), 0, max(0, L - gd * 2.2 - .05)))
        semis = rng.normal(0, (1 - p) * 2.2) + (rng.choice([-12, 12]) if rng.random() < .18 * (1 - p) else 0)
        rate = 2 ** (semis / 12) * (1 - .25 * limb.get("low", 0) * (1 - p))
        m = int(gd * SR)
        src = pos * 22050 + np.arange(m) * (22050 / SR) * rate
        g = np.interp(src, np.arange(len(buf)), buf, right=0) * np.hanning(m)
        dens = 9 + 15 * p
        gain = (.35 + .65 * p) * bed_gain / np.sqrt(max(1.0, gd * dens)) * 1.9
        pan = float(np.clip(rng.normal(0, .25 + .5 * (1 - p)), -1, 1))
        i0 = int(t * SR)
        seg = out[i0:i0 + m]
        seg[:, 0] += g[:len(seg)] * gain * np.sqrt(.5 * (1 - pan))
        seg[:, 1] += g[:len(seg)] * gain * np.sqrt(.5 * (1 + pan))
        t += rng.uniform(.6, 1.4) / dens

    # every epoch lands as a soft pulse (thinned out when they come too fast to count)
    ne = max(1, int(round(e1 - e0)))
    step = max(1, int(np.ceil(ne / max(1.0, dur * 3.5))))
    tt = np.arange(int(.22 * SR)) / SR
    thump = np.sin(2 * np.pi * (62 * tt - 55 * tt * tt)) * np.exp(-tt * 22)
    for k in range(0, ne + 1, step):
        i0 = int(k / ne * dur * SR)
        seg = out[i0:i0 + len(thump)]
        seg += (thump[:len(seg)] * (.16 if k % (step * 4) == 0 else .09))[:, None]

    # ---- 2. what it could really make at each stage
    if clips:
        ts = [float(np.clip((c["epoch"] - e0) / max(1e-6, e1 - e0), 0, 1)) * dur for c in clips]
        for i, c in enumerate(clips):
            a = max(0, ts[i] - 3.5) if i == 0 else (ts[i - 1] + ts[i]) / 2      # each stage is heard around the moment it was reached, never long before it
            b = min(dur, ts[i] + 3.5) if i == len(clips) - 1 else (ts[i] + ts[i + 1]) / 2
            x = c["x"]
            if x.shape[1] == 1:
                x = np.repeat(x, 2, 1)
            m = int(min(b - a + .5, len(x) / SR) * SR)
            if m < SR // 4:
                continue
            seg = x[:m].copy()
            f = min(int(.45 * SR), m // 3)
            seg[:f] *= np.linspace(0, 1, f)[:, None]
            seg[-f:] *= np.linspace(1, 0, f)[:, None]
            i0 = int(max(0, a - .25) * SR)
            out[i0:i0 + m] += seg[:len(out[i0:i0 + m])] * .8

    # ---- 3. the finished creature sings
    if spec.get("song") and tail > 1:
        x = load(spec["song"])
        if x.shape[1] == 1:
            x = np.repeat(x, 2, 1)
        m = int(min(tail + .6, len(x) / SR) * SR)
        seg = x[:m].copy()
        f = int(.6 * SR)
        seg[:f] *= np.linspace(0, 1, f)[:, None]
        i0 = int((dur - .6) * SR)
        out[i0:i0 + m] += seg[:len(out[i0:i0 + m])] * .95
        fo = int(1.2 * SR)                                                         # what came before steps back as the song begins
        out[i0:i0 + fo] *= np.linspace(1, 1, fo)[:, None]

    out = out[:int((dur + tail) * SR)]
    fo = int(min(1.6, max(.3, tail * .4 or .5)) * SR)
    out[-fo:] *= np.linspace(1, 0, fo)[:, None] ** 1.5
    fi = int(.4 * SR)
    out[:fi] *= np.linspace(0, 1, fi)[:, None]
    pk = float(np.abs(out).max()) or 1.0
    out = np.tanh(out / pk * 1.6) / np.tanh(1.6) * .9                              # gentle rounding of the peaks, then just under full level
    sf.write(spec["out"], out, SR, subtype="PCM_16")
    print(json.dumps({"ok": True, "seconds": round(len(out) / SR, 2), "limbs": len(limbs), "clips": len(clips), "song": bool(spec.get("song"))}))


if __name__ == "__main__":
    main(json.loads(open(sys.argv[1], encoding="utf-8").read()))
