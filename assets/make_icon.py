"""Zvoid icon: one sign, like a letter of the creature's own script. A spine, three pairs of ribs, and the lit tip of a
tendril. Flat and matte on purpose: no gradients, no glow.
Run: uv run --no-project --with pillow --with numpy python assets/make_icon.py [preview.png]"""
import math, os, subprocess, sys, tempfile
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

T, SS = 824, 4                                     # tile size, supersampling
W = T * SS
BONE, INK, LIT = (233, 227, 215), (10, 10, 13), (255, 62, 150)
rng = np.random.default_rng(3)

def spine(t):                                      # a slow S from lower left to upper right, in tile units (0..1)
    return .492 + .105 * math.sin((t - .5) * math.pi * 1.15), .795 - .575 * t
def tangent(t, e=1e-3):
    a, b = spine(t - e), spine(t + e); dx, dy = b[0] - a[0], b[1] - a[1]; l = math.hypot(dx, dy); return dx / l, dy / l
P = lambda p: (p[0] * W, p[1] * W)

im = Image.new('RGB', (W, W), INK); d = ImageDraw.Draw(im); wd = W * .033
def stroke(pts):
    d.line([P(p) for p in pts], fill=BONE, width=int(wd), joint='curve')
    for q in (pts[0], pts[-1]): x, y = P(q); d.ellipse((x - wd / 2, y - wd / 2, x + wd / 2, y + wd / 2), fill=BONE)

stroke([spine(t) for t in np.linspace(.05, .95, 80)])
for t, L in ((.24, .215), (.50, .275), (.76, .215)):   # ribs: a mirrored pair at three heights, the middle pair longest, all swept toward the head
    x, y = spine(t); tx, ty = tangent(t); nx, ny = -ty, tx
    for sg in (-1, 1):
        stroke([(x + sg * nx * L * math.sin(u * math.pi * .56) / math.sin(math.pi * .56) + tx * L * .52 * u ** 1.9,
                 y + sg * ny * L * math.sin(u * math.pi * .56) / math.sin(math.pi * .56) + ty * L * .52 * u ** 1.9) for u in np.linspace(0, 1, 40)])
hx, hy = spine(.95); tx, ty = tangent(.95)             # the lit tip: set just off the head, where a tendril would curl to
x, y = P((hx + tx * .075 + .045, hy + ty * .075 + .012)); r = W * .029; d.ellipse((x - r, y - r, x + r, y + r), fill=LIT)

tile = im.resize((T, T), Image.LANCZOS)
a = np.asarray(tile).astype(float); a += rng.normal(0, 3.2, a.shape[:2])[..., None]          # a little grain, so it is matte and not plastic
tile = Image.fromarray(a.clip(0, 255).astype(np.uint8)).convert('RGBA')

mask = Image.new('L', (T * 4, T * 4), 0); ImageDraw.Draw(mask).rounded_rectangle((0, 0, T * 4 - 1, T * 4 - 1), radius=185 * 4, fill=255); mask = mask.resize((T, T), Image.LANCZOS)
rim = Image.new('RGBA', (T, T), (0, 0, 0, 0)); ImageDraw.Draw(rim).rounded_rectangle((1, 1, T - 2, T - 2), radius=185, outline=(255, 255, 255, 28), width=2)
tile.alpha_composite(rim); tile.putalpha(mask)
icon = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0)); shm = Image.new('L', (1024, 1024), 0); shm.paste(mask, (100, 112))
sh = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0)); sh.putalpha(shm.filter(ImageFilter.GaussianBlur(18)).point(lambda v: int(v * .5)))
icon.alpha_composite(sh); icon.alpha_composite(tile, (100, 100))

here = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1:                              # preview only
    icon.save(sys.argv[1]); print('preview written'); sys.exit(0)
icon.save(os.path.join(here, 'icon.png')); icon.resize((256, 256), Image.LANCZOS).save(os.path.join(here, 'icon_small.png'))
with tempfile.TemporaryDirectory() as dd:
    iset = os.path.join(dd, 'Zvoid.iconset'); os.makedirs(iset)
    for s in (16, 32, 64, 128, 256, 512):
        icon.resize((s, s), Image.LANCZOS).save(f'{iset}/icon_{s}x{s}.png'); icon.resize((s * 2, s * 2), Image.LANCZOS).save(f'{iset}/icon_{s}x{s}@2x.png')
    subprocess.run(['iconutil', '-c', 'icns', iset, '-o', os.path.join(here, '..', 'Zvoid.app', 'Contents', 'Resources', 'Zvoid.icns')], check=True)
print('icon written')
