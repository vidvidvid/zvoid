"""Generic worker. Runs INSIDE an engine's own Python env (stdlib only here).

Started as:  <engine-env>/bin/python -u -I worker.py <engine_dir> <out_root>

Protocol: one JSON object per line.
  in  (stdin):  {"cmd": "run", "params": {...}, "out_dir": "..."}   |  {"cmd": "ping"}
  out (stdout): {"type": "progress", "msg": str, "frac": float|None}
                {"type": "result", "outputs": [...], "info": {...}}
                {"type": "error", "error": str, "trace": str}
                {"type": "ready"} once the engine module imported
Anything the libraries print goes to stderr (the app's log), never to the protocol stream.
"""

import importlib.util
import json
import os
import sys
import traceback

# Keep a private handle on the real stdout for the protocol, then point fd 1 at stderr
_proto = os.fdopen(os.dup(1), "w", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr


def send(obj):
    _proto.write(json.dumps(obj, default=str) + "\n")
    _proto.flush()


class Ctx:
    def __init__(self, out_dir):
        self.out_dir = out_dir
        os.makedirs(out_dir, exist_ok=True)
        self.device = os.environ.get("SOUNDLAB_DEVICE", "auto")

    def progress(self, msg, frac=None):
        send({"type": "progress", "msg": str(msg), "frac": frac})

    def path(self, name):
        return os.path.join(self.out_dir, name)

    def torch_device(self):
        """Best device for torch: the user's choice, else MPS (Apple GPU), else CPU."""
        import torch

        if self.device not in ("auto", ""):
            return self.device
        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"


def main():
    engine_dir = sys.argv[1]
    sys.path.insert(0, engine_dir)
    sys.path.insert(1, os.path.join(os.path.dirname(os.path.abspath(engine_dir)), "_common"))
    spec = importlib.util.spec_from_file_location("engine", os.path.join(engine_dir, "engine.py"))
    engine = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(engine)
    except Exception as e:
        send({"type": "error", "error": f"Could not load engine: {e}", "trace": traceback.format_exc()})
        return
    send({"type": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if req.get("cmd") == "ping":
                send({"type": "pong"})
                continue
            ctx = Ctx(req["out_dir"])
            result = engine.run(req.get("params", {}), ctx) or {}
            send({"type": "result", "outputs": result.get("outputs", []), "info": result.get("info", {})})
        except Exception as e:
            send({"type": "error", "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()})


if __name__ == "__main__":
    main()
