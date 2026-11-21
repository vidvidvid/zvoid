"""Zvoid icon: not a picture of a creature but its essence. A spine of vertebrae with mirrored ribs inside soft dust,
a tendril that curls to a lit tip, and one arc of energy reaching in from outside.
Run: uv run --no-project --with pillow --with numpy python assets/make_icon.py [out.png]"""
import math, os, subprocess, sys, tempfile
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageChops

N, SS = 1024, 2                                   # canvas, supersampling
W = N * SS
rng = np.random.default_rng(7)
PINK, VIOLET, CYAN = np.array([255, 45, 155.]), np.array([164, 60, 255.]), np.array([46, 230, 214.])

def grad(t):                                       # the app's own gradient: pink -> violet -> cyan
    t = min(1., max(0., t))
    c = PINK + (VIOLET - PINK) * (t / .5) if t < .5 else VIOLET + (CYAN - VIOLET) * ((t - .5) / .5)
    return tuple(int(v) for v in c)

def spine(t):                                      # an S-curve from lower left to upper right, in canvas units (0..1)
    y = .80 - .58 * t
    x = .50 + .135 * math.sin((t - .5) * math.pi * 1.25) - .02
    return x, y
def tangent(t, e=1e-3):
    a, b = spine(t - e), spine(t + e); dx, dy = b[0] - a[0], b[1] - a[1]; l = math.hypot(dx, dy); return dx / l, dy / l

def layer(): return Image.new('RGBA', (W, W), (0, 0, 0, 0))
P = lambda x, y: (x * W, y * W)

# ---- the void, with a faint fold of cloud
yy, xx = np.mgrid[0:N, 0:N] / N
def waves(x, y, k):
    o = np.zeros_like(x)
    for _ in range(k):
        f, a = rng.uniform(1.2, 5), rng.uniform(0, 6.283); o += np.sin(f * 6.283 * (x * np.cos(a) + y * np.sin(a)) * .5 + rng.uniform(0, 6.3)) / k
    return o
wx, wy = waves(xx, yy, 5), waves(yy, xx, 5); cloud = waves(xx + .35 * wx, yy + .35 * wy, 6) * .5 + .5
r = np.hypot(xx - .5, yy - .5)
bg = np.zeros((N, N, 3)); bg += np.array([6, 5, 16.]); bg += (cloud[..., None] ** 2.2) * np.array([34, 14, 52.]) * np.exp(-(r * 1.7) ** 2)[..., None]
stars = rng.random((N, N)) > .9993; bg[stars] += rng.uniform(60, 170, (stars.sum(), 1))
base = Image.fromarray(bg.clip(0, 255).astype(np.uint8)).convert('RGBA').resize((W, W), Image.BICUBIC)

# ---- dust: soft light gathered around the spine, wispy
dust = np.zeros((N, N, 3))
for i in range(40):
    t = i / 39; x, y = spine(t); s = .105 * (1 - .55 * abs(t - .45) * 1.6) + .02
    g = np.exp(-(((xx - x) ** 2 + (yy - y) ** 2) / (2 * s * s))); dust += g[..., None] * np.array(grad(t)) / 255 * .16
dust *= (.45 + .9 * cloud[..., None] ** 1.5)
dustL = Image.fromarray((dust * 255).clip(0, 255).astype(np.uint8)).resize((W, W), Image.BICUBIC).convert('RGBA')

# ---- the frame: vertebrae and mirrored ribs
bone = layer(); d = ImageDraw.Draw(bone)
NV = 11
for i in range(NV):
    t = .04 + .92 * i / (NV - 1); x, y = spine(t); tx, ty = tangent(t); nx, ny = -ty, tx
    size = .034 * (1 - .5 * abs(t - .42) * 1.7) + .008; col = grad(t)
    if 0 < i < NV - 1:                              # ribs: a pair from every vertebra, longest in the middle, swept toward the head
        L = .30 * math.sin(math.pi * (t * .86 + .07)) ** 1.25 + .035
        for sgn in (-1, 1):
            pts = []
            for k in range(25):
                u = k / 24; out = L * math.sin(u * math.pi * .56) / math.sin(math.pi * .56); fwd = L * .52 * u ** 1.9
                pts.append(P(x + sgn * nx * out + tx * fwd, y + sgn * ny * out + ty * fwd))
            for k in range(24):                     # tapering stroke
                w = max(1.5, (1 - k / 24) ** 1.1 * size * W * .46)
                d.line([pts[k], pts[k + 1]], fill=col + (235,), width=int(round(w)))
            ex, ey = pts[-1]; rr = max(2.5, size * W * .13); d.ellipse((ex - rr, ey - rr, ex + rr, ey + rr), fill=(255, 255, 255, 235))
    rx, ry = size * W * .78, size * W * .5; ang = math.degrees(math.atan2(ty, tx))
    v = Image.new('RGBA', (int(rx * 4), int(rx * 4)), (0, 0, 0, 0)); c0 = v.size[0] / 2
    ImageDraw.Draw(v).ellipse((c0 - rx, c0 - ry, c0 + rx, c0 + ry), fill=(255, 255, 255, 255)); v = v.rotate(-ang + 90, resample=Image.BICUBIC)
    tint = Image.new('RGBA', v.size, tuple(int(c * .45 + 255 * .55) for c in col) + (255,)); tint.putalpha(v.split()[3])
    px, py = P(x, y); bone.alpha_composite(tint, (int(px - c0), int(py - c0)))

# ---- a tendril from the head, curling like a fern tip to a lit bulb
tend = layer(); d = ImageDraw.Draw(tend)
x, y = spine(.96); tx, ty = tangent(.96); pts = [P(x, y)]; ang = math.atan2(ty, tx); step = .0115
for k in range(64):
    ang += .0025 * k ** 1.22 * 1.0; x += math.cos(ang) * step * (1 - k / 110); y += math.sin(ang) * step * (1 - k / 110); pts.append(P(x, y))
for k in range(len(pts) - 1):
    d.line([pts[k], pts[k + 1]], fill=grad(.9 + .1 * k / 64) + (240,), width=int(max(2, (1 - k / 64) * W * .0095 + 2)))
bx, by = pts[-1]; bulb = (bx, by)

# ---- one arc of energy, reaching in from outside to a vertebra
arc = layer(); d = ImageDraw.Draw(arc)
tx0, ty0 = spine(.36); A, B = (.045, .215), (tx0, ty0); pa = [A]
def mid(a, b, amp, depth):
    if depth == 0: return [b]
    m = ((a[0] + b[0]) / 2 + rng.normal(0, amp), (a[1] + b[1]) / 2 + rng.normal(0, amp)); return mid(a, m, amp * .55, depth - 1) + mid(m, b, amp * .55, depth - 1)
pa += mid(A, B, .045, 5)
for k in range(len(pa) - 1):
    u = k / (len(pa) - 1); d.line([P(*pa[k]), P(*pa[k + 1])], fill=(205, 245, 255, int(255 * min(1, u * 3.2))), width=int(2 + 5 * u))
hit = P(*B)

def glow(img, radius, k=1.):
    g = img.filter(ImageFilter.GaussianBlur(radius * SS))
    if k != 1.: g = Image.eval(g, lambda v: min(255, int(v * k)))
    return g
def dot(layer_, p, rad, col):
    ImageDraw.Draw(layer_).ellipse((p[0] - rad, p[1] - rad, p[0] + rad, p[1] + rad), fill=col)

lights = layer(); dot(lights, bulb, W * .017, (255, 250, 235, 255)); dot(lights, hit, W * .014, (230, 250, 255, 255))

out = base.copy()
def add(img):                                      # light adds to light
    global out
    rgb = ImageChops.add(out.convert('RGB'), Image.composite(img.convert('RGB'), Image.new('RGB', img.size, (0, 0, 0)), img.split()[3]))
    out = rgb.convert('RGBA')
add(dustL); add(glow(bone, 26, 1.0)); add(glow(bone, 9, .9)); add(glow(arc, 12, 1.3)); add(glow(tend, 10, 1.0))
add(glow(lights, 34, 1.5)); add(glow(lights, 12, 1.4))
out.alpha_composite(bone); out.alpha_composite(tend); out.alpha_composite(arc); out.alpha_composite(lights)
img = out.resize((N, N), Image.LANCZOS)

# ---- macOS tile: squircle, thin rim, soft shadow
T = 824; tile = img.resize((T, T), Image.LANCZOS)
mask = Image.new('L', (T * 4, T * 4), 0); ImageDraw.Draw(mask).rounded_rectangle((0, 0, T * 4 - 1, T * 4 - 1), radius=185 * 4, fill=255); mask = mask.resize((T, T), Image.LANCZOS)
rim = Image.new('RGBA', (T, T), (0, 0, 0, 0)); ImageDraw.Draw(rim).rounded_rectangle((1, 1, T - 2, T - 2), radius=185, outline=(255, 255, 255, 40), width=2)
tile.alpha_composite(rim); tile.putalpha(mask)
icon = Image.new('RGBA', (N, N), (0, 0, 0, 0)); shm = Image.new('L', (N, N), 0); shm.paste(mask, (100, 112))
sh = Image.new('RGBA', (N, N), (0, 0, 0, 0)); sh.putalpha(shm.filter(ImageFilter.GaussianBlur(18)).point(lambda v: int(v * .5)))
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
