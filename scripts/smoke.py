"""Headless smoke test: uv run python scripts/smoke.py <engine> '<json params>'"""
import json, sys, time
from zvoid.engines import discover
from zvoid import library

eid, params = sys.argv[1], json.loads(sys.argv[2] if len(sys.argv) > 2 else "{}")
e = discover()[eid]
d = library.new_run_dir(eid, "smoke")
t = time.time()
for ev in e.run(dict(params, extra=params.get("extra", {})), d):
    print(ev, flush=True)
library.write_meta(d, {"engine": eid, "engine_name": e.name, "created": time.strftime("%Y-%m-%d %H:%M:%S"),
                       "label": "smoke test", "params": params, "outputs": ev[1], "info": ev[2], "seconds": round(time.time()-t,1)})
print("seconds", round(time.time() - t, 1))
e.stop()
