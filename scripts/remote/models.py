"""Download what training needs: the ACE-Step main model and the turbo DiT. Run inside the ACE-Step env on the PC."""
import os, sys
from pathlib import Path
M = Path(__file__).resolve().parent / "models" / "ace_step"   # zvoid\app\models\ace_step
M.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("ACESTEP_PROJECT_ROOT", str(M)); os.environ.setdefault("ACESTEP_CHECKPOINTS_DIR", str(M / "checkpoints")); os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
from acestep import model_downloader as md
ck = M / "checkpoints"
if not md.check_main_model_exists(ck):
    print("downloading main model…", flush=True); ok, msg = md.ensure_main_model(ck, prefer_source="huggingface"); print(ok, msg, flush=True)
    if not ok: sys.exit(1)
if not md.check_model_exists("acestep-v15-turbo", ck):
    print("downloading turbo DiT…", flush=True); ok, msg = md.ensure_dit_model("acestep-v15-turbo", checkpoints_dir=ck, prefer_source="huggingface"); print(ok, msg, flush=True)
    if not ok: sys.exit(1)
print("models ready:", sorted(p.name for p in ck.iterdir()), flush=True)
