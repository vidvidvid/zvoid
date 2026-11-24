"""VQGAN+CLIP, as it was done in 2021: a picture is the decoding of a grid of codes, and the codes are moved, step by step,
until CLIP reads the picture as the words. Started from an existing picture it mutates that picture instead."""

import os

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import math
from pathlib import Path

import torch
import torch.nn.functional as F

from slutil import out, seed_everything

_cache = {}
MODELS = Path(__file__).resolve().parents[2] / "models" / "vqgan_clip"
CKPT = "https://heibox.uni-heidelberg.de/d/a7530b09fed84f80a887/files/?p=%2Fckpts%2Flast.ckpt&dl=1"
YAML = "https://heibox.uni-heidelberg.de/d/a7530b09fed84f80a887/files/?p=%2Fconfigs%2Fmodel.yaml&dl=1"


def _fetch(ctx):
    """The VQGAN its authors trained on ImageNet (16384 codes, one code per 16 pixels), from their own server."""
    import urllib.request

    MODELS.mkdir(parents=True, exist_ok=True)
    for name, url, least in (("model.yaml", YAML, 300), ("last.ckpt", CKPT, 900_000_000)):
        f = MODELS / name
        if name == "last.ckpt" and (MODELS / "vqgan.pt").exists():
            continue
        if not f.exists() or f.stat().st_size < least:
            ctx.progress(f"Fetching the VQGAN ({name})…")
            urllib.request.urlretrieve(url, f)


def _models(device, ctx):
    if device not in _cache:
        _cache.clear()
        from omegaconf import OmegaConf
        from taming.modules.diffusionmodules.model import Decoder, Encoder
        from transformers import CLIPModel, CLIPTokenizer

        _fetch(ctx)
        cfg = OmegaConf.to_container(OmegaConf.load(MODELS / "model.yaml").model.params)

        class VQ(torch.nn.Module):
            """Only the parts of the VQGAN that draw and read a picture, under the names its checkpoint uses. (The model's own
            class cannot be loaded any more: it reaches for training code that current libraries have dropped.)"""

            def __init__(self, dd, n_embed, embed_dim):
                super().__init__()
                self.encoder, self.decoder = Encoder(**dd), Decoder(**dd)
                self.quantize = torch.nn.Module()                 # the book of codes; choosing among them is done below, by hand
                self.quantize.embedding = torch.nn.Embedding(n_embed, embed_dim)
                self.quant_conv = torch.nn.Conv2d(dd["z_channels"], embed_dim, 1)
                self.post_quant_conv = torch.nn.Conv2d(embed_dim, dd["z_channels"], 1)

            def decode(self, q):
                return self.decoder(self.post_quant_conv(q))

        vq = VQ(cfg["ddconfig"], cfg["n_embed"], cfg["embed_dim"])
        plain = MODELS / "vqgan.pt"                           # only the numbers, so it opens anywhere; the authors' file is wrapped in training code that needs old libraries
        if not plain.exists():
            sd = torch.load(MODELS / "last.ckpt", map_location="cpu", weights_only=False)["state_dict"]
            torch.save({k: v for k, v in sd.items() if not k.startswith("loss.")}, plain)
        sd = torch.load(plain, map_location="cpu", weights_only=True)
        vq.load_state_dict({k: v for k, v in sd.items() if not k.startswith("loss.")}, strict=False)
        clip = CLIPModel.from_pretrained("openai/clip-vit-base-patch32")
        tok = CLIPTokenizer.from_pretrained("openai/clip-vit-base-patch32")
        for m in (vq, clip):
            m.eval().requires_grad_(False)
        _cache[device] = (vq.to(device), clip.to(device), tok)
    return _cache[device]


def _feat(o):
    """What CLIP makes of a text or a picture, as plain numbers (newer versions of the library wrap them)."""
    return o if torch.is_tensor(o) else o.pooler_output


class _Through(torch.autograd.Function):
    """Forward as one thing, gradient as if it were another: how a hard choice of code is made trainable."""

    @staticmethod
    def forward(ctx, fwd, back):
        ctx.shape = back.shape
        return fwd

    @staticmethod
    def backward(ctx, g):
        return None, g.sum_to_size(ctx.shape)


def _quantize(z, book):
    x = z.movedim(1, 3)
    d = x.pow(2).sum(-1, keepdim=True) + book.pow(2).sum(1) - 2 * x @ book.T
    q = F.one_hot(d.argmin(-1), book.shape[0]).to(d.dtype) @ book
    return _Through.apply(q, x).movedim(3, 1)


def _cuts(img, n, gen, size=224):
    """What CLIP is shown: many squares cut from the picture, large and small, each a little shaken."""
    side, outs = img.shape[-1], []
    for _ in range(n):
        s = int(side * (float(torch.rand((), generator=gen)) ** .6 * .82 + .18))
        x, y = int(torch.randint(0, side - s + 1, (), generator=gen)), int(torch.randint(0, side - s + 1, (), generator=gen))
        c = F.interpolate(img[:, :, y:y + s, x:x + s], size=(size, size), mode="bilinear", align_corners=False)
        if float(torch.rand((), generator=gen)) < .5:
            c = c.flip(-1)
        outs.append(c)
    cuts = torch.cat(outs)
    return cuts + torch.randn(cuts.shape, generator=gen).to(cuts.device) * .08


def run(p, ctx):
    from PIL import Image
    import numpy as np

    device = ctx.torch_device()
    seed = int(p.get("seed", 0))
    seed_everything(seed)
    gen = torch.Generator("cpu").manual_seed(seed)
    ctx.progress(f"Loading VQGAN and CLIP on {device}…")
    vq, clip, tok = _models(device, ctx)
    side = int(p.get("size") or 640) // 16 * 16
    steps, ncut, keep = int(p.get("iterations") or 180), int(p.get("cutouts") or 32), float(p.get("keep", 1.2))
    book = vq.quantize.embedding.weight
    lo, hi = book.min(0).values[None, :, None, None], book.max(0).values[None, :, None, None]

    if p.get("init_image"):
        im = Image.open(p["init_image"]).convert("RGB").resize((side, side), Image.LANCZOS)
        x = torch.from_numpy(np.asarray(im)).float().div(127.5).sub(1).permute(2, 0, 1)[None].to(device)
        z = vq.quant_conv(vq.encoder(x))
    else:
        idx = torch.randint(0, book.shape[0], (side // 16 * (side // 16),), generator=gen)
        z = book[idx.to(device)].view(1, side // 16, side // 16, -1).permute(0, 3, 1, 2)
        keep = 0.0
    z0 = z.detach().clone()
    z = z.detach().clone().requires_grad_(True)

    words = [w.strip() for w in str(p.get("prompt") or "").split("|") if w.strip()] or ["a strange luminous thing"]
    t = tok(words, padding=True, truncation=True, max_length=77, return_tensors="pt").to(device)
    want = F.normalize(_feat(clip.get_text_features(**t)), dim=-1)
    mean = torch.tensor([0.48145466, 0.4578275, 0.40821073], device=device)[None, :, None, None]
    std = torch.tensor([0.26862954, 0.26130258, 0.27577711], device=device)[None, :, None, None]
    opt = torch.optim.Adam([z], lr=.1)

    def draw():
        img = vq.decode(_quantize(z, book))
        return _Through.apply(img.clamp(-1, 1), img).add(1).div(2)

    for i in range(steps):
        opt.zero_grad(set_to_none=True)
        img = draw()
        seen = F.normalize(_feat(clip.get_image_features(pixel_values=(_cuts(img, ncut, gen) - mean) / std)), dim=-1)
        if seen.shape[-1] != want.shape[-1]:
            raise RuntimeError("CLIP's text and picture numbers do not line up in this version of the library")
        loss = sum((seen - w[None]).norm(dim=-1).div(2).arcsin().pow(2).mul(2).mean() for w in want) / len(want)   # distance on the sphere, as the old notebooks measured it
        if keep:
            loss = loss + F.mse_loss(z, z0) * keep * (1 - .5 * i / steps)       # the starting picture is held on to, a little less toward the end
        loss.backward()
        opt.step()
        with torch.no_grad():
            z.copy_(z.maximum(lo).minimum(hi))
        if i % 5 == 0:
            ctx.progress(f"Step {i + 1} of {steps}", (i + 1) / steps)

    with torch.no_grad():
        img = draw()[0].permute(1, 2, 0).clamp(0, 1).mul(255).round().byte().cpu().numpy()
    pic = Image.fromarray(img)
    big = int(p.get("save_side") or 1280)
    if big > side:
        pic = pic.resize((big, big), Image.LANCZOS)
    path = ctx.path("vqgan_clip_1.jpg")
    pic.save(path, quality=94)
    return {"outputs": [out(path, f"Picture · seed {seed}", kind="still")], "info": {"device": device, "iterations": steps, "size": side, "started_from": bool(p.get("init_image"))}}
