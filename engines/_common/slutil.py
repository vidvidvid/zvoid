"""Small helpers shared by engines. Imported inside each engine's own env."""

import os
import random


def seed_everything(seed):
    if seed is None:
        return
    seed = int(seed)
    random.seed(seed)
    try:
        import numpy as np

        np.random.seed(seed % (2**32))
    except ImportError:
        pass
    try:
        import torch

        torch.manual_seed(seed)
    except ImportError:
        pass


def load_audio(path, sr=None, mono=False, start=0.0, length=None):
    """Returns float32 array shaped (channels, samples) and the sample rate."""
    import librosa
    import numpy as np

    y, sr_out = librosa.load(path, sr=sr, mono=mono, offset=float(start or 0),
                             duration=float(length) if length else None)
    if y.ndim == 1:
        y = y[None, :]
    return y.astype(np.float32), sr_out


def save_audio(path, audio, sr, normalize=False):
    """audio: (channels, samples) or (samples,). Writes 24-bit WAV."""
    import numpy as np
    import soundfile as sf

    a = np.asarray(audio, dtype=np.float32)
    if a.ndim == 1:
        a = a[None, :]
    if normalize:
        peak = float(np.max(np.abs(a))) or 1.0
        a = a / peak * 10 ** (-1 / 20)
    a = np.clip(a, -1, 1)
    sf.write(path, a.T, int(sr), subtype="PCM_24")
    return path


def out(path, label=None, kind="audio"):
    return {"path": os.path.abspath(path), "label": label or os.path.basename(path), "kind": kind}
