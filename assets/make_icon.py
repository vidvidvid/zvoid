"""Generates the Zvoid app icon: domain-warped noise in acid colours with interference rings.
Run: uv run --no-project --with pillow --with numpy python assets/make_icon.py [seed]"""
import os, subprocess, sys, tempfile
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

seed = int(sys.argv[1]) if len(sys.argv) > 1 else 23
rng = np.random.default_rng(seed)
N = 1024
y, x = np.mgrid[0:N, 0:N] / N * 2 - 1


def waves(x, y, k):
    out = np.zeros_like(x)
    for _ in range(k):
        f = rng.uniform(1.5, 7)
        a = rng.uniform(0, 2 * np.pi)
        out += np.sin(f * (x * np.cos(a) + y * np.sin(a)) + rng.uniform(0, 6.3)) / k
    return out

# domain warping: warp the coordinates with noise, twice
wx, wy = waves(x, y, 6), waves(y, x, 6)
wx2, wy2 = waves(x + 1.6 * wx, y + 1.6 * wy, 7), waves(y - 1.6 * wy, x + 1.6 * wx, 7)
field = waves(x + 2.2 * wx2, y + 2.2 * wy2, 8)
r = np.hypot(x - 0.15, y + 0.1)
rings = np.sin(r * 38 - field * 6)  # sound-wave interference

t = (field - field.min()) / (np.ptp(field) + 1e-9)
palette = np.array([[12, 4, 40], [92, 0, 180], [255, 0, 140], [255, 110, 0], [255, 240, 60], [0, 255, 200], [20, 10, 80]], float)
idx = t * (len(palette) - 1)
i0 = np.floor(idx).astype(int).clip(0, len(palette) - 2)
f = (idx - i0)[..., None]
f = f * f * (3 - 2 * f)
rgb = palette[i0] * (1 - f) + palette[i0 + 1] * f
rgb *= (0.75 + 0.25 * rings[..., None])
glow = np.exp(-(r * 2.2) ** 2)[..., None]
rgb = rgb * (0.7 + 0.5 * glow) + 60 * glow * (rings[..., None] > 0.85)
img = Image.fromarray(rgb.clip(0, 255).astype(np.uint8)).convert("RGBA")
img = Image.blend(img, img.filter(ImageFilter.GaussianBlur(6)), 0.35)

# macOS-style squircle mask with a subtle rim
mask = Image.new("L", (N, N), 0)
ImageDraw.Draw(mask).rounded_rectangle([90, 90, N - 90, N - 90], radius=215, fill=255)
icon = Image.new("RGBA", (N, N), (0, 0, 0, 0))
icon.paste(img, (0, 0), mask)
rim = Image.new("RGBA", (N, N), (0, 0, 0, 0))
ImageDraw.Draw(rim).rounded_rectangle([92, 92, N - 92, N - 92], radius=213, outline=(255, 255, 255, 70), width=5)
icon = Image.alpha_composite(icon, rim)

here = os.path.dirname(os.path.abspath(__file__))
icon.save(os.path.join(here, "icon.png"))
with tempfile.TemporaryDirectory() as d:
    iset = os.path.join(d, "Zvoid.iconset")
    os.makedirs(iset)
    for s in (16, 32, 64, 128, 256, 512):
        icon.resize((s, s), Image.LANCZOS).save(f"{iset}/icon_{s}x{s}.png")
        icon.resize((s * 2, s * 2), Image.LANCZOS).save(f"{iset}/icon_{s}x{s}@2x.png")
    dest = os.path.join(here, "..", "Zvoid.app", "Contents", "Resources", "Zvoid.icns")
    subprocess.run(["iconutil", "-c", "icns", iset, "-o", dest], check=True)
print("icon written, seed", seed)
