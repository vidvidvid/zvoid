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
What makes a result fail here: no rhythm at all, one unbroken texture, plain noise. Every song needs a pulse somewhere and a shape with contrast.
Three things the artist heard go wrong, and how to avoid them:
- A constant hum under the whole song. A tag is applied to the WHOLE song, not to one section, so any tag that names something sustained lays a bed under everything: never write drone, hum, pad, sustained, swell, wash, ambience, room, echo, reverb, wide, hollow pipe, held note. The low end must be struck, not held: "sub hits that stop dead", "short sub thuds". Always include tags for dryness and edges: "dry", "close", "tight", "gated", "hard cuts", "dead silence between hits".
- Smooth, soulful singing appearing from nowhere. The model sings anything voice-like in its default pop style unless told otherwise. Describe every voice as shouted, barked, chanted in unison, whispered, growled, rasped or throat-sung, and add "no melody in the voices, spoken rhythm". Never write wailing, singing, sung, humming, choir, soulful, high voice, female voice, crooning.
- In the lyrics, the same: syllables must start with hard consonants and be short (ka, tu, gra, zok, thum, tek, bra). No long open vowels and no vowel runs (not ee-yah, ah-ee-yo, oh-oh, yeah), and no trailing dots that stretch a sound. They are shouted, not sung.
The goal is a song as clear and sharp as a knife: every sound has an edge, and between sounds there is nothing."""


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
    """What can be told about a result without hearing it. Besides the track-wide numbers: a timeline in 5-second steps
    (level and drum hits), and how DEFINED its structure is: whether it falls into distinct blocks of sound that hold
    together, follow one another, and come back (a verse, a chorus, the chorus again) or is one undivided wash."""
    import numpy as np
    import soundfile as sf
    f = gym.features(Path(path))
    x, sr = sf.read(path, always_2d=True, dtype="float32")
    m, h = x.mean(1), sr * 5
    e = np.sqrt((m[:len(m) // h * h].reshape(-1, h) ** 2).mean(1)) if len(m) > h * 3 else np.array([1.0])
    db = 20 * np.log10(e + 1e-6)
    out = dict({k: round(float(f.get(k, 0)), 3) for k in (*VEC, "bpm", "secs", "loud")}, contrast=round(float(db.max() - db.min()), 1), sections=[round(float(v), 1) for v in db - db.max()][:60])
    try:                                                               # is there a bed under everything? a tone that never goes away, and no moment of real quiet
        N = 16384
        S = np.abs(np.fft.rfft(np.stack([m[i:i + N] * np.hanning(N) for i in range(0, len(m) - N, N)]), axis=1))
        fq2 = np.fft.rfftfreq(N, 1 / sr)
        low10 = np.percentile(20 * np.log10(S + 1e-7), 10, axis=0)         # the level each pitch keeps even in the quietest tenth of the song
        around = np.median(np.lib.stride_tricks.sliding_window_view(np.pad(low10, 40, mode="edge"), 81), axis=1)
        keep = (fq2 > 30) & (fq2 < 3000)
        out["hum"] = round(float(np.max((low10 - around)[keep])), 1)      # dB a constant tone stands above its surroundings: under 8 is nothing, over 12 is a hum you hear
        out["hum_hz"] = round(float(fq2[keep][int(np.argmax((low10 - around)[keep]))]), 1)
        one = sr
        e1 = np.sqrt((m[:len(m) // one * one].reshape(-1, one) ** 2).mean(1))
        out["floor"] = round(float(20 * np.log10(np.percentile(e1[2:-2] if len(e1) > 8 else e1, 3) / (e1.max() + 1e-9) + 1e-6)), 1)   # its quietest second, in dB below its loudest: -12 means it never lets go, -35 means real silences
    except Exception:
        out.update(hum=0.0, hum_hz=0.0, floor=-30.0)
    try:
        win = 2048
        fr = m[:len(m) // win * win].reshape(-1, win) * np.hanning(win)
        mag = np.abs(np.fft.rfft(fr, axis=1))
        fq = np.fft.rfftfreq(win, 1 / sr)
        edges = [40, 90, 180, 350, 700, 1400, 2800, 5600, 12000]
        bands = np.stack([20 * np.log10(mag[:, (fq >= a) & (fq < b)].sum(1) + 1e-6) for a, b in zip(edges, edges[1:])], 1)
        flux = np.maximum(0, np.diff(mag, axis=0)).sum(1)
        per = max(1, int(round(2.5 * sr / win)))                       # frames in a 2.5-second block
        nb = len(bands) // per
        V = bands[:nb * per].reshape(nb, per, -1).mean(1)
        V = V - V.mean(0)
        spread = float(V.std())                                        # how much its sound changes at all over the song, in dB: hiss or a loop barely moves
        fl = flux[:(len(flux) // per) * per].reshape(-1, per)
        hits = np.percentile(fl, 96, axis=1) / (np.median(flux) + 1e-9)   # how far the sharpest moments of each block stand out
        k = int(min(4, max(2, nb // 6)))
        cent = [V[0]]
        while len(cent) < k:                                           # farthest-point start: the same answer every time
            dist = np.min([((V - c) ** 2).sum(1) for c in cent], axis=0)
            cent.append(V[int(np.argmax(dist))])
        cent = np.array(cent)
        for _ in range(20):
            D = ((V[:, None, :] - cent[None]) ** 2).sum(2)
            lab = D.argmin(1)
            cent = np.array([V[lab == c].mean(0) if (lab == c).any() else cent[c] for c in range(k)])
        D = np.sqrt(((V[:, None, :] - cent[None]) ** 2).sum(2))
        own = D[np.arange(nb), lab]
        oth = np.where(np.arange(k)[None] == lab[:, None], np.inf, D).min(1)
        sil = float(np.mean((oth - own) / (np.maximum(oth, own) + 1e-9)))    # blocks sit clearly in one kind of sound or another
        runs = [(lab[0], 1)]
        for v in lab[1:]:
            runs = runs[:-1] + [(v, runs[-1][1] + 1)] if v == runs[-1][0] else runs + [(v, 1)]
        held = float(np.mean([n >= 3 for _, n in runs]))                     # a kind of sound, once begun, lasts (7 seconds or more)
        back = len({c for c in set(lab) if sum(1 for r, n in runs if r == c and n >= 2) >= 2})   # kinds of sound that return later
        out["definition"] = round(float(np.clip(.5 * np.clip(sil / .55, 0, 1) + .3 * held + .2 * min(1, back / 2), 0, 1) * np.clip(spread / 3.5, 0, 1) ** .7), 3)
        out["kinds"] = "".join("ABCD"[int(v)] for v in lab)[:120]            # the song as letters, one per 2.5 seconds: AAAABBBBAAAACCCC…
        h5 = hits[:nb // 2 * 2].reshape(-1, 2).max(1)
        out["hits"] = [round(float(np.clip((v - 1.2) / 4.5, 0, 1)), 2) for v in h5][:60]   # drum hits per 5 seconds: 0 = none (hiss measures 0), about 0.15-0.3 in a song with drums, 1 = nothing but drums
    except Exception:
        out.update(definition=0.0, kinds="", hits=[])
    return out


def polish(path: str) -> list:
    """Take out the machine's own buzz. ACE-Step builds sound in frames, 25 a second, and leaves thin constant tones at
    multiples of 25 Hz that sit under the whole song. Where such a tone is really there (it stands out even in the song's
    quietest moments), a very narrow cut is made at exactly that pitch. Notes the music holds are not on that grid and are
    left alone. Returns the pitches that were cut."""
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(path, always_2d=True, dtype="float32")
    m, N = x.mean(1), 32768
    if len(m) < N * 6:
        return []
    S = np.abs(np.fft.rfft(np.stack([m[i:i + N] * np.hanning(N) for i in range(0, len(m) - N, N)]), axis=1))
    fq = np.fft.rfftfreq(N, 1 / sr)
    low = np.percentile(20 * np.log10(S + 1e-7), 10, axis=0)
    prom = low - np.median(np.lib.stride_tricks.sliding_window_view(np.pad(low, 60, mode="edge"), 121), axis=1)
    cuts = []
    for k in range(4, 161):                                            # 100 Hz .. 4 kHz on the 25 Hz grid
        f0 = k * 25.0
        near = np.abs(fq - f0) <= 1.6
        if near.any() and float(prom[near].max()) > 10:
            cuts.append((float(fq[near][int(np.argmax(prom[near]))]), float(prom[near].max())))
    cuts = sorted(cuts, key=lambda c: -c[1])[:16]
    if not cuts:
        return []
    n = len(x)
    F = np.fft.rfftfreq(n, 1 / sr)
    gain = np.ones(len(F), "float32")
    for f0, pr in cuts:
        depth = 1 - 10 ** (-min(30.0, pr + 6) / 20)                       # cut it down to the level of what surrounds it, a little more
        gain *= 1 - depth * np.exp(-.5 * ((F - f0) / .9) ** 2).astype("float32")
    y = np.stack([np.fft.irfft(np.fft.rfft(x[:, c]) * gain, n) for c in range(x.shape[1])], 1).astype("float32")
    sf.write(path, y, sr, subtype=sf.info(path).subtype)
    return [round(f0, 1) for f0, _ in cuts]


def score(m: dict, others: list[dict]) -> dict:
    """A stand-in for judgement, made of things that can be measured: does it have drums and a pulse, is its structure
    defined (distinct blocks that hold and return), does it have contrast, and is it unlike the songs already finished.
    It cannot tell a good song from a dull one."""
    drums = .5 * min(1, max(0, (m["attack"] - .06) / .22)) + .5 * min(1, m["steady"] / .6)
    shape = min(1, m["contrast"] / 9)
    far, near = 1.0, None
    for o in others:
        d = (sum((m[k] - o["m"][k]) ** 2 for k in VEC) / len(VEC) + ((m["bpm"] - o["m"]["bpm"]) / 200) ** 2) ** .5
        if d < far:
            far, near = d, o["title"]
    variety = min(1, far / .22) if others else 1.0
    defn = float(m.get("definition", 0))
    clear = .5 * min(1, max(0, (-float(m.get("floor", -30)) - 10) / 22)) + .5 * min(1, max(0, 1 - (float(m.get("hum", 0)) - 7) / 9))   # real quiet between sounds, and no tone that never stops
    return {"total": round(.25 * drums + .25 * defn + .2 * clear + .1 * shape + .2 * variety, 3), "drums": round(drums, 2), "definition": round(defn, 2), "clarity": round(clear, 2),
            "shape": round(shape, 2), "variety": round(variety, 2), "nearest": near}


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
                  + f'- a constant tone under everything: {m.get("hum")} dB at {m.get("hum_hz")} Hz (under 8 is clean, over 12 is a hum the artist hears and dislikes)\n'
                  f'- its quietest second: {m.get("floor")} dB below its loudest (-12 means the sound never lets go; -30 or lower means real silences)\n'
                  + (f'- the finished song it is most like: "{sc["nearest"]}" (variety {sc["variety"]}, 1 = very different)\n' if sc.get("nearest") else "")
                  + f"\nTries left for this song: {tries_left}. The artist heard a song that measured 0.12 for drum hits and said it needed more drums, so merely detectable is not enough: aim for drum hits of 0.2 or more in the parts where drums play. Answer keep=true only if drum hits are at least 0.2, contrast is at least 5 dB, the constant tone is under 10 dB, its quietest second is below -20 dB, and it is unlike the others (still return the caption, lyrics and bpm unchanged).\n"
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


CHISEL_SCHEMA = {"type": "object", "required": ["start", "end", "caption", "note"],
                 "properties": {"start": {"type": "number"}, "end": {"type": "number"}, "caption": {"type": "string"}, "note": {"type": "string"}}}


def chisel_plan(song: dict, m: dict, tried: list, rng) -> dict:
    """Which stretch of the song to carve next, and into what. Claude reads the song as a timeline; without it, the stretch
    with the fewest drum hits that has not been tried is given drums."""
    secs, hits, lev = float(m.get("secs") or song["duration"]), m.get("hits") or [], m.get("sections") or []
    words = song["caption"].split(",")[0].strip()
    try:
        line = lambda arr: " ".join(f"{int(i * 5)}s:{v}" for i, v in enumerate(arr))
        prompt = (f'Song: "{song["title"]}" ({secs:.0f} seconds) for the creature {song["creature"]}. Its idea: {song["idea"]}\n\nCAPTION\n{song["caption"]}\n\nLYRICS (the plan it was made from)\n{song["lyrics"]}\n\n'
                  "It exists as audio now. Nobody has heard it; this is what can be measured:\n"
                  f"- level in 5-second steps (dB below its loudest): {line(lev)}\n- drum hits in 5-second steps (0 none .. 1 hard): {line(hits)}\n"
                  f'- its kinds of sound, one letter per 2.5 seconds: {m.get("kinds", "")}\n  (a defined song reads like AAAABBBBAAAACCCCBBBB: clear blocks that hold and return. A wash reads like ABACBADC or AAAAAAAAAAAA.)\n'
                  f'- a constant tone under everything: {m.get("hum")} dB at {m.get("hum_hz")} Hz (over 12 is a hum the artist hears); its quietest second is {m.get("floor")} dB below its loudest (-12 means it never lets go)\n'
                  f'- how defined its structure measures: {m.get("definition")} of 1. Drums overall: {m["attack"]} (the artist wants 0.2 or more). In the 5-second timeline, a stretch with real drums reads about 0.2 to 0.4, and under 0.1 means none.\n'
                  + ("- stretches already reworked, do not pick these again: " + ", ".join(f"{a:.0f}-{b:.0f}s" for a, b in tried) + "\n" if tried else "")
                  + "\nPick ONE stretch of 12 to 30 seconds to make again, the one whose remaking would most sharpen the song into a defined structure: a chorus that does not stand out from the verse, "
                  "a stretch where the plan asks for drums and there are none, a blur between two sections, a return that does not sound like what it returns to, or a stretch where the plan asks for silence or a drop and the level in the timeline barely falls (there the caption should ask for almost nothing: one dry sound and dead silence around it). Leave silences that are already silent alone. "
                  f'Give start and end in seconds, and a caption for JUST that stretch: it must begin with "{words}", then say concretely what plays there (which drums and how, the low end, the voices, the noise). '
                  "No genre or artist names. In the note, one sentence: which section this is and what it should become.")
        r = chat.think(HOUSE, prompt, CHISEL_SCHEMA, 240)
        a, b = float(r["start"]), float(r["end"])
        a = max(0.0, min(secs - 12, a))
        b = max(a + 12, min(secs, min(a + 30, b)))
        cap = " ".join(str(r.get("caption") or "").split())
        if words not in cap:
            cap = words + ", " + cap
        return {"start": round(a, 1), "end": round(b, 1), "caption": cap[:700], "note": (r.get("note") or "")[:300]}
    except Exception as ex:
        n = len(hits)
        cands = [(sum(hits[i:i + 4]), i) for i in range(1, max(2, n - 5)) if not any(abs(i * 5 - a) < 15 for a, _ in tried)] or [(0, 1)]
        _, i = min(cands)
        return {"start": float(i * 5), "end": float(min(secs, i * 5 + 20)), "caption": words + ", " + ", ".join(rng.sample(DRUMS, 2)) + ", hard dry hits on every beat, " + rng.choice(VOICE),
                "note": "by rule: the stretch with the fewest drum hits gets drums (Claude did not answer: " + str(ex)[:60] + ")"}


def status() -> dict:
    s = {k: v for k, v in _state.items() if k not in ("job", "stop")}
    return s or {"running": False}


def stop():
    if _state.get("running"):
        _state["stop"] = True
        if _state.get("job"):
            _state["job"]["cancel"] = True


def start(engines: dict, jobs: dict, coerce, creatures, count: int = 10, direction: str = "", tries: int = 1, name: str = "", hours: float = 0) -> dict:
    """Make a collection. Every song starts as its own idea and gets up to `tries` goes: made, measured, revised, made again.
    The best go of each is the song; only those reach the library.
    With `hours`, it then keeps chiselling until that time is up: one stretch of one song is made again, and the change is
    kept only if the song measures as more defined than before. A song is left alone once three carvings in a row did not help."""
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
    hours = max(0.0, min(16.0, float(hours or 0)))
    _state.update(running=True, id=sid, creatures=creatures, creature=creatures[0], count=count, tries=tries, made=0, thrown=0, msg="starting…", started=time.time(), songs=[], tag=tag,
                  job=job, stop=False, error=None, per=None, hours=hours, until=time.time() + hours * 3600 if hours else None, phase="making", carved=0, carves=0)
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
                    done.append({"title": best["song"]["title"], "m": best["m"], "n": n, "path": str(dst), "song": best["song"], "sc": best["sc"], "strength": strength, "entry": entry,
                                 "tried": [], "misses": 0, "carved": 0})
                    first = d / "first takes"                       # the song before any carving, kept so it can always be gone back to
                    first.mkdir(exist_ok=True)
                    shutil.copy(dst, first / dst.name)
                    try:
                        entry["buzz_cut_hz"] = polish(str(dst))        # the model's own fixed-pitch buzz comes out of the song in the library; the first take keeps it, untouched
                    except Exception as ex:
                        print("[night] could not filter the buzz: " + str(ex)[:200], flush=True)
                    entry.update(path=str(dst), score=best["sc"], carving=[])
                    _state["made"] = len(done)
                    _state["songs"].append({"n": n, "name": best["song"]["title"], "path": str(dst), "creature": best["song"]["creature"], "idea": best["song"]["idea"]})
                    _state["per"] = round((time.time() - _state["started"]) / len(done), 1)
                sheet["songs"].append(entry)
                save()
            # ---- the rest of the night: chisel. One stretch of one song is made again; it is kept only if the song measures as more defined
            rnd = 0
            while hours and not _state["stop"] and not _state["error"] and time.time() < _state["until"]:
                live = [s_ for s_ in done if s_["misses"] < 3 and s_["carved"] < 12]
                if not live:
                    break
                rnd += 1
                _state["phase"] = "chiselling"
                for s_ in sorted(live, key=lambda q: q["sc"]["total"]):             # the least defined first
                    if _state["stop"] or time.time() >= _state["until"]:
                        break
                    base = f"chiselling, round {rnd} · “{s_['title']}”"
                    _state["msg"] = base + " · choosing where to carve"
                    job.update(msg=base, frac=min(.99, (time.time() - _state["started"]) / max(1, _state["until"] - _state["started"])))
                    where = d / f"s{s_['n']:02d}_t{uuid.uuid4().hex[:6]}"
                    try:
                        cp = chisel_plan(s_["song"], s_["m"], s_["tried"], rng)
                        s_["tried"].append((cp["start"], cp["end"]))
                        _state["msg"] = base + f" · remaking {cp['start']:.0f}–{cp['end']:.0f}s"
                        where.mkdir()
                        params = gym.bred_boost(coerce(e.spec, {"task": "repaint", "src_audio": s_["path"], "repaint_start": cp["start"], "repaint_end": cp["end"], "caption": cp["caption"],
                                                                "lyrics": s_["song"]["lyrics"], "duration": round(float(s_["m"].get("secs") or s_["song"]["duration"]), 1), "thinking": False, "batch": 1,
                                                                "seed": rng.randint(1, 2 ** 31 - 1), "creature": s_["song"]["creature"], "creature_strength": s_["strength"]}))
                        outs = []
                        for ev in e.run(params, where):
                            if ev[0] != "progress":
                                outs = ev[1]
                        if not outs:
                            raise RuntimeError("nothing came back")
                        _state["carves"] += 1
                        why = broken(outs[0]["path"], float(s_["song"]["duration"]))
                        m2 = None if why else measure(outs[0]["path"])
                        sc2 = None if why else score(m2, [o for o in done if o is not s_])
                        better = bool(sc2) and sc2["total"] > s_["sc"]["total"] + .002
                        s_["entry"]["carving"].append({"round": rnd, "from": cp["start"], "to": cp["end"], "why": cp["note"], "kept": better, "broken": why or None,
                                                       "before": s_["sc"]["total"], "after": sc2["total"] if sc2 else None, "definition": [s_["sc"]["definition"], sc2["definition"] if sc2 else None]})
                        if better:
                            shutil.copy(outs[0]["path"], s_["path"])            # the song in the library is now the carved one
                            try:
                                polish(s_["path"])
                            except Exception:
                                pass
                            s_.update(m=m2, sc=sc2, misses=0, carved=s_["carved"] + 1)
                            s_["entry"]["score"] = sc2
                            _state["carved"] += 1
                        else:
                            s_["misses"] += 1
                        fails = 0
                    except Exception as ex:
                        fails += 1
                        s_["misses"] += 1
                        print("[night] a carving failed: " + str(ex).strip()[-400:], flush=True)
                        if fails >= 4:
                            _state["error"] = str(ex).strip().splitlines()[0][:300]
                            break
                        time.sleep(15)
                    finally:
                        shutil.rmtree(where, ignore_errors=True)
                    save()
            _state["msg"] = (f"stopped: {_state['made']} songs are in the library" if _state["stop"] else "stopped: " + _state["error"] if _state["error"]
                             else f"done: {_state['made']} songs are in the library as “{tag}”" + (f", {_state['carved']} carvings kept of {_state['carves']} tried" if _state.get("carves") else ""))
        except Exception as ex:
            _state["error"] = str(ex).strip().splitlines()[0][:300] if str(ex).strip() else "it failed"
            _state["msg"] = "stopped: " + _state["error"]
            print("[night] stopped: " + str(ex).strip()[-800:], flush=True)
        finally:
            for o in sheet["songs"]:
                o.pop("entry", None)
            for t_ in d.glob("s*_t*"):
                shutil.rmtree(t_, ignore_errors=True)                # no leftovers: only the finished songs and the sheet remain
            _state.update(running=False, finished=time.time())
            job.update(state="cancelled" if _state.get("stop") else "error" if _state.get("error") else "done", msg=_state["msg"], frac=1)
            if awake:
                awake.terminate()

    threading.Thread(target=work, daemon=True).start()
    return status()
