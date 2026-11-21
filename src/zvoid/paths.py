"""Where things live. Everything stays inside the project folder."""

from pathlib import Path

NAME = "Zvoid"                # display name (window title, header)

ROOT = Path(__file__).resolve().parents[2]
ENGINES_DIR = ROOT / "engines"   # engine definitions (engine.json + engine.py), tracked in git
ENVS_DIR = ROOT / ".envs"        # one isolated Python env per engine, created on install
OUTPUTS_DIR = ROOT / "outputs"   # everything you generate, one folder per run
UPLOADS_DIR = OUTPUTS_DIR / "_uploads"  # audio you drop in
PATCHES_DIR = ROOT / "patches"   # saved wiring
CREATURES_DIR = ROOT / "creatures"  # the gym: adapters trained on your audio
WEB_DIR = Path(__file__).resolve().parent / "web"
WORKER = Path(__file__).resolve().parent / "worker.py"

for d in (ENVS_DIR, OUTPUTS_DIR, UPLOADS_DIR, PATCHES_DIR, CREATURES_DIR):
    d.mkdir(exist_ok=True)
