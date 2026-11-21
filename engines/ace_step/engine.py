"""ACE-Step 1.5 via its Python API (text2music, cover, repaint, lego, complete, extract)."""

import os
from pathlib import Path

# Keep ACE-Step's weights inside zvoid/models/ace_step instead of wherever the process starts
_MODELS = Path(__file__).resolve().parents[2] / "models" / "ace_step"
_MODELS.mkdir(parents=True, exist_ok=True)
_CREATURES = Path(__file__).resolve().parents[2] / "creatures"
os.environ.setdefault("ACESTEP_PROJECT_ROOT", str(_MODELS))
os.environ.setdefault("ACESTEP_CHECKPOINTS_DIR", str(_MODELS / "checkpoints"))
os.environ.setdefault("ACESTEP_LM_BACKEND", "mlx")
# The Xet download path stalled on ACE-Step's big files on this Mac; plain HTTP works
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

from slutil import out  # noqa: E402

# Skip ACE-Step's mirror auto-detection, which can hang; set ACESTEP_DOWNLOAD_SOURCE=modelscope to change
_SOURCE = os.environ.get("ACESTEP_DOWNLOAD_SOURCE", "huggingface")

_state = {"dit": None, "dit_key": None, "llm": None, "llm_key": None}
BASE_ONLY = {"lego", "complete", "extract"}


def _ensure(kind, name, ckpt, ctx):
    from acestep import model_downloader as md

    if not md.check_main_model_exists(ckpt):
        ctx.progress("Downloading ACE-Step main model (~10 GB, first time only)…")
        ok, msg = md.ensure_main_model(ckpt, prefer_source=_SOURCE)
        if not ok:
            raise RuntimeError(msg)
    if md.check_model_exists(name, ckpt):
        return
    ctx.progress(f"Downloading {name} (first time only)…")
    fn = md.ensure_lm_model if kind == "lm" else md.ensure_dit_model
    ok, msg = fn(name, checkpoints_dir=ckpt, prefer_source=_SOURCE)
    if not ok:
        raise RuntimeError(msg)


def _handlers(model, lm_model, need_lm, device, ctx):
    from acestep.gpu_config import get_gpu_config, set_global_gpu_config
    from acestep.handler import AceStepHandler
    from acestep.llm_inference import LLMHandler
    from acestep.model_downloader import get_checkpoints_dir

    set_global_gpu_config(get_gpu_config())
    ckpt = get_checkpoints_dir()
    if _state["dit_key"] != (model, device):
        _ensure("dit", model, ckpt, ctx)
        ctx.progress(f"Loading {model} on {device}…")
        dit = AceStepHandler()
        msg, ok = dit.initialize_service(project_root=str(_MODELS), config_path=model, device=device,
                                         use_flash_attention=False, compile_model=False,
                                         offload_to_cpu=False, offload_dit_to_cpu=False)
        if not ok:
            raise RuntimeError(f"Could not load {model}: {msg}")
        _state.update(dit=dit, dit_key=(model, device))
    if _state["llm"] is None:
        _state["llm"] = LLMHandler()
    if need_lm and _state["llm_key"] != lm_model:
        _ensure("lm", lm_model, ckpt, ctx)
        ctx.progress(f"Loading planner LM {lm_model}…")
        backend = os.environ.get("ACESTEP_LM_BACKEND", "mlx")
        msg, ok = _state["llm"].initialize(checkpoint_dir=str(ckpt), lm_model_path=lm_model, backend=backend,
                                           device=device, offload_to_cpu=False, dtype=None)
        if not ok:
            raise RuntimeError(f"Could not load planner LM {lm_model}: {msg}")
        _state["llm_key"] = lm_model
    return _state["dit"], _state["llm"]


def _tagged(caption, tag):
    return caption if not tag or tag.lower() in caption.lower() else f"{tag}, {caption}"


def _creature(dit, p, ctx):
    """Load (or drop) the creature's adapter. Returns its trigger tag, if it has one."""
    slug = (p.get("creature") or "").strip()
    cdir = _CREATURES / slug
    lora = cdir / "lora"
    found = [x for x in [lora / "final", *(lora / "checkpoints").glob("epoch_*")] if (x / "adapter_config.json").exists()] if slug else []
    final = max(found, key=lambda x: (x / "adapter_config.json").stat().st_mtime) if found else lora / "final"
    at = Path(str(p.get("creature_at") or "").strip() or "/nonexistent")   # an earlier stage of it, for hearing how it learned
    if slug and (at / "adapter_config.json").exists():
        final, found = at, found or [at]
    want = None
    if slug:
        if not found:
            raise ValueError(f"Creature “{slug}” hasn't been trained yet. Train it in the vivarium first.")
        load_dir = final
        if "." in final.name:                       # checkpoint folders are named like epoch_20_loss_1.1957, and the loader uses the folder name
            import re as _re                        # as a module name, where a dot is not allowed: load it through a link with a safe name
            load_dir = lora / ("use_" + _re.sub(r"[^0-9A-Za-z_]", "_", final.name))
            if not load_dir.exists():
                load_dir.symlink_to(final.resolve(), target_is_directory=True)
        want = (str(load_dir), (final / "adapter_model.safetensors").stat().st_mtime, id(dit))
    if _state.get("lora") != want:
        if _state.get("lora") and _state["lora"][2] == id(dit):
            dit.unload_lora()
        if want:
            ctx.progress(f"Summoning creature “{slug}”…")
            msg = dit.load_lora(want[0])
            if "❌" in str(msg):
                raise RuntimeError(str(msg))
        _state["lora"] = want
    # adapters only apply on the PyTorch path, so skip the MLX fast path while a creature is active
    if not hasattr(dit, "_zv_mlx"):
        dit._zv_mlx = bool(getattr(dit, "use_mlx_dit", False))
    dit.use_mlx_dit = dit._zv_mlx and not want
    if not want:
        return ""
    dit.set_use_lora(True)
    dit.set_lora_scale(float(p.get("creature_strength", 1)))
    try:
        import json as _json
        return _json.loads((cdir / "creature.json").read_text()).get("tag", "")
    except Exception:
        return ""


def run(p, ctx):
    from acestep.constants import TASK_INSTRUCTIONS
    from acestep.inference import GenerationConfig, GenerationParams, generate_music

    task = p.get("task") or "text2music"
    model = p.get("model") or "acestep-v15-turbo"
    if task in BASE_ONLY and "base" not in model:
        model = "acestep-v15-base"
        ctx.progress(f"'{task}' needs the base model, switching to {model}.")
    if task != "text2music" and not p.get("src_audio"):
        raise ValueError(f"Task '{task}' needs source audio.")

    thinking = bool(p.get("thinking", True)) and task in ("text2music", "lego", "complete")
    device = ctx.torch_device()
    dit, llm = _handlers(model, p.get("lm_model") or "acestep-5Hz-lm-1.7B", thinking, device, ctx)

    caption_tag = _creature(dit, p, ctx)

    track = p.get("track") or "guitar"
    extra = dict(p.get("extra") or {})
    tracks = extra.pop("tracks", None)
    instruction = TASK_INSTRUCTIONS["text2music"]
    if task == "lego":
        instruction = TASK_INSTRUCTIONS["lego"].format(TRACK_NAME=track.upper())
    elif task == "extract":
        instruction = TASK_INSTRUCTIONS["extract"].format(TRACK_NAME=track.upper())
    elif task == "complete":
        instruction = (TASK_INSTRUCTIONS["complete"].format(TRACK_CLASSES=", ".join(t.upper() for t in tracks))
                       if tracks else TASK_INSTRUCTIONS["complete_default"])
    elif task in ("repaint", "cover"):
        instruction = TASK_INSTRUCTIONS[task]

    steps = int(p.get("steps") or 8)
    if "turbo" not in model and steps <= 8:
        steps = 32
        ctx.progress("Non-turbo model: using 32 steps (set Steps to override).")
    kw = dict(
        task_type=task, instruction=instruction,
        caption=_tagged(p.get("caption") or "", caption_tag), lyrics=p.get("lyrics") or "[Instrumental]",
        instrumental=(p.get("lyrics") or "[Instrumental]").strip().lower() == "[instrumental]",
        duration=float(p.get("duration") or -1), bpm=int(p["bpm"]) if p.get("bpm") else None,
        keyscale=p.get("keyscale") or "", seed=int(p.get("seed", -1)),
        inference_steps=steps, guidance_scale=float(p.get("guidance_scale", 7)),
        shift=float(p.get("shift", 3)), infer_method=p.get("infer_method") or "ode",
        thinking=thinking, lm_temperature=float(p.get("lm_temperature", 0.85)),
    )
    if p.get("src_audio"):
        kw["src_audio"] = p["src_audio"]
    if task == "cover":
        kw["audio_cover_strength"] = float(p.get("cover_strength", 0.8))
    if task in ("repaint", "lego"):
        kw.update(repainting_start=float(p.get("repaint_start") or 0), repainting_end=float(p.get("repaint_end") or -1))
        if task == "repaint":
            kw["chunk_mask_mode"] = "explicit"
    # any other control named after a GenerationParams field passes straight through
    for k, v in p.items():
        if k in GenerationParams.__dataclass_fields__ and k not in kw and v not in (None, "", "auto"):
            kw[k] = v
    kw.update({k: v for k, v in extra.items() if k in GenerationParams.__dataclass_fields__})
    cfg_extra = {k: v for k, v in extra.items() if k in GenerationConfig.__dataclass_fields__}

    seed = int(p.get("seed", -1))
    batch = int(p.get("batch") or 1)
    config = GenerationConfig(batch_size=batch, use_random_seed=seed < 0,
                              seeds=[seed + i for i in range(batch)] if seed >= 0 else None,
                              audio_format=p.get("audio_format") or "wav", **cfg_extra)

    ctx.progress(f"Generating {batch} × {kw['duration']:.0f}s ({task}, {steps} steps)…")

    def progress(frac=None, desc=None, *a, **k):
        try:
            ctx.progress(desc or "Generating…", float(frac) if frac is not None else None)
        except Exception:
            pass

    result = generate_music(dit, llm, GenerationParams(**kw), config, save_dir=ctx.out_dir, progress=progress)
    if not result.success:
        raise RuntimeError(result.error or result.status_message or "ACE-Step failed")

    outputs, seeds = [], []
    for i, a in enumerate(result.audios):
        s = (a.get("params") or {}).get("seed")
        seeds.append(s)
        path = a["path"]
        nice = Path(ctx.out_dir) / f"ace_{task}_{i + 1}_seed{s}{Path(path).suffix}"
        try:
            os.replace(path, nice)
            path = str(nice)
        except OSError:
            pass
        outputs.append(out(path, f"Take {i + 1} · seed {s}"))
    meta = (result.extra_outputs or {}).get("lm_metadata") or {}
    return {"outputs": outputs, "info": {
        "model": model, "task": task, "device": device, "steps": steps, "seeds": seeds,
        "lm_plan": {k: v for k, v in meta.items() if isinstance(v, (str, int, float))} if isinstance(meta, dict) else str(meta)[:500],
        "status": result.status_message}}
