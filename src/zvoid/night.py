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
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

from . import chat, gym, library
from .paths import OUTPUTS_DIR

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


DIR = OUTPUTS_DIR / "_night"      # tries live here, outside the library; only the finished songs are moved into it
VEC = ("tonal", "dist", "steady", "harm", "voice", "attack", "change", "noise", "dyn", "low", "bright", "wide")

IDEAS_SCHEMA = {"type": "object", "required": ["songs"], "properties": {"songs": {"type": "array", "items": {"type": "object",
    "required": ["title", "creature", "idea", "caption", "lyrics", "bpm", "duration"],
    "properties": {"title": {"type": "string"}, "creature": {"type": "string"}, "idea": {"type": "string"}, "caption": {"type": "string"},
                   "lyrics": {"type": "string"}, "bpm": {"type": "integer"}, "duration": {"type": "integer"}}}}}}
REVISE_SCHEMA = {"type": "object", "required": ["keep", "caption", "lyrics", "bpm", "note"],
                 "properties": {"keep": {"type": "boolean"}, "caption": {"type": "string"}, "lyrics": {"type": "string"}, "bpm": {"type": "integer"}, "note": {"type": "string"}}}
HOUSE = """You write song plans for ACE-Step, a text-to-music model, played through "creatures" (adapters trained on one artist's sound).
How a plan is written:
- caption: comma-separated tags. It MUST begin with one or two of the chosen creature's own words, exactly as given (they wake the adapter up). Then the tempo ("148 bpm"), then 9-14 concrete sound tags: which drums and how they behave, the low end, the noises and instruments, the voices, how the song moves, the mood. Never a genre name, never an artist or band name: those pull the model back to music that already exists.
- lyrics: section tags in square brackets, each with a short hint of what happens, e.g. "[intro - one drum, breathing]", "[chorus - everyone, full stomp]". Under each tag, 1-4 lines of chant syllables or invented words (HA! oom-ka, zra ko mi). No real words in any language. A chorus repeats the same lines each time it returns. 5-9 sections.
- Say in the section hints where drums come in, drop out and come back: these songs need drums that arrive and leave, not a wash of texture.
- duration: 110 to 190 seconds. bpm: 55 to 190.
What makes a result fail here: no rhythm at all, one unbroken texture, plain noise. Every song needs a pulse somewhere and a shape with contrast."""


def _sides(slug: str) -> str:
    c = gym._load(slug)
    return f'{slug} — its words: ' + "; ".join(f'"{l["trigger"]}" ({", ".join(l["tags"])}, about {round(l["mean"]["bpm"])} bpm, {l["count"]} tracks)' for l in c.get("limbs", []))


def ideas(creatures: list[str], count: int, direction: str, rng) -> list[dict]:
    """The collection's songs, as different from one another as they can be. Claude writes them; if it is not there, they are drawn from the built-in palettes."""
    out = []
    try:
        while len(out) < count:
            n = min(10, count - len(out))
            prompt = (f"Plan {n} songs for one collection of {count}. Direction from the artist: {direction or 'music nobody has heard before'}\n\n"
                      "Creatures to use, spread evenly over the songs (one creature per song):\n" + "\n".join(_sides(c) for c in creatures) + "\n\n"
                      "The songs must be " + str(n) + " different IDEAS, not variations of one: vary the tempo widely (some very slow, some frantic, some that change), "
                      "what leads (drums, a voice, the bass, a noise, silence), how dense it is, the form, and the mood. No two songs may share a tempo band, a lead and a form.\n"
                      + ("Already planned, so do not repeat their ideas:\n" + "\n".join(f'- {x["title"]}: {x["idea"]} ({x["bpm"]} bpm, {x["creature"]})' for x in out) + "\n" if out else "")
                      + 'For each: a short title of invented words, the creature, "idea" (one plain sentence saying what makes this one different), caption, lyrics, bpm, duration.')
            got = chat.think(HOUSE, prompt, IDEAS_SCHEMA, 420).get("songs") or []
            if not got:
                break
            out += got[:n]
    except Exception as ex:
        print("[night] Claude could not write the ideas, using the built-in ones: " + str(ex)[:200], flush=True)
    songs = []
    for k in range(count):
        who = creatures[k % len(creatures)]
        if k < len(out):
            x = dict(out[k])
            if x.get("creature") not in creatures:
                x["creature"] = who
            songs.append(_fit(x, rng))
        else:
            r = recipe(who, direction, rng)
            songs.append(_fit({"title": r["name"], "creature": who, "idea": "drawn from the built-in palettes", "caption": r["params"]["caption"], "lyrics": r["params"]["lyrics"],
                               "bpm": r["params"]["bpm"], "duration": r["params"]["duration"]}, rng))
    return songs


def _fit(x: dict, rng) -> dict:
    """Keep a plan inside what works: the creature's word at the front, sane tempo and length."""
    c = gym._load(x["creature"])
    words = [l["trigger"] for l in c.get("limbs", [])] or [c.get("tag") or x["creature"]]
    cap = " ".join(str(x.get("caption") or "").split())
    if not any(w in cap for w in words):
        limbs = c.get("limbs") or []
        cap = (rng.choices(limbs, weights=[max(1, l.get("count", 1)) for l in limbs])[0]["trigger"] if limbs else words[0]) + ", " + cap
    x.update(caption=cap[:900], bpm=int(max(55, min(190, int(x.get("bpm") or 120)))), duration=int(max(100, min(200, int(x.get("duration") or 150)))),
             title=" ".join(str(x.get("title") or "untitled").split())[:40], lyrics=str(x.get("lyrics") or "[Instrumental]")[:3000])
    return x


def measure(path: str) -> dict:
    """What can be told about a result without hearing it."""
    import numpy as np
    import soundfile as sf
    f = gym.features(Path(path))
    x, sr = sf.read(path, always_2d=True, dtype="float32")
    m, h = x.mean(1), sr * 5
    e = np.sqrt((m[:len(m) // h * h].reshape(-1, h) ** 2).mean(1)) if len(m) > h * 3 else np.array([1.0])
    db = 20 * np.log10(e + 1e-6)
    return dict({k: round(float(f.get(k, 0)), 3) for k in (*VEC, "bpm", "secs", "loud")}, contrast=round(float(db.max() - db.min()), 1), sections=[round(float(v), 1) for v in db - db.max()][:40])


def score(m: dict, others: list[dict]) -> dict:
    """A stand-in for judgement, made of things that can be measured: does it have drums and a pulse, does it have contrast,
    and is it unlike the songs already finished. It cannot tell a good song from a dull one."""
    drums = .5 * min(1, max(0, (m["attack"] - .06) / .22)) + .5 * min(1, m["steady"] / .6)
    shape = min(1, m["contrast"] / 9)
    far, near = 1.0, None
    for o in others:
        d = (sum((m[k] - o["m"][k]) ** 2 for k in VEC) / len(VEC) + ((m["bpm"] - o["m"]["bpm"]) / 200) ** 2) ** .5
        if d < far:
            far, near = d, o["title"]
    variety = min(1, far / .22) if others else 1.0
    return {"total": round(.4 * drums + .25 * shape + .35 * variety, 3), "drums": round(drums, 2), "shape": round(shape, 2), "variety": round(variety, 2), "nearest": near}


def revise(song: dict, m: dict, sc: dict, tries_left: int, rng) -> dict:
    """What to change for the next try. Claude reads the measurements and rewrites the plan; without it, drums are added by rule."""
    try:
        said = lambda v, lo, hi: "low" if v < lo else "high" if v > hi else "middling"
        prompt = (f'Song: "{song["title"]}" for the creature {song["creature"]}. Its idea: {song["idea"]}\n\nCAPTION\n{song["caption"]}\n\nLYRICS\n{song["lyrics"]}\n\n'
                  f"It was made, and measured (nobody has heard it; these numbers are all there is):\n"
                  f'- sharp drum hits: {m["attack"]} ({said(m["attack"], .12, .3)}; under 0.12 means almost no drums can be found)\n'
                  f'- steady pulse: {m["steady"]} ({said(m["steady"], .3, .7)})\n- tempo found: {m["bpm"]} bpm (asked for {song["bpm"]})\n'
                  f'- clear pitches vs noise: tonal {m["tonal"]}, hiss {m["noise"]}\n- voice-like movement: {m["voice"]}\n- how squashed and distorted: {m["dist"]}\n'
                  f'- loudness through the song in 5-second steps, in dB below its loudest: {m["sections"]}\n  (contrast {m["contrast"]} dB; under 4 means it never really changes)\n'
                  + (f'- the finished song it is most like: "{sc["nearest"]}" (variety {sc["variety"]}, 1 = very different)\n' if sc.get("nearest") else "")
                  + f"\nTries left for this song: {tries_left}. The artist heard a song that measured 0.12 for drum hits and said it needed more drums, so merely detectable is not enough: aim for drum hits of 0.2 or more in the parts where drums play. Answer keep=true only if drum hits are at least 0.2, contrast is at least 5 dB and it is unlike the others (still return the caption, lyrics and bpm unchanged).\n"
                  "Otherwise rewrite the caption and lyrics to fix what the numbers show, keeping the idea and the creature's words at the front. Say in one sentence what you changed and why.")
        r = chat.think(HOUSE, prompt, REVISE_SCHEMA, 240)
        if r.get("keep"):
            return {"keep": True, "note": r.get("note") or "kept"}
        return {"keep": False, "note": (r.get("note") or "")[:300], "song": _fit(dict(song, caption=r.get("caption") or song["caption"], lyrics=r.get("lyrics") or song["lyrics"], bpm=r.get("bpm") or song["bpm"]), rng)}
    except Exception as ex:
        cap = song["caption"]
        if sc["drums"] < .5:
            cap += ", " + ", ".join(rng.sample(DRUMS, 2)) + ", drums up front, hard hits"
        return {"keep": False, "note": "by rule (Claude did not answer: " + str(ex)[:80] + ")", "song": dict(song, caption=cap)}


def status() -> dict:
    s = {k: v for k, v in _state.items() if k not in ("job", "stop")}
    return s or {"running": False}


def stop():
    if _state.get("running"):
        _state["stop"] = True
        if _state.get("job"):
            _state["job"]["cancel"] = True


def start(engines: dict, jobs: dict, coerce, creatures, count: int = 10, direction: str = "", tries: int = 1, name: str = "") -> dict:
    """Make a collection. Every song starts as its own idea and gets up to `tries` goes: made, measured, revised, made again.
    The best go of each is the song; only those reach the library."""
    if _state.get("running"):
        raise RuntimeError("a night shift is already running")
    e = engines.get("ace_step")
    if not e or not e.installed:
        raise RuntimeError("ACE-Step is not installed")
    creatures = [c for c in ([creatures] if isinstance(creatures, str) else list(creatures or [])) if c and gym.adapter_path(c)]
    if not creatures:
        raise RuntimeError("pick at least one trained creature")
    count, tries = max(1, min(200, int(count))), max(1, min(8, int(tries)))
    sid = uuid.uuid4().hex[:10]
    d = DIR / sid
    d.mkdir(parents=True)
    job = {"id": uuid.uuid4().hex[:12], "engine": "night shift", "state": "running", "msg": "starting", "frac": 0, "outputs": [], "info": {}, "error": None, "seed": None, "cancel": False}
    jobs[job["id"]] = job
    tag = (name.strip() or time.strftime("collection %Y-%m-%d"))[:50]
    _state.clear()
    _state.update(running=True, id=sid, creatures=creatures, creature=creatures[0], count=count, tries=tries, made=0, thrown=0, msg="starting…", started=time.time(), songs=[], tag=tag,
                  job=job, stop=False, error=None, per=None)
    sheet = {"id": sid, "name": tag, "creatures": creatures, "direction": direction, "tries": tries, "started": time.strftime("%Y-%m-%d %H:%M:%S"), "songs": []}
    save = lambda: (d / "collection.json").write_text(json.dumps(sheet, indent=1, ensure_ascii=False))

    def make(song, where: Path, strength: float, seed: int):
        params = gym.bred_boost(coerce(e.spec, {"task": "text2music", "caption": song["caption"], "lyrics": song["lyrics"], "duration": song["duration"], "bpm": song["bpm"],
                                                "thinking": True, "batch": 1, "seed": seed, "creature": song["creature"], "creature_strength": strength}))
        outs = []
        for ev in e.run(params, where):
            if _state["stop"]:
                return None, params
            if ev[0] == "progress":
                _state["msg"] = _state["msg"].split(" · now: ")[0] + " · now: " + str(ev[1])[:60]
            else:
                outs = ev[1]
        if not outs:
            raise RuntimeError("nothing came back")
        return outs[0]["path"], params

    def work():
        awake = None
        try:
            awake = subprocess.Popen(["caffeinate", "-i", "-s"])       # this Mac stays awake for as long as the shift runs
        except Exception:
            pass
        rng, fails = random.Random(), 0
        try:
            _state["msg"] = f"writing {count} different ideas…"
            job.update(msg=_state["msg"])
            plan = ideas(creatures, count, direction, rng)
            sheet["ideas"] = [{k: x[k] for k in ("title", "creature", "idea", "bpm", "duration")} for x in plan]
            save()
            done = []                                              # finished songs: {title, m}
            for n, song in enumerate(plan, 1):
                if _state["stop"] or _state["error"]:
                    break
                entry = {"n": n, "title": song["title"], "creature": song["creature"], "idea": song["idea"], "tries": []}
                best, strength = None, round(rng.uniform(1.45, 1.85), 2)
                t = 0
                while t < tries and not _state["stop"]:
                    _state["msg"] = f"song {n} of {count} · “{song['title']}” · try {t + 1} of {tries}"
                    job.update(msg=_state["msg"], frac=((n - 1) + t / tries) / count)
                    where = d / f"s{n:02d}_t{t + 1}_{uuid.uuid4().hex[:4]}"
                    where.mkdir()
                    try:
                        path, params = make(song, where, strength, rng.randint(1, 2 ** 31 - 1))
                        if path is None:
                            break
                        why = broken(path, float(song["duration"]))
                        if why:
                            _state["thrown"] += 1
                            entry["tries"].append({"try": t + 1, "thrown": why})
                            shutil.rmtree(where, ignore_errors=True)
                            if _state["thrown"] > count * tries + 8:
                                raise RuntimeError("too many results came out broken")
                            t += 1
                            continue
                        m = measure(path)
                        sc = score(m, done)
                        entry["tries"].append({"try": t + 1, "score": sc, "caption": song["caption"], "bpm": song["bpm"], "m": {k: m[k] for k in ("attack", "steady", "bpm", "tonal", "noise", "voice", "contrast")}})
                        if not best or sc["total"] > best["sc"]["total"]:
                            if best:
                                shutil.rmtree(Path(best["path"]).parent, ignore_errors=True)
                            best = {"path": path, "params": params, "m": m, "sc": sc, "song": dict(song)}
                        else:
                            shutil.rmtree(where, ignore_errors=True)
                        fails = 0
                        t += 1
                        if t < tries:
                            _state["msg"] = f"song {n} of {count} · “{song['title']}” · reading its measurements"
                            rv = revise(best["song"], best["m"], best["sc"], tries - t, rng)
                            entry["tries"][-1]["then"] = rv["note"]
                            if rv["keep"] and best["sc"]["drums"] >= .55:
                                break
                            if not rv["keep"]:
                                song = rv["song"]                    # a kept plan that is still short on drums simply gets another go: a new take of the same plan
                    except Exception as ex:
                        fails += 1
                        shutil.rmtree(where, ignore_errors=True)
                        print("[night] a try failed: " + str(ex).strip()[-500:], flush=True)
                        if fails >= 4:                               # four in a row: something is really wrong, do not hammer on all night
                            _state["error"] = str(ex).strip().splitlines()[0][:300]
                            break
                        time.sleep(20)
                if best:                                           # this is the song: into the library, and its other tries are gone
                    label = f"{tag} · {n:02d} · {best['song']['title']}"
                    run = library.new_run_dir("ace_step", label)
                    src = Path(best["path"])
                    dst = run / f"{n:02d} {re.sub(r'[^A-Za-z0-9 _-]+', '', best['song']['title']).strip() or 'song'}{src.suffix}"
                    shutil.move(str(src), str(dst))
                    shutil.rmtree(src.parent, ignore_errors=True)
                    library.write_meta(run, {"engine": "ace_step", "engine_name": "night shift", "created": time.strftime("%Y-%m-%d %H:%M:%S"), "label": label,
                                             "params": best["params"], "outputs": [{"path": str(dst), "kind": "audio", "label": best["song"]["title"]}],
                                             "info": {"idea": best["song"]["idea"], "score": best["sc"]}, "seconds": 0})
                    done.append({"title": best["song"]["title"], "m": best["m"]})
                    entry.update(path=str(dst), score=best["sc"])
                    _state["made"] = len(done)
                    _state["songs"].append({"n": n, "name": best["song"]["title"], "path": str(dst), "creature": best["song"]["creature"], "idea": best["song"]["idea"]})
                    _state["per"] = round((time.time() - _state["started"]) / len(done), 1)
                sheet["songs"].append(entry)
                save()
            _state["msg"] = (f"stopped: {_state['made']} songs are in the library" if _state["stop"] else "stopped: " + _state["error"] if _state["error"]
                             else f"done: {_state['made']} songs are in the library as “{tag}”")
        except Exception as ex:
            _state["error"] = str(ex).strip().splitlines()[0][:300] if str(ex).strip() else "it failed"
            _state["msg"] = "stopped: " + _state["error"]
            print("[night] stopped: " + str(ex).strip()[-800:], flush=True)
        finally:
            for t_ in d.glob("s*_t*"):
                shutil.rmtree(t_, ignore_errors=True)                # no leftovers: only the finished songs and the sheet remain
            _state.update(running=False, finished=time.time())
            job.update(state="cancelled" if _state.get("stop") else "error" if _state.get("error") else "done", msg=_state["msg"], frac=1)
            if awake:
                awake.terminate()

    threading.Thread(target=work, daemon=True).start()
    return status()
