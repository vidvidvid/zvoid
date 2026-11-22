"""Night shift: leave it running and wake up to a set of songs.

Every song is a fresh one, made the way that has given whole songs so far: ACE-Step text-to-music through a creature, with
its planner on, a caption built from the creature's own words plus a palette of sounds, and lyrics that are only section
tags and chant syllables (so there are voices and a shape, but no pop lyric). Nothing is looped or covered here: covers of
covers are where the results turned into noise.

Nothing in this program can hear, so there is no judge of taste. There is only a guard against outright failures (silence,
pure hiss, a clip that stops early): those are thrown away and made again. Everything else lands in the library as
"night <date> · NN · <name>" for the listener to go through in the morning.
"""
from __future__ import annotations

import json
import random
import subprocess
import threading
import time
import uuid
from pathlib import Path

from . import gym, library

_state: dict = {}      # the one night shift that can run at a time

DRUMS = ["pounding skin drums", "tribal stomp", "bone percussion", "hand drums", "war drums", "wood blocks and rattles", "heartbeat kick", "broken drum machine",
         "stone on stone", "clattering metal percussion", "floor toms", "frame drums"]
LOW = ["blown-out distorted bass", "sub pulse", "rubber bass", "droning low strings", "downtuned sludge guitar", "growling synth bass", "one bass note hammered"]
NOISE = ["shredded guitar feedback", "bowed metal", "glass harmonics", "granular dust", "overblown flute", "wind through pipes", "detuned organ", "siren swells",
         "scraped strings", "chopped tape", "bell cluster"]
VOICE = ["screamed and chanted gang vocals", "throat singing", "whispered chant", "call and response shouts", "wordless choir", "hocketing voices", "tongue clicks and breath",
         "one voice howling", "children's chant", "low growled vocal"]
MOVES = ["sudden silences", "tempo lurches", "polyrhythm in seven", "half-time drops", "double-time bursts", "long build", "stop-start riffs", "everything collapses and returns"]
MOODS = ["raw", "feral", "ritual", "unhinged", "ecstatic", "menacing", "trance", "joyful and violent", "mournful", "possessed", "lo-fi", "no polish", "huge", "close and dry"]
SYL = ["ha", "hey", "oom", "ka", "ya", "ho", "ah", "eh", "za", "ko", "mi", "ra", "tu", "sha", "wo", "ne", "gra", "ti", "lo", "ba"]
FORMS = [
    ["intro - slow heartbeat drum, breathing", "verse", "build - rising, faster", "chorus - everyone, full stomp", "breakdown - everything stops, one drum, whispering", "chorus - twice as heavy", "outro - collapse into feedback"],
    ["intro - one voice alone", "verse", "chorus", "verse - drums double", "chorus", "bridge - silence then a scream", "chorus - everything", "outro - voices only"],
    ["intro - noise swelling", "drop - full band", "verse", "chorus", "breakdown - bass and breath", "build", "chorus", "outro - one drum fading"],
    ["chant - voices and hand drums", "verse - bass enters", "chorus - explosion", "chant", "verse", "chorus", "collapse", "chant - far away"],
    ["intro - slow and huge", "verse - slow", "sudden change - fast", "chorus - fast", "breakdown - slow again", "chorus - fastest", "outro"],
]


def _chant(rng, lines=(2, 4)):
    out = []
    for _ in range(rng.randint(*lines)):
        a, b = rng.sample(SYL, 2)
        pat = rng.choice([f"{a.upper()}! {a.upper()}! {b}-{a} {b}-{a}", f"{a.upper()} {b} {a.upper()} {b}", f"{a}-{a}-{a}-{a}-{a}", f"{a.upper()}{a}-{b.upper()}! {a.upper()}{a}-{b.upper()}!", f"{a}... {b}... {a}...", f"{b.upper()}! {a} {a} {b.upper()}!"])
        out.append(pat)
    return out


def recipe(creature: str, direction: str = "", rng=None) -> dict:
    """One song's settings. Different every time, always in the shape that has worked."""
    rng = rng or random.Random()
    c = gym._load(creature) if creature else {}
    limbs = c.get("limbs") or []
    picked = []                                                  # one or two of its sides, the well-fed ones more often
    pool = [l for l in limbs]
    for _ in range(min(len(pool), rng.choice([1, 2, 2]))):
        l = rng.choices(pool, weights=[max(1, x.get("count", 1)) for x in pool])[0]
        picked.append(l)
        pool.remove(l)
    bpm = int(max(60, min(190, (picked[0]["mean"].get("bpm") if picked else 120) * rng.choice([.5, 1, 1, 1, 1.25]) + rng.randint(-8, 8))))
    palette = [rng.choice(DRUMS), rng.choice(DRUMS), rng.choice(LOW), *rng.sample(NOISE, 2), *rng.sample(VOICE, 2), *rng.sample(MOVES, 2), *rng.sample(MOODS, 4)]
    palette = list(dict.fromkeys(palette))
    words = [l["trigger"] for l in picked] or ([c.get("tag")] if c.get("tag") else [])
    caption = ", ".join(x for x in [*words, f"{bpm} bpm", *palette, direction.strip()] if x)
    form, lyr = rng.choice(FORMS), []
    hook = _chant(rng, (2, 3))                                   # the chorus comes back the same, like a chorus
    for sec in form:
        lyr.append(f"[{sec}]")
        lyr += hook if sec.startswith("chorus") else _chant(rng, (1, 3)) if not sec.startswith(("intro", "outro", "collapse")) else _chant(rng, (1, 1))
        lyr.append("")
    a, b = rng.sample(SYL, 2)
    return {"name": f"{a}{b} {rng.choice(SYL)}{rng.choice(SYL)}".upper(),
            "params": {"task": "text2music", "caption": caption, "lyrics": "\n".join(lyr).strip(), "duration": rng.choice([120, 135, 150, 150, 165, 180]), "bpm": bpm,
                       "thinking": True, "batch": 1, "seed": rng.randint(1, 2 ** 31 - 1), "creature": creature, "creature_strength": round(rng.uniform(1.45, 1.85), 2)}}


def broken(path: str, wanted: float) -> str:
    """Why a result is not a song at all, or "" if it passes. This is a guard against failures, not a judge of taste."""
    try:
        import numpy as np
        import soundfile as sf
        x, sr = sf.read(path, always_2d=True, dtype="float32")
        if len(x) / sr < wanted * .5:
            return "it stopped early"
        m = x.mean(1)
        if not np.isfinite(m).all():
            return "it is not valid audio"
        if float(np.sqrt((m ** 2).mean())) < .01:
            return "it is silent"
        f = gym.features(Path(path))
        if f.get("noise", 0) > .85 and f.get("tonal", 1) < .15 and f.get("steady", 1) < .2:
            return "it is plain hiss"
        h = sr * 5
        e = np.sqrt((m[:len(m) // h * h].reshape(-1, h) ** 2).mean(1))
        if len(e) > 6 and float(e[len(e) // 2:].mean()) < float(e[:len(e) // 2].mean()) * .08:
            return "it dies halfway through"
    except Exception as ex:
        return f"it could not be read ({ex})"
    return ""


def status() -> dict:
    s = {k: v for k, v in _state.items() if k not in ("job", "stop")}
    return s or {"running": False}


def stop():
    if _state.get("running"):
        _state["stop"] = True
        if _state.get("job"):
            _state["job"]["cancel"] = True


def start(engines: dict, jobs: dict, coerce, creature: str, count: int = 10, direction: str = "") -> dict:
    if _state.get("running"):
        raise RuntimeError("a night shift is already running")
    e = engines.get("ace_step")
    if not e or not e.installed:
        raise RuntimeError("ACE-Step is not installed")
    if not creature or not gym.adapter_path(creature):
        raise RuntimeError("pick a trained creature")
    count = max(1, min(200, int(count)))
    job = {"id": uuid.uuid4().hex[:12], "engine": "night shift", "state": "running", "msg": "starting", "frac": 0, "outputs": [], "info": {}, "error": None, "seed": None, "cancel": False}
    jobs[job["id"]] = job
    tag = time.strftime("night %Y-%m-%d")
    _state.clear()
    _state.update(running=True, creature=creature, count=count, made=0, thrown=0, msg="starting…", started=time.time(), songs=[], tag=tag, job=job, stop=False, error=None, per=None)

    def work():
        awake = None
        try:
            awake = subprocess.Popen(["caffeinate", "-i", "-s"])       # this Mac stays awake for as long as the shift runs
        except Exception:
            pass
        rng, fails = random.Random(), 0
        try:
            while _state["made"] < count and not _state["stop"]:
                r = recipe(creature, direction, rng)
                n = _state["made"] + 1
                _state["msg"] = f"song {n} of {count} · “{r['name']}”"
                job.update(msg=_state["msg"], frac=_state["made"] / count)
                label = f"{tag} · {n:02d} · {r['name']}"
                run = library.new_run_dir("ace_step", label)
                t0 = time.time()
                try:
                    params = gym.bred_boost(coerce(e.spec, r["params"]))
                    outs, info = [], {}
                    for ev in e.run(params, run):
                        if _state["stop"]:
                            break
                        if ev[0] == "progress":
                            _state["msg"] = f"song {n} of {count} · “{r['name']}” · {ev[1]}"
                        else:
                            outs, info = ev[1], ev[2]
                    if _state["stop"]:
                        break
                    if not outs:
                        raise RuntimeError("nothing came back")
                    why = broken(outs[0]["path"], float(r["params"]["duration"]))
                    if why:
                        _state["thrown"] += 1
                        print(f"[night] threw one away: {why}", flush=True)
                        for f in run.iterdir():
                            f.unlink()
                        run.rmdir()
                        if _state["thrown"] > count * 2 + 6:
                            raise RuntimeError("too many results came out broken: stopping")
                        continue
                    secs = round(time.time() - t0, 1)
                    library.write_meta(run, {"engine": "ace_step", "engine_name": "night shift", "created": time.strftime("%Y-%m-%d %H:%M:%S"), "label": label,
                                             "params": params, "outputs": outs, "info": info, "seconds": secs})
                    _state["made"] = n
                    _state["songs"].append({"n": n, "name": r["name"], "path": outs[0]["path"], "seconds": secs})
                    _state["per"] = round((time.time() - _state["started"]) / n, 1)
                    fails = 0
                except Exception as ex:
                    fails += 1
                    print("[night] a song failed: " + str(ex).strip()[-600:], flush=True)
                    try:
                        if run.exists() and not any(run.iterdir()):
                            run.rmdir()
                    except Exception:
                        pass
                    if fails >= 4:                               # four in a row: something is really wrong, do not hammer on all night
                        _state["error"] = str(ex).strip().splitlines()[0][:300]
                        break
                    time.sleep(20)
            _state["msg"] = "stopped" if _state["stop"] else ("stopped: " + _state["error"]) if _state["error"] else f"done: {_state['made']} songs are in the library"
        finally:
            _state.update(running=False, finished=time.time())
            job.update(state="cancelled" if _state.get("stop") else "error" if _state.get("error") else "done", msg=_state["msg"], frac=1)
            if awake:
                awake.terminate()

    threading.Thread(target=work, daemon=True).start()
    return status()
