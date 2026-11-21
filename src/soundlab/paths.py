"""Where Soundlab keeps things. Everything lives inside the project folder."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENGINES_DIR = ROOT / "engines"   # engine definitions (engine.json + engine.py), tracked in git
ENVS_DIR = ROOT / ".envs"        # one isolated Python env per engine, created on install
OUTPUTS_DIR = ROOT / "outputs"   # everything you generate, one folder per run
WORKER = Path(__file__).resolve().parent / "worker.py"

for d in (ENVS_DIR, OUTPUTS_DIR):
    d.mkdir(exist_ok=True)
