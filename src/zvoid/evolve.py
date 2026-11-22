"""Evolve: breed a sound over many rounds.

A session starts from one clip. Each round, ACE-Step makes a handful of mutations of the current parent (a cover of it,
played through a creature, each one a different distance away and pushed by a few random ideas). You pick the one that is
most alive; it becomes the parent of the next round. Nothing here can hear, so the listener chooses. Everything is kept
as a family tree, so any earlier sound can be gone back to and grown in another direction.

Sessions live in outputs/_evolve/<id>/ (session.json plus the audio), outside the library until a sound is kept.
"""
from __future__ import annotations

import json
import random
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from . import gym, library
from .paths import OUTPUTS_DIR

DIR = OUTPUTS_DIR / "_evolve"
_lock = threading.Lock()
_live: dict = {}      # session id -> what its running round is doing right now

# ideas a mutation can be pushed by: sounds, patterns and spaces, never genres (a genre pulls toward what already exists)
IDEAS = ["polyrhythm in seven", "stuttering", "bone percussion", "throat singing", "metallic resonance", "granular dust",
         "sub pulse", "call and response", "breathing rhythm", "detuned", "insect chorus", "stone and water", "elastic tempo",
         "broken machine", "ritual chant", "glass harmonics", "feedback howl", "hocketing voices", "microtonal drone",
         "hand drums", "whispered", "bowed metal", "clicks and pops", "heartbeat kick", "swarm", "liquid bass",
         "choir of machines", "wood blocks", "distant sirens", "reverse swells", "bell cluster", "chopped voice",
         "dry and close", "cavernous", "half-time", "double-time", "skin drums", "rubber bass", "tongue clicks",
         "wind through pipes", "overblown flute", "rattles and shakers", "one note hammered", "sudden silence"]
STEPS = (("close", .18), ("near", .42), ("far", .68), ("wild", .95))   # how far each of a round's mutations strays


def _file(sid: str) -> Path:
    if not re.fullmatch(r"[a-z0-9]{6,16}", sid):
        raise FileNotFoundError("no such session")
    f = DIR / sid / "session.json"
    if not f.exists():
        raise FileNotFoundError("no such session")
    return f


def _load(sid: str) -> dict:
    return json.loads(_file(sid).read_text())


def _save(s: dict):
    (DIR / s["id"] / "session.json").write_text(json.dumps(s, indent=1, ensure_ascii=False))


def _view(s: dict) -> dict:
    return dict(s, live=_live.get(s["id"]))


def sessions() -> list[dict]:
    out = []
    for f in sorted(DIR.glob("*/session.json"), key=lambda p: -p.stat().st_mtime):
        try:
            s = json.loads(f.read_text())
            out.append({"id": s["id"], "name": s["name"], "creature": s.get("creature", ""), "rounds": max((n["round"] for n in s["nodes"].values()), default=0),
                        "when": f.stat().st_mtime, "live": bool(_live.get(s["id"]))})
        except Exception:
            continue
    return out


def get(sid: str) -> dict:
    return _view(_load(sid))


def start(source: str = "", creature: str = "", direction: str = "", name: str = "", limb=None) -> dict:
    """Begin from a clip (any audio in the outputs folder), or from a passage of a creature's own tracks."""
    sid = uuid.uuid4().hex[:10]
    d = DIR / sid
    d.mkdir(parents=True)
    try:
        if source:
            src = Path(source)
            title = name or src.stem
        else:
            if not creature:
                raise ValueError("give it a clip or a creature to start from")
            sd = gym.seed(creature, limb)
            src, title = Path(sd["path"]), name or f"{creature} · {Path(sd['tracks'][0]).stem}"
        root = d / f"r0_seed{src.suffix.lower() or '.wav'}"
        shutil.copy(src, root)                               # its own copy, so nothing that happens to the original can break the tree
        s = {"id": sid, "name": title[:80], "creature": creature, "direction": direction.strip(), "wild": .5, "created": time.strftime("%Y-%m-%d %H:%M:%S"),
             "head": "n0", "nodes": {"n0": {"id": "n0", "parent": None, "round": 0, "path": str(root), "what": "where it started", "picked": True}}}
        _save(s)
        return _view(s)
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise


def update(sid: str, patch: dict) -> dict:
    with _lock:
        s = _load(sid)
        for k in ("direction", "creature", "name"):
            if k in patch:
                s[k] = str(patch[k]).strip()[:400]
        if "wild" in patch:
            s["wild"] = min(1.0, max(0.0, float(patch["wild"])))
        _save(s)
    return _view(s)


def pick(sid: str, nid: str) -> dict:
    """This one lives: it becomes the parent of the next round. Picking an older sound goes back to that branch."""
    with _lock:
        s = _load(sid)
        if nid not in s["nodes"]:
            raise FileNotFoundError("that sound is not in this session")
        s["nodes"][nid]["picked"] = True
        s["head"] = nid
        _save(s)
    return _view(s)


def keep(sid: str, nid: str) -> dict:
    """Put a sound from the tree into the library, named after the session and the round it came from."""
    s = _load(sid)
    n = s["nodes"][nid]
    title = f"{s['name']} · evolved, round {n['round']}"
    run = library.new_run_dir("ace_step", title)
    dst = run / f"evolved_r{n['round']}_{nid}{Path(n['path']).suffix}"
    shutil.copy(n["path"], dst)
    library.write_meta(run, {"engine": "ace_step", "engine_name": "evolved", "created": time.strftime("%Y-%m-%d %H:%M:%S"), "label": title,
                             "params": dict(n.get("params") or {}, creature=s.get("creature", "")), "outputs": [{"path": str(dst)}], "info": {}, "seconds": 0})
    with _lock:
        s = _load(sid)
        s["nodes"][nid]["kept"] = str(dst)
        _save(s)
    return {"path": str(dst), "title": title}


def remove(sid: str):
    _file(sid)
    if _live.get(sid):
        raise RuntimeError("a round is running in that session")
    dst = Path.home() / ".Trash" / f"zvoid evolve {sid}"
    shutil.move(str(DIR / sid), str(dst))


def _words(creature: str) -> list[str]:
    """What to call the creature in a caption: its own word, and its parents' while it has not trained since it was bred."""
    if not creature:
        return []
    try:
        c = gym._load(creature)
    except Exception:
        return []
    w = [c.get("tag") or creature]
    if c.get("parents"):
        w += [gym.slugify(p) for p in c["parents"]]
    return w + ([c["style"].strip(" ,\n")] if (c.get("style") or "").strip(" ,\n") else [])


def plan(s: dict, n: int = 4) -> list[dict]:
    """The mutations of one round: each a different distance from the parent, each pushed by its own few ideas."""
    wild, creature = float(s.get("wild", .5)), s.get("creature", "")
    trained = bool(creature and gym.adapter_path(creature))
    out = []
    for name, d0 in STEPS[:n]:
        d = min(1.0, max(0.0, d0 * (.55 + .9 * wild) + random.uniform(-.06, .06)))
        ideas = random.sample(IDEAS, k=round(d * 3)) if d > .12 else []
        mix = lambda a, b: a + (b - a) * d
        params = {"task": "cover", "caption": ", ".join(x for x in [*_words(creature), s.get("direction", ""), *ideas] if x), "lyrics": "[Instrumental]",
                  "thinking": False, "batch": 1, "seed": random.randint(1, 2 ** 31 - 1), "creature": creature if trained else "",
                  "cover_strength": round(mix(.8, .15), 2), "cover_noise_strength": round(mix(.45, .08), 2),
                  "creature_strength": round(mix(1.05, 2.0), 2) if trained else 1}
        out.append({"name": name, "ideas": ideas, "params": params})
    return out


def round_(sid: str, engines: dict, jobs: dict, coerce, n: int = 4) -> dict:
    """Make the next round from the current parent. Returns at once; the session reports the round's progress as it goes."""
    with _lock:
        if _live.get(sid):
            raise RuntimeError("a round is already running here")
        s = _load(sid)
        parent = s["nodes"][s["head"]]
        if not Path(parent["path"]).exists():
            raise FileNotFoundError("the parent sound is gone")
        e = engines.get("ace_step")
        if not e or not e.installed:
            raise RuntimeError("ACE-Step is not installed")
        rnd = parent["round"] + 1
        todo = plan(s, n)
        live = _live[sid] = {"round": rnd, "parent": parent["id"], "done": 0, "total": len(todo), "msg": "starting…", "frac": None, "error": None, "made": []}
        job = {"id": uuid.uuid4().hex[:12], "engine": "evolve", "state": "running", "msg": f"round {rnd}", "frac": 0, "outputs": [], "info": {}, "error": None, "seed": None, "cancel": False}
        jobs[job["id"]] = job
        live["job"] = job["id"]

    try:
        import soundfile as sf
        dur = min(60.0, max(6.0, sf.info(parent["path"]).duration))
    except Exception:
        dur = 14.0

    def work():
        d = DIR / sid
        try:
            for i, v in enumerate(todo):
                if job["cancel"]:
                    break
                live.update(msg=f"{v['name']} ({i + 1} of {len(todo)})", frac=None)
                params = gym.bred_boost(coerce(e.spec, dict(v["params"], src_audio=parent["path"], duration=round(dur, 1))))
                tmp = d / f"_tmp_{uuid.uuid4().hex[:6]}"
                tmp.mkdir()
                outs = []
                for ev in e.run(params, tmp):
                    if ev[0] == "progress":
                        live.update(msg=f"{v['name']} ({i + 1} of {len(todo)}) · {ev[1]}", frac=ev[2])
                        job.update(msg=f"round {rnd}: {v['name']}", frac=(i + (ev[2] or 0)) / len(todo))
                    else:
                        outs = ev[1]
                if not outs:
                    raise RuntimeError("nothing came back")
                nid = f"n{uuid.uuid4().hex[:8]}"
                src = Path(outs[0]["path"])
                dst = d / f"r{rnd}_{v['name']}_{nid}{src.suffix}"
                shutil.move(str(src), str(dst))
                shutil.rmtree(tmp, ignore_errors=True)
                what = v["name"] + (" · " + ", ".join(v["ideas"]) if v["ideas"] else "")
                with _lock:
                    s2 = _load(sid)
                    s2["nodes"][nid] = {"id": nid, "parent": parent["id"], "round": rnd, "path": str(dst), "what": what, "step": v["name"], "ideas": v["ideas"], "picked": False,
                                        "params": {k: params.get(k) for k in ("caption", "cover_strength", "cover_noise_strength", "creature_strength", "seed", "creature")}}
                    _save(s2)
                live["done"] = i + 1
                live["made"].append(nid)
            job.update(state="cancelled" if job["cancel"] else "done", msg="stopped" if job["cancel"] else f"round {rnd} ready", frac=1)
        except Exception as ex:
            print("[job] evolve failed: " + str(ex).strip()[-1200:], flush=True)
            job.update(state="error", error=str(ex), msg="failed")
            live["error"] = str(ex).strip().splitlines()[-1][:300] if str(ex).strip() else "it failed"
            time.sleep(6)                                    # leave the reason up long enough to be read
        finally:
            for t in d.glob("_tmp_*"):
                shutil.rmtree(t, ignore_errors=True)
            _live.pop(sid, None)

    threading.Thread(target=work, daemon=True).start()
    return get(sid)


def stop(sid: str, jobs: dict):
    live = _live.get(sid)
    if live and live.get("job") in jobs:
        jobs[live["job"]]["cancel"] = True
