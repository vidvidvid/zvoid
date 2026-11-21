"""Gym runner: teaches ACE-Step a creature (a LoRA adapter) from the audio in <creature>/food.

Runs inside the ace_step env:   python -u gym.py <creature_dir> '<json options>'
Emits one JSON object per line on stdout; everything the libraries print goes to stderr.
"""

import json
import os
import shutil
import sys
import traceback
from pathlib import Path

_MODELS = Path(__file__).resolve().parents[2] / "models" / "ace_step"
os.environ.setdefault("ACESTEP_PROJECT_ROOT", str(_MODELS))
os.environ.setdefault("ACESTEP_CHECKPOINTS_DIR", str(_MODELS / "checkpoints"))
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

_proto = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr
AUDIO = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aiff", ".aif", ".opus"}


def send(**o):
    _proto.write(json.dumps(o, default=str) + "\n")
    _proto.flush()


def latest_checkpoint(out: Path):
    cps = [(int(p.name.split("_")[1]), p) for p in (out / "checkpoints").glob("epoch_*") if p.name.split("_")[1].isdigit()]
    return max(cps)[1] if cps else None


def main():
    cdir, opt = Path(sys.argv[1]), json.loads(sys.argv[2])
    ckpt = _MODELS / "checkpoints"
    food, tensors, out = cdir / "food", cdir / "tensors", cdir / "lora"
    variant = opt.get("variant", "turbo")
    files = sorted(f for f in food.iterdir() if f.suffix.lower() in AUDIO)
    if not files:
        raise RuntimeError("This creature has not been fed yet. Drop some audio on it first.")

    # ---- 1. digest: audio -> training tensors (only when the food changed) ----
    captions = opt.get("captions") or {}
    stamp = {"files": [[f.name, f.stat().st_size, captions.get(f.name, "")] for f in files], "style": opt.get("style", ""),
             "tag": opt.get("tag", ""), "variant": variant, "precision": opt.get("precision", "fp32"), "max_duration": opt.get("max_duration", 240)}
    stamp_file = cdir / "digested.json"
    if not stamp_file.exists() or json.loads(stamp_file.read_text()) != stamp or not any(tensors.glob("*.pt")):
        send(type="stage", stage="digest", msg=f"digesting {len(files)} track{'s' if len(files) != 1 else ''}…")
        from acestep.training_v2.preprocess import preprocess_audio_files

        ds = []
        for f in files:
            cap = captions.get(f.name) or opt.get("style") or f.stem.replace("_", " ").replace("-", " ")
            item = {"audio_path": str(f), "caption": cap}
            if opt.get("tag"):
                item["custom_tag"] = opt["tag"]
            ds.append(item)
        (cdir / "dataset.json").write_text(json.dumps(ds, indent=2))
        shutil.rmtree(tensors, ignore_errors=True)
        res = preprocess_audio_files(audio_dir=str(food), output_dir=str(tensors), checkpoint_dir=str(ckpt), variant=variant,
                                     max_duration=float(opt.get("max_duration", 240)), dataset_json=str(cdir / "dataset.json"),
                                     device=str(opt.get("device", "auto")),
                                     precision=str(opt.get("precision", "fp32")))  # fp16 gives NaNs on Apple GPUs
        if not res.get("processed"):
            raise RuntimeError(f"Could not digest any of the tracks ({res.get('failed')} failed).")
        stamp_file.write_text(json.dumps(stamp))
        send(type="stage", stage="digested", msg=f"digested {res['processed']}/{res['total']} tracks")

    # ---- 2. train ----
    import torch
    from acestep.training_v2.cli.common import build_configs, build_root_parser
    from acestep.training_v2.model_loader import load_decoder_for_training
    from acestep.training_v2.trainer_fixed import FixedLoRATrainer

    rank = int(opt.get("rank", 64))
    argv = ["--plain", "--yes", "fixed", "--checkpoint-dir", str(ckpt), "--model-variant", variant,
            "--dataset-dir", str(tensors), "--output-dir", str(out), "--epochs", str(int(opt["target_epochs"])),
            "--rank", str(rank), "--alpha", str(int(opt.get("alpha", rank * 2))), "--lr", str(opt.get("lr", 1e-4)),
            "--save-every", str(int(opt.get("save_every", 10))), "--warmup-steps", str(int(opt.get("warmup_steps", 20))),
            "--batch-size", str(int(opt.get("batch_size", 1))), "--gradient-accumulation", str(int(opt.get("grad_accum", 4))),
            "--dropout", str(opt.get("dropout", 0.1)), "--log-every", "1", "--num-workers", "0",
            "--precision", str(opt.get("precision", "fp32")), "--device", str(opt.get("device", "auto"))]  # 16-bit mixed precision fails on Apple GPUs
    resume = latest_checkpoint(out)
    if resume and not opt.get("fresh"):
        argv += ["--resume-from", str(resume)]
    argv += [str(a) for a in opt.get("extra_args", [])]
    args = build_root_parser().parse_args(argv)
    torch.set_float32_matmul_precision("medium")
    adapter_cfg, train_cfg = build_configs(args)
    send(type="stage", stage="load", msg=f"waking the model on {train_cfg.device}…")
    model = load_decoder_for_training(checkpoint_dir=train_cfg.checkpoint_dir, variant=train_cfg.model_variant,
                                      device=train_cfg.device, precision=train_cfg.precision)
    trainer = FixedLoRATrainer(model, adapter_cfg, train_cfg)
    send(type="stage", stage="train", msg="training…")
    for u in trainer.train():
        kind = getattr(u, "kind", "info")
        step, loss, msg = (u.step, u.loss, u.msg) if hasattr(u, "step") else u[:3]
        send(type="update", kind=kind, step=step, loss=float(loss or 0), msg=str(msg), epoch=getattr(u, "epoch", 0),
             max_epochs=getattr(u, "max_epochs", 0), lr=getattr(u, "lr", 0.0))
        if kind == "fail":
            raise RuntimeError(str(msg))
    send(type="done", final=str(out / "final"))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        send(type="error", error=f"{type(e).__name__}: {e}", trace=traceback.format_exc())
        sys.exit(1)
