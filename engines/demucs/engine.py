"""Demucs source separation, called in-process (no CLI, no torchaudio file IO)."""

import os

import numpy as np
import torch

from slutil import load_audio, out, save_audio

_cache = {}


def _model(name):
    if name not in _cache:
        _cache.clear()
        from demucs.pretrained import get_model

        m = get_model(name)
        m.eval()
        _cache[name] = m
    return _cache[name]


def run(p, ctx):
    from demucs.apply import apply_model

    if not p.get("audio"):
        raise ValueError("Add a track to split first.")
    name = p.get("model") or "htdemucs"
    ctx.progress(f"Loading {name}…")
    model = _model(name)
    sr = model.samplerate
    wav, _ = load_audio(p["audio"], sr=sr, mono=False)
    if wav.shape[0] == 1:
        wav = np.repeat(wav, 2, axis=0)
    wav = torch.from_numpy(wav[:2])
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    x = (wav - mean) / std

    want = p.get("device") or "auto"
    devices = [want] if want != "auto" else (["mps", "cpu"] if torch.backends.mps.is_available() else ["cpu"])
    sources = None
    for dev in devices:
        try:
            ctx.progress(f"Separating on {dev} (this can take a minute)…")
            sources = apply_model(model, x[None], device=dev, shifts=int(p.get("shifts", 1)),
                                  split=True, overlap=float(p.get("overlap", 0.25)), progress=False)[0]
            used = dev
            break
        except Exception as e:  # some ops aren't supported on Apple GPU in every torch version
            ctx.progress(f"{dev} failed ({type(e).__name__}), trying next device…")
    if sources is None:
        raise RuntimeError("Separation failed on every device.")
    sources = (sources * std + mean).cpu().numpy()

    base = os.path.splitext(os.path.basename(p["audio"]))[0][:40]
    names = list(model.sources)
    outputs = []
    two = p.get("two_stems") or "all stems"
    if two != "all stems":
        if two not in names:
            raise ValueError(f"{name} has no '{two}' stem. It has: {', '.join(names)}")
        i = names.index(two)
        rest = sum(sources[j] for j in range(len(names)) if j != i)
        for label, a in ((two, sources[i]), (f"no_{two}", rest)):
            outputs.append(out(save_audio(ctx.path(f"{base}_{label}.wav"), a, sr), label))
    else:
        for i, n in enumerate(names):
            outputs.append(out(save_audio(ctx.path(f"{base}_{n}.wav"), sources[i], sr), n))
    return {"outputs": outputs, "info": {"model": name, "device": used, "stems": [o["label"] for o in outputs]}}
