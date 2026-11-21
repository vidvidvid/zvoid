"""Breed two creatures: merge two LoRA adapters into one that behaves like their average.

Usage: breed.py <adapter_a> <adapter_b> <out_dir> [weight_of_a=0.5]

A LoRA changes a layer by scale * B @ A. Stacking the two A matrices on top of each other and putting the two B
matrices side by side (each multiplied by its own scale and its share) gives one adapter of rank r_a + r_b whose
change is exactly  w * change_a + (1 - w) * change_b. Nothing is retrained.
"""
import json
import shutil
import sys
from pathlib import Path


def breed(a_dir: Path, b_dir: Path, out: Path, w: float = .5) -> dict:
    import torch
    from safetensors.torch import load_file, save_file

    cfgs = [json.loads((d / "adapter_config.json").read_text()) for d in (a_dir, b_dir)]
    for c in cfgs:
        if str(c.get("peft_type", "LORA")).upper() != "LORA" or c.get("use_dora"):
            raise ValueError("only plain LoRA adapters can be bred")
        if c.get("rank_pattern") or c.get("alpha_pattern"):
            raise ValueError("adapters with per-layer ranks cannot be bred yet")
    scale = [(c["lora_alpha"] / (c["r"] ** .5 if c.get("use_rslora") else c["r"])) for c in cfgs]
    ta, tb = load_file(str(a_dir / "adapter_model.safetensors")), load_file(str(b_dir / "adapter_model.safetensors"))
    if set(ta) != set(tb):
        raise ValueError("these two were trained on different layers (different capacity settings or model), so they cannot be bred")
    merged, layers = {}, 0
    for k, va in ta.items():
        vb = tb[k]
        if "lora_A" in k:
            if va.ndim != 2 or va.shape[1] != vb.shape[1]:
                raise ValueError(f"unexpected shape in {k}")
            merged[k] = torch.cat([va.float(), vb.float()], 0).to(va.dtype)
            layers += 1
        elif "lora_B" in k:
            if va.ndim != 2 or va.shape[0] != vb.shape[0]:
                raise ValueError(f"unexpected shape in {k}")
            merged[k] = torch.cat([va.float() * scale[0] * w, vb.float() * scale[1] * (1 - w)], 1).to(va.dtype)
        elif va.shape == vb.shape:
            merged[k] = (va.float() * w + vb.float() * (1 - w)).to(va.dtype)
        else:
            raise ValueError(f"cannot merge {k}")
    out.mkdir(parents=True, exist_ok=True)
    cfg = dict(cfgs[0], r=cfgs[0]["r"] + cfgs[1]["r"], lora_alpha=cfgs[0]["r"] + cfgs[1]["r"], use_rslora=False)
    save_file(merged, str(out / "adapter_model.safetensors"))
    (out / "adapter_config.json").write_text(json.dumps(cfg, indent=2))
    for extra in ("README.md",):
        if (a_dir / extra).exists():
            shutil.copy(a_dir / extra, out / extra)
    return {"layers": layers, "rank": cfg["r"]}


if __name__ == "__main__":
    try:
        r = breed(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), float(sys.argv[4]) if len(sys.argv) > 4 else .5)
        print(json.dumps({"ok": True, **r}))
    except Exception as e:  # reported to the app as one line
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
