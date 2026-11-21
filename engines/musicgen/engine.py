"""MusicGen via Hugging Face transformers. Text-to-music, melody conditioning, continuation, long extension."""

import numpy as np
import torch

from slutil import load_audio, out, save_audio, seed_everything

_cache = {}
WINDOW = 30.0  # MusicGen's trained context, in seconds


def _load(model_id, device):
    key = (model_id, device)
    if key not in _cache:
        _cache.clear()
        from transformers import AutoProcessor

        if "melody" in model_id:
            from transformers import MusicgenMelodyForConditionalGeneration as M
        else:
            from transformers import MusicgenForConditionalGeneration as M
        proc = AutoProcessor.from_pretrained(model_id)
        model = M.from_pretrained(model_id).to(device)
        model.eval()
        _cache[key] = (proc, model)
    return _cache[key]


def _gen(model, proc, device, prompt, seconds, gen_kwargs, audio=None, sr=None, melody=False):
    frame_rate = model.config.audio_encoder.frame_rate
    kw = dict(text=[prompt], padding=True, return_tensors="pt")
    prompt_frames = 0
    if audio is not None:
        if melody:
            kw.update(audio=audio.mean(0), sampling_rate=sr)
        else:
            ch = model.config.audio_encoder.audio_channels
            a = audio if ch == 2 and audio.shape[0] == 2 else audio.mean(0, keepdims=True).repeat(ch, 0)
            kw.update(audio=[a if ch == 2 else a[0]], sampling_rate=sr)
            prompt_frames = int(audio.shape[-1] / sr * frame_rate)
    inputs = proc(**kw)
    inputs = {k: (v.to(device) if hasattr(v, "to") else v) for k, v in inputs.items()}
    new_tokens = max(1, int(seconds * frame_rate))  # tokens beyond the audio prompt
    with torch.no_grad():
        wav = model.generate(**inputs, max_new_tokens=new_tokens, **gen_kwargs)
    wav = wav[0].float().cpu().numpy()  # (channels, samples)
    return wav, prompt_frames


def run(p, ctx):
    device = ctx.torch_device()
    model_id = p.get("model") or "facebook/musicgen-melody"
    melody = "melody" in model_id
    seed_everything(p.get("seed"))
    ctx.progress(f"Loading {model_id} on {device}…")
    proc, model = _load(model_id, device)
    sr = model.config.audio_encoder.sampling_rate

    gen_kwargs = dict(do_sample=bool(p.get("do_sample", True)), guidance_scale=float(p.get("guidance_scale", 3)),
                      temperature=float(p.get("temperature", 1.0)), top_k=int(p.get("top_k") or 250))
    if float(p.get("top_p") or 0) > 0:
        gen_kwargs["top_p"] = float(p["top_p"])
    gen_kwargs.update(p.get("extra") or {})

    duration = float(p.get("duration", 12))
    prompt = p.get("prompt") or ""
    audio = None
    if p.get("audio"):
        audio, _ = load_audio(p["audio"], sr=sr, start=p.get("audio_start", 0), length=p.get("audio_length") or None)

    if melody:
        if duration > WINDOW:
            ctx.progress("Melody models max out at 30s; generating 30s.")
            duration = WINDOW
        ctx.progress("Generating…")
        wav, _ = _gen(model, proc, device, prompt, duration, gen_kwargs, audio, sr, melody=True)
        result = wav
    else:
        overlap = float(p.get("extend_overlap", 10))
        keep_input = bool(p.get("keep_input"))
        if audio is not None:
            if audio.shape[-1] / sr > WINDOW - 5:
                audio = audio[:, -int((WINDOW - 5) * sr):]
                ctx.progress("Input trimmed to its last 25s (MusicGen's context is 30s).")
            prompt_sec = audio.shape[-1] / sr
            first = min(WINDOW, prompt_sec + duration)
            ctx.progress("Continuing your audio…")
            wav, _ = _gen(model, proc, device, prompt, first - prompt_sec, gen_kwargs, audio, sr)
            # transformers returns prompt + continuation
            full = wav
            made = first - prompt_sec
        else:
            first = min(WINDOW, duration)
            ctx.progress("Generating…")
            full, _ = _gen(model, proc, device, prompt, first, gen_kwargs)
            prompt_sec, made = 0.0, first
        window = 1
        while made < duration - 0.05:
            window += 1
            step = min(WINDOW - overlap, duration - made)
            ctx.progress(f"Extending: window {window} ({made:.0f}s of {duration:.0f}s)", made / duration)
            ctx_audio = full[:, -int(overlap * sr):]
            wav, _ = _gen(model, proc, device, prompt, step, gen_kwargs, ctx_audio, sr)
            full = np.concatenate([full, wav[:, ctx_audio.shape[-1]:]], axis=1)
            made += step
        result = full if (keep_input or audio is None) else full[:, int(prompt_sec * sr):]

    path = save_audio(ctx.path("musicgen.wav"), result, sr, normalize=p.get("normalize", True))
    return {"outputs": [out(path, f"MusicGen · seed {p.get('seed')}")],
            "info": {"model": model_id, "device": device, "sample_rate": sr,
                     "seconds_audio": round(result.shape[-1] / sr, 2)}}
