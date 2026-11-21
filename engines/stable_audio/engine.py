"""Stable Audio Open via diffusers. Text-to-audio plus proper audio-to-audio with a strength control."""

import torch

from slutil import load_audio, out, save_audio, seed_everything

_cache = {}


def _pipe(model_id, device):
    key = (model_id, device)
    if key not in _cache:
        _cache.clear()
        from diffusers import StableAudioPipeline

        try:
            pipe = StableAudioPipeline.from_pretrained(model_id, torch_dtype=torch.float32)
        except Exception as e:
            if "gated" in str(e).lower() or "401" in str(e) or "403" in str(e) or "access" in str(e).lower():
                raise RuntimeError(
                    "Stable Audio Open is gated. Accept the license at https://huggingface.co/stabilityai/stable-audio-open-1.0 "
                    "then run `./zvoid login` in a terminal, and try again.") from e
            raise
        _cache[key] = pipe.to(device)
    return _cache[key]


def _init_latents(pipe, wav, strength, steps, gen, device):
    """Encode audio, noise it to the level matching `strength`, and trim the schedule to match."""
    sr = pipe.vae.sampling_rate
    length = int(pipe.transformer.config.sample_size) * pipe.vae.hop_length
    audio = torch.zeros(1, pipe.vae.config.audio_channels, length)
    w = torch.from_numpy(wav)
    if w.shape[0] == 1 and audio.shape[1] == 2:
        w = w.repeat(2, 1)
    n = min(w.shape[-1], length)
    audio[0, :, :n] = w[: audio.shape[1], :n]
    with torch.no_grad():
        enc = pipe.vae.encode(audio.to(device)).latent_dist.sample(gen)

    sched = pipe.scheduler
    orig = sched.set_timesteps
    start = min(int(steps * (1 - strength)), steps - 1)

    def truncated(*a, **k):
        orig(*a, **k)
        sched.timesteps = sched.timesteps[start:]
        sched.sigmas = sched.sigmas[start:]

    sched.set_timesteps = truncated
    sched.set_timesteps(steps, device=device)
    sigma = sched.sigmas[0].to(device)
    sched.set_timesteps = truncated  # pipeline calls it again; keep the truncation
    noise = torch.randn(enc.shape, generator=gen, device="cpu").to(device)
    latents = enc + noise * sigma
    return latents / sched.init_noise_sigma, (lambda: setattr(sched, "set_timesteps", orig)), sr


def run(p, ctx):
    device = ctx.torch_device()
    model_id = p.get("model") or "stabilityai/stable-audio-open-1.0"
    seed = int(p.get("seed", 0))
    seed_everything(seed)
    ctx.progress(f"Loading {model_id} on {device}…")
    pipe = _pipe(model_id, device)
    sr = pipe.vae.sampling_rate
    steps = int(p.get("steps") or 100)
    n = int(p.get("waveforms") or 1)
    gen = torch.Generator("cpu").manual_seed(seed)
    start_s = float(p.get("start_offset") or 0)
    dur = float(p.get("duration") or 10)

    kw = dict(prompt=p.get("prompt") or "", negative_prompt=p.get("negative_prompt") or None,
              num_inference_steps=steps, guidance_scale=float(p.get("guidance_scale", 7)), eta=float(p.get("eta") or 0),
              audio_start_in_s=start_s, audio_end_in_s=start_s + dur, num_waveforms_per_prompt=n, generator=gen)

    restore = None
    if p.get("init_audio"):
        strength = float(p.get("init_strength", 0.6))
        wav, _ = load_audio(p["init_audio"], sr=sr)
        lat, restore, _ = _init_latents(pipe, wav, strength, steps, gen, device)
        kw["latents"] = lat.repeat(n, 1, 1)
        ctx.progress(f"Varying your audio (strength {strength})…")

    def cb(i, t, latents):
        ctx.progress(f"Diffusing… step {i + 1}", (i + 1) / max(1, len(pipe.scheduler.timesteps)))

    kw.update(p.get("extra") or {})
    try:
        audio = pipe(**kw, callback=cb, callback_steps=5).audios
    finally:
        if restore:
            restore()
    outputs = []
    for i, a in enumerate(audio):
        a = a.float().cpu().numpy()
        path = save_audio(ctx.path(f"stable_audio_{i + 1}.wav"), a, sr, normalize=p.get("normalize", True))
        outputs.append(out(path, f"Take {i + 1} · seed {seed}"))
    return {"outputs": outputs, "info": {"model": model_id, "device": device, "sample_rate": sr, "steps": steps}}
