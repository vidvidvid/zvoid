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
import os
import random
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

from . import chat, gym, library
from .paths import ENGINES_DIR, ENVS_DIR, OUTPUTS_DIR

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
    "required": ["title", "creature", "creature2", "creature3", "creature4", "idea", "caption", "lyrics", "bpm", "duration", "starts", "ends"],
    "properties": {"title": {"type": "string"}, "creature": {"type": "string"}, "creature2": {"type": "string"}, "creature3": {"type": "string"}, "creature4": {"type": "string"}, "idea": {"type": "string"}, "caption": {"type": "string"},
                   "starts": {"type": "string", "enum": ["peak", "depth", "void"]}, "ends": {"type": "string", "enum": ["peak", "depth", "void"]},
                   "lyrics": {"type": "string"}, "bpm": {"type": "integer"}, "duration": {"type": "integer"}}}}}}
REVISE_SCHEMA = {"type": "object", "required": ["keep", "caption", "lyrics", "bpm", "note"],
                 "properties": {"keep": {"type": "boolean"}, "caption": {"type": "string"}, "lyrics": {"type": "string"}, "bpm": {"type": "integer"}, "note": {"type": "string"}}}
HOUSE = """You write plans for ACE-Step, a text-to-music model, played through "creatures" (adapters trained on one artist's sound).

WHAT THESE PIECES ARE (the artist's own words, follow them over any habit of songwriting):
"The songs should mimic emotions. They are raw and real, but it is really difficult to understand and comprehend their structure and source. They are infinite, never ending, morphing into one another. The only constant emotions are peaks and the bottomless depths, where everything is the same for an infinitely short or long period of time. It is bouncing us between these extremes. And there is also emptiness, the void, which we sometimes can notice and sometimes it just absorbs us."
And: "I want something that is danceable, where people can lose themselves to it. Basically various types of rave, punk, electro."
And, to be clear about that: "It should not limit itself to matching these genres too much. It should take the danceability and other essences from them. We don't want to make drum and bass. We want to understand what makes that music invoke the specific mood in a person that makes them want to dance."
And, after hearing the first pieces: "There is a recurring feeling of the sound choking. We should go the opposite way: the sound should in general feel released. Chiselling should mean the same: making the sound more clear, releasing it, the way a statue is released from the block of stone."
And on what is familiar and what is foreign: "There has to be familiarity, still. That is what I wanted to capture in the list of genres that make people dance. That is the primal ape. The sounds and textures, the approaches to the structure of the song, all that can be foreign."
So the split is exact: the PULSE is familiar (a body recognises it at once and moves, as it always has), and EVERYTHING ELSE is foreign: what the sounds are made of, their textures, the voices, and the form the piece takes, fluid and always morphing. Never make the beat strange in order to be new, and never make the sounds or the form ordinary in order to be danceable.
And: "The percussion is barely audible in most songs." So the DRUMS ARE THE FRONT of every piece: the loudest thing in it, ahead of the voices, the noises and the low end. Everything else is placed behind them.
So the sound itself is OPEN: a clear bright top end, space around every hit, each sound allowed to ring out and be let go. Never squeezed, muffled, boxed in or pressed flat. Even the heaviest depth breathes.
So every piece must make a body move, but it must NOT be an example of any existing genre. Do not imitate rave, punk, electro or drum and bass. Take what works in them and build something that has no name:
- from rave: a pulse that never lets go; long stretches where nothing changes and that is the point; tension wound up and then let off all at once.
- from drum and bass and jungle: speed on top and weight underneath at the same time (fast broken drums over a low end moving at half their pace); a beat that rolls forward and keeps tripping without ever falling.
- from punk: rawness, speed, everything played as hard as it goes, a crowd shouting as one, no decoration.
- from electro and body music: machine precision, stiff syncopation that makes joints move, short stabbing notes, repetition like a piston.
- from footwork, gabber and hard dance: pushing one thing past the point of comfort (too fast, too hard, too repeated) until it turns into something else.
- from all of them: the moment the beat is taken away so that its return hits the whole body.
Combine these freely and invent others. What matters is the effect in a body: it wants to move, and then it stops thinking. The emotional states below happen ON TOP OF that movement, not instead of it. A piece nobody could dance to has failed, however interesting it is.
A piece is not a song with verses and choruses. It is a passage through three states, in any order and for any length:
- PEAK: everything at once, overwhelming, relentless, and for as long as it lasts it does not change.
- DEPTH: the bottom. Heavy and sunk, and for as long as it lasts it does not change. The beat does not stop here: it strips down (the kick alone, or half-time, or kick and one low thud) and keeps the floor moving.
- VOID: emptiness. Nothing, or one small dry sound alone in nothing. Sometimes it is noticed: everything is cut dead and the silence is a shock. Sometimes it absorbs: the sounds thin out one by one until, without a moment you could point to, there is nothing left.
  The artist on silence: "We don't have to force the silences. They need to be tasteful and make sense, if they appear." So the void is rare and earned. MOST PIECES HAVE NO VOID SECTION AT ALL. In a set of ten, at most three contain one, and then usually a single brief one; only a piece that is ABOUT emptiness dwells in it. Never put a silence in because a plan "should" have one, and never chop a piece up with stops. The bounce between PEAK and DEPTH is the main thing.
Between states it MORPHS: one thing turns into another so that you cannot say where it changed, or it is thrown from one extreme to the other with no warning. Durations must be uneven and unpredictable: a state may last four seconds or seventy. Never a regular plan, never a repeated chorus, never an intro that sets up or an outro that resolves: a piece begins already inside a state and ends inside one, unfinished, so the next can continue from it.

HOW A PLAN IS WRITTEN:
- caption: comma-separated tags. It MUST begin with one or two of the chosen creature's own words, exactly as given (they wake the adapter up). Then the tempo ("148 bpm"), then 10-15 concrete sound tags: the kick and how it drives (on every beat, broken and rolling, galloping, stomping, stiff and syncopated), what the other drums do against it, the low end and how fast it moves compared with the drums, the noises, the voices, how it moves between extremes, the feeling. Always say "danceable" and describe the kick.
  NEVER write a genre name (not rave, techno, punk, electro, drum and bass, jungle, acid, house, gabber or any other) and never an artist or band name: a genre word makes the model produce that genre, which is exactly what the artist does not want. Describe the MECHANISM that moves a body, in plain sound words. And vary the mechanism across the collection, so no two neighbours move people the same way.
- lyrics: the passage, as section tags in square brackets naming the state and what happens, e.g. "[peak - everything, full stomp, no change]", "[depth - sunk, slow sub hits, growled breath]", "[morph - the drums melt into the voices]", "[thrown - from the bottom straight to the top]", and only where it is earned "[void - nothing, one dry click]". Under each tag, 0-4 lines of chant syllables or invented words. No real words in any language. 5-9 sections of very uneven length.
- duration: 120 to 190 seconds. bpm: 118 to 190 (dance tempos; a heavy half-time piece may be written at 85-100 only if its kick still makes people move).

FOUR THINGS THE ARTIST HEARD GO WRONG, AND HOW TO AVOID THEM:
- A constant hum under the whole piece. A tag is applied to the WHOLE piece, not to one section, so any tag that names something sustained lays a bed under everything, and then there is no void and no depth, only a wash: never write drone, hum, pad, sustained, swell, wash, ambience, echo, reverb, hollow pipe, held note. The low end must be struck, not held: "sub hits that stop dead", "short sub thuds". Always include tags for edges AND for openness: "punchy", "clear", "open", "bright crisp top end", "wide", "every hit rings out". The depth is heaviness, not a hum.
- The sound choking. Tags that close a sound in are applied to the whole piece too: never write dry, close, tight, muffled, dark, dull, compressed, crushed, squashed, buried, claustrophobic, boxed, lo-fi, underwater, distant. Weight comes from what is struck, not from pressing everything together.
- Smooth, soulful singing appearing from nowhere. The model sings anything voice-like in its default pop style unless told otherwise. Describe every voice as shouted, barked, chanted in unison, whispered, growled, rasped or throat-sung, and add "no melody in the voices, spoken rhythm". Never write wailing, singing, sung, humming, choir, soulful, high voice, female voice, crooning.
- In the lyrics, the same: syllables start with hard consonants and are short (ka, tu, gra, zok, thum, tek, bra). No long open vowels and no vowel runs (not ee-yah, ah-ee-yo, oh-oh, yeah), and no trailing dots that stretch a sound.
Drums come and go: present and hard at the peaks, a few heavy ones in the depths.
WHAT THE ARTIST HAS SAID ABOUT PIECES ALREADY MADE (steer by this):
- Liked most: a frantic, drum-led chase in stop-start bursts; and "panic as a chase: drums sprint in stop-start bursts and are thrown to the bottom without warning" ("a great direction"). Drums carrying a piece is good.
- "A great direction, but maybe faster": a piece about numbness and emptiness at 58 bpm. Emptiness is welcome; slowness is not. Keep things moving.
- "Too undefined, a moving mass of sound": a slow piece carried by a long low note. Nice sounds, but nothing in it had edges. Avoid anything that is one continuous mass: every piece needs separate, countable events (hits, stabs, shouts) that you could clap along to.
- "Interesting": bright metal snaps and rubbery noise at a relentless peak.
Every sound has an edge, as clear and sharp as a knife, and it is let go: released, never choked."""


MARKS = DIR / "marks.json"     # what the artist marked after listening: "<collection>:<number>" -> the piece and +1 (more like this) or -1 (not this)


def marks() -> dict:
    try:
        return dict(json.loads(MARKS.read_text()))
    except Exception:
        return {}


def marks_of(sid: str) -> dict:
    return {k.split(":")[1]: v.get("mark", 0) for k, v in marks().items() if k.startswith(sid + ":")}


def mark(sid: str, n: int, v: int) -> dict:
    """The artist's verdict on a finished piece: more like this (1), not this (-1), or no verdict (0). It is kept with
    enough of the piece (who played it, its idea, what it was made from) for a later night to steer by."""
    if not re.fullmatch(r"[a-z0-9]{6,16}", sid) or not (DIR / sid / "collection.json").exists():
        raise FileNotFoundError("no such collection")
    sheet, every, key = json.loads((DIR / sid / "collection.json").read_text()), marks(), f"{sid}:{int(n)}"
    if not v:
        every.pop(key, None)
    else:
        e = next((x for x in sheet.get("songs", []) if x.get("n") == int(n)), None)
        if not e:
            raise FileNotFoundError("that piece is not finished")
        plan = (sheet.get("ideas") or [])[int(n) - 1] if len(sheet.get("ideas") or []) >= int(n) else {}
        cap, names = "", {}
        try:
            cap = str((json.loads((Path(e["path"]).parent / "meta.json").read_text()).get("params") or {}).get("caption") or "")
        except Exception:
            pass
        try:
            names = json.loads((DIR / sid / "names.json").read_text())
        except Exception:
            pass
        every[key] = {"mark": 1 if v > 0 else -1, "title": names.get(str(n)) or e.get("title", ""), "creatures": [c for c in [e.get("creature"), *(e.get("mix") or [])] if c], "idea": e.get("idea", ""),
                      "bpm": plan.get("bpm"), "caption": cap[:400], "path": e.get("path"), "when": time.strftime("%Y-%m-%d %H:%M")}
    MARKS.parent.mkdir(parents=True, exist_ok=True)
    MARKS.write_text(json.dumps(every, indent=1, ensure_ascii=False))
    return marks_of(sid)


TASTE = DIR / "taste.json"     # the conversation about taste: what was asked and answered, and what has been understood from it
QUESTION_SCHEMA = {"type": "object", "required": ["text", "pieces", "options"],
                   "properties": {"text": {"type": "string"}, "pieces": {"type": "array", "items": {"type": "integer"}}, "options": {"type": "array", "items": {"type": "string"}}}}
UNDERSTAND_SCHEMA = {"type": "object", "required": ["understanding", "open"],
                     "properties": {"understanding": {"type": "array", "items": {"type": "string"}}, "open": {"type": "array", "items": {"type": "string"}}}}
LISTENER = """You are learning one artist's taste by asking them. A program makes pieces of music for them overnight, played by "creatures" (adapters trained on one artist's sound each, sometimes merged). You cannot hear anything; the artist can. Only their ears can say what is good, so your job is to find out what they hear and want, precisely enough that the next night's pieces can be planned from it.
What the artist has said they are after: danceable pieces people lose themselves in; the pulse is the familiar part ("the primal ape"), while the sounds, textures and the form of a piece are foreign, fluid and always morphing; emotions as peaks and bottomless depths; the sound released, never choked; new forms, flow, groove, energy, otherworldliness.
HOW TO ASK: one short question at a time, in plain warm words, the way a friend in the studio would ask. No jargon and no numbers. Ask about what they HEARD, never about measurements.
The most useful question is one whose answer separates two explanations: if they liked a fast piece with shouting, was it the speed or the shouting? Compare two pieces when that separates things best.
"pieces": the numbers of the pieces they should listen to for this question (none, one, or two for a comparison).
"options": three to five short things they can tap as an answer, each one a concrete property that really is in the plans of the pieces named (the stop-start drums, the crowd shouting, how fast it is, the merge of two creatures, the bright metal noises), or for a comparison the two titles plus "neither" and "both". Never vague ones like "the vibe" or "the energy". They can also answer in their own words.
Never ask again what the conversation has already settled, and do not flatter. Whenever you mention a piece, to them or in your summary, call it by its title, never by its number alone.
WHEN SUMMARISING: "understanding" is five to eight short plain statements of what you now believe about their taste, each one specific enough to plan a piece from and each one supported by something they actually said or marked; put the most certain first, and say "probably" where you are guessing. Drop a statement the moment they contradict it. "open" is up to four things you still do not know and would ask next."""


def _talk() -> dict:
    try:
        return {"understanding": [], "open": [], "talk": [], **dict(json.loads(TASTE.read_text()))}
    except Exception:
        return {"understanding": [], "open": [], "talk": []}


def _talk_save(t: dict):
    TASTE.parent.mkdir(parents=True, exist_ok=True)
    TASTE.write_text(json.dumps(t, indent=1, ensure_ascii=False))


def _pieces(sid: str) -> list:
    """The finished pieces of a collection as the listener needs them: name, who plays, tempo, the idea, what it was made from, the artist's mark."""
    if not re.fullmatch(r"[a-z0-9]{6,16}", sid) or not (DIR / sid / "collection.json").exists():
        raise FileNotFoundError("no such collection")
    sheet, mk, names = json.loads((DIR / sid / "collection.json").read_text()), marks_of(sid), {}
    try:
        names = json.loads((DIR / sid / "names.json").read_text())
    except Exception:
        pass
    out = []
    for e in sheet.get("songs", []):
        n = int(e.get("n") or 0)
        plan = (sheet.get("ideas") or [])[n - 1] if 0 < n <= len(sheet.get("ideas") or []) else {}
        cap = ""
        try:
            cap = str((json.loads((Path(e["path"]).parent / "meta.json").read_text()).get("params") or {}).get("caption") or "")
        except Exception:
            pass
        out.append({"n": n, "title": names.get(str(n)) or e.get("title", ""), "creatures": [c for c in [e.get("creature"), *(e.get("mix") or [])] if c], "bpm": plan.get("bpm"), "idea": e.get("idea", ""),
                    "caption": cap[:260], "mark": int(mk.get(str(n), 0)), "path": e.get("path")})
    return out


def _told(t: dict, sid: str, ps: list) -> str:
    """Everything the listener knows, as text: the pieces, the marks, the conversation so far, and what it believed last time."""
    word = {1: "MORE like this", -1: "NOT this", 0: "no mark yet"}
    return ("THE PIECES OF THIS COLLECTION\n" + "\n".join(f'{p["n"]}. "{p["title"]}" ({" × ".join(p["creatures"])}, {p["bpm"]} bpm) [{word[p["mark"]]}]: {p["idea"]} Made from: {p["caption"]}' for p in ps)
            + "\n\nTHE CONVERSATION SO FAR (oldest first)\n" + ("\n".join(f'- You asked: {x.get("q", "")}' + (f' (about: {", ".join(x.get("titles") or [])})' if x.get("titles") else "")
                                                                    + f'\n  They answered: {"; ".join(x.get("picks") or []) or "(tapped nothing)"}' + (f' and said: "{x["text"]}"' if x.get("text") else "") for x in t["talk"][-24:]) or "(nothing yet)")
            + "\n\nWHAT YOU BELIEVED AFTER THE LAST ANSWER\n" + ("\n".join("- " + u for u in t["understanding"]) or "(nothing yet)")
            + ("\nStill open: " + "; ".join(t["open"]) if t["open"] else "") + "\n\n")


def taste_view(sid: str = "") -> dict:
    t = _talk()
    return {"understanding": t["understanding"], "open": t["open"], "asked": t.get("asked"), "answers": len(t["talk"])}


def question(sid: str, n: int = 0) -> dict:
    """The program asks the artist one thing. Right after a mark it asks what it is about that piece; otherwise it picks
    whatever would teach it most: an unmarked piece to listen to, two pieces to compare, or something it is unsure of."""
    t, ps = _talk(), _pieces(sid)
    if not ps:
        raise RuntimeError("there are no finished pieces to ask about yet")
    p = next((x for x in ps if x["n"] == int(n)), None) if n else None
    prompt = _told(t, sid, ps) + (
        (f'They have just marked piece {p["n"]}, "{p["title"]}", as {"MORE like this" if p["mark"] >= 0 else "NOT this"}. Ask what it is about this piece that makes them say so, with options taken from what is really in its plan. Set pieces to [{p["n"]}].'
         if p else "Ask the next most useful question. Prefer, in this order: a comparison of two pieces that would separate two explanations of their marks; a piece with no mark yet that would test what you believe; one of your open questions put directly."))
    q = chat.think(LISTENER, prompt, QUESTION_SCHEMA, 180)
    have = {x["n"] for x in ps}
    q = {"id": uuid.uuid4().hex[:8], "sid": sid, "text": " ".join(str(q.get("text") or "").split())[:400], "pieces": [int(x) for x in (q.get("pieces") or []) if int(x) in have][:2],
         "options": [" ".join(str(o).split())[:80] for o in (q.get("options") or []) if str(o).strip()][:5]}
    if not q["text"]:
        raise RuntimeError("no question came back")
    t["asked"] = q
    _talk_save(t)
    return taste_view(sid)


def answer(sid: str, picks: list, text: str = "", correction: bool = False) -> dict:
    """The artist answers (taps, their own words, or both), or corrects what the program said it understood. The program
    then writes down again, from everything said so far, what it now believes."""
    t = _talk()
    q = None if correction else t.pop("asked", None)
    text = " ".join(str(text or "").split())[:1200]
    picks = [" ".join(str(x).split())[:80] for x in (picks or [])][:6]
    if not correction and not q:
        raise RuntimeError("there is no question waiting")
    if not picks and not text:
        raise RuntimeError("tap an answer or write one")
    ps = _pieces(sid or (q or {}).get("sid") or "") if (sid or (q or {}).get("sid")) else []
    title = {p["n"]: p["title"] for p in ps}
    t["talk"].append({"when": time.strftime("%Y-%m-%d %H:%M"), "sid": sid, "q": "You told them what you understood, and they corrected it." if correction else q["text"],
                      "pieces": [] if correction else q["pieces"], "titles": [] if correction else [title.get(n, str(n)) for n in q["pieces"]], "picks": picks, "text": text})
    _talk_save(t)                                            # the answer is safe even if the summary below fails
    try:
        u = chat.think(LISTENER, _told(t, sid, ps) + "Write down again what you now believe about their taste, from everything above. The newest answer counts most, and a correction overrides what you believed.", UNDERSTAND_SCHEMA, 240)
        t["understanding"] = [" ".join(str(x).split())[:300] for x in (u.get("understanding") or []) if str(x).strip()][:8]
        t["open"] = [" ".join(str(x).split())[:200] for x in (u.get("open") or []) if str(x).strip()][:4]
        _talk_save(t)
    except Exception as ex:
        print("[night] could not rewrite what is understood: " + str(ex)[:200], flush=True)
    return taste_view(sid)


def understood() -> str:
    """What asking the artist has taught the program, for the briefs of new plans and of carvings."""
    t = _talk()
    if not t["understanding"]:
        return ""
    said = [f'"{x["text"]}"' for x in t["talk"][-12:] if x.get("text")]
    return ("WHAT THE ARTIST HAS TOLD THE PROGRAM ABOUT THEIR TASTE, WHEN IT ASKED THEM (follow this over your own preferences):\n" + "\n".join("- " + u for u in t["understanding"])
            + ("\nIn their own words: " + " / ".join(said[-6:]) if said else "") + "\n\n")


def taste() -> str:
    """What the artist's ears have said so far, as a part of the brief for new plans: the pieces marked "more like this"
    (a star in the library on a night's piece counts too) and the ones marked "not this"."""
    every = marks()
    try:
        starred = library._stars()
        for f in DIR.glob("*/collection.json"):
            sh = json.loads(f.read_text())
            for e in sh.get("songs", []):
                key = f"{sh.get('id') or f.parent.name}:{e.get('n')}"
                if e.get("path") in starred and key not in every:
                    every[key] = {"mark": 1, "title": e.get("title", ""), "creatures": [c for c in [e.get("creature"), *(e.get("mix") or [])] if c], "idea": e.get("idea", ""), "bpm": None, "caption": ""}
    except Exception:
        pass
    liked, away = [v for v in every.values() if v.get("mark", 0) > 0], [v for v in every.values() if v.get("mark", 0) < 0]
    if not liked and not away:
        return understood()
    line = lambda v: (f'- "{v.get("title", "")}" ({" × ".join(v.get("creatures") or [])}' + (f', {v["bpm"]} bpm' if v.get("bpm") else "") + f'): {v.get("idea", "")}'
                      + (f' [made from: {v["caption"][:220]}]' if v.get("caption") else ""))
    return (understood() + "WHAT THE ARTIST MARKED AFTER LISTENING (their ears are the only judge of taste; this outweighs anything that can be measured):\n"
            + ("More like these. Work out what they have in common (which creatures and merges, what carries them, how they move, what their sounds are made of) and go further in that direction, without repeating any of them:\n"
               + "\n".join(line(v) for v in liked[-12:]) + "\n" if liked else "")
            + ("Not these. Work out what they share and stay away from it:\n" + "\n".join(line(v) for v in away[-12:]) + "\n" if away else "") + "\n")


def _sides(slug: str) -> str:
    c = gym._load(slug)
    return f'{slug} — its words: ' + "; ".join(f'"{l["trigger"]}" ({", ".join(l["tags"])}, about {round(l["mean"]["bpm"])} bpm, {l["count"]} tracks)' for l in c.get("limbs", []))


def ideas(creatures: list[str], count: int, direction: str, rng, merges_only=()) -> list[dict]:
    """The collection's songs, as different from one another as they can be. Claude writes them; if it is not there, they are drawn from the built-in palettes."""
    out = []
    try:
        while len(out) < count:
            n = min(10, count - len(out))
            prompt = (f"Plan {n} songs for one collection of {count}. Direction from the artist: {direction or 'music nobody has heard before'}\n\n"
                      "Creatures to use, spread evenly over the songs:\n" + "\n".join(_sides(c) for c in creatures) + "\n\n"
                      + ("The creatures are meant to MIX. More than half of the pieces are HYBRIDS, played through several creatures merged into one. Most hybrids are pairs (set creature2). "
                         + ("In every ten pieces, two are merges of THREE creatures (set creature2 and creature3)" + (" and one is a merge of FOUR (creature2, creature3 and creature4)" if len(creatures) > 3 else "") + ". " if len(creatures) > 2 else "")
                         + (f"These creatures never play alone, they only appear inside merges, as a seasoning: {', '.join(merges_only)}. " if merges_only else "")
                         + "Begin a hybrid's caption with one word of EACH creature in it, in order. Choose combinations whose sounds would do something to each other, use every creature in at least one hybrid, and do not repeat a combination. "
                         'Leave the unused creature fields as "" (all three of them for a piece with a single creature).\n\n' if len(creatures) > 1 else 'Set creature2, creature3 and creature4 to "" for every piece.\n\n') +
                      "They are " + str(n) + " different FEELINGS and " + str(n) + " different ways of making a body move, not variations of one: vary the mechanism (see the list of essences), the tempo across the whole dance range, what rides on the beat (a voice, the low end, a noise, more drums), "
                      "how long it stays at the peak, in the depth and in the void, and how it gets from one to another (melting, or thrown). No two may share a tempo band, a carrier and a path.\n"
                      "The whole collection is ONE passage that never ends: each piece begins in the state the one before it ended in. "
                      + (f'The first of these must start in "{out[-1].get("ends", "depth")}", where the last one stopped.\n' if out else "The first may start anywhere.\n")
                      + ("Already planned, so do not repeat their feelings:\n" + "\n".join(f'- {x["title"]}: {x["idea"]} ({x["bpm"]} bpm, {x["creature"]}, {x.get("starts")} → {x.get("ends")})' for x in out) + "\n" if out else "")
                      + taste()
                      + 'For each: a short title (titles of the rave music of the future: invented words at the core, and around them, freely, numbers, symbols, a kanji or a few Arabic letters whose meaning fits, a file name, a time of day, a rare English or Slovenian word; give every title a different shape and sound, never twenty two-word names with the same hard consonants), creature, creature2, creature3, creature4, "idea" (one plain sentence: the feeling, and what makes this one different), "starts" and "ends" (peak, depth or void), caption, lyrics, bpm, duration.')
            got = chat.think(HOUSE, prompt, IDEAS_SCHEMA, 420).get("songs") or []
            if not got:
                break
            out += got[:n]
    except Exception as ex:
        print("[night] Claude could not write the ideas, using the built-in ones: " + str(ex)[:200], flush=True)
    songs = []
    for k in range(count):
        solo = [c for c in creatures if c not in merges_only] or creatures
        who = solo[k % len(solo)]
        if k < len(out):
            x = dict(out[k])
            if x.get("creature") not in creatures:
                x["creature"] = who
            mix = []
            for k in ("creature2", "creature3", "creature4"):
                if x.get(k) in creatures and x[k] != x["creature"] and x[k] not in mix:
                    mix.append(x[k])
            if not mix and x["creature"] in merges_only:      # this one only ever appears inside a merge: give it company
                mix = [rng.choice([c for c in creatures if c != x["creature"] and c not in merges_only] or [c for c in creatures if c != x["creature"]])]
            if mix and x["creature"] in merges_only and any(c not in merges_only for c in mix):   # and it does not lead: another creature goes first
                lead = next(c for c in mix if c not in merges_only)
                mix = [x["creature"]] + [c for c in mix if c != lead]
                x["creature"] = lead
            x["mix"] = mix
            x["creature2"] = mix[0] if mix else ""
            songs.append(_fit(x, rng))
        else:
            r = recipe(who, direction, rng)
            songs.append(_fit({"title": r["name"], "creature": who, "creature2": "", "mix": [], "idea": "drawn from the built-in palettes", "caption": r["params"]["caption"], "lyrics": r["params"]["lyrics"],
                               "bpm": r["params"]["bpm"], "duration": r["params"]["duration"]}, rng))
    return songs


def _fit(x: dict, rng) -> dict:
    """Keep a plan inside what works: the creature's word at the front, sane tempo and length."""
    c = gym._load(x["creature"])
    words = [l["trigger"] for l in c.get("limbs", [])] or [c.get("tag") or x["creature"]]
    cap = " ".join(str(x.get("caption") or "").split())
    for other in reversed(x.get("mix") or ([x["creature2"]] if x.get("creature2") else [])):   # a hybrid answers to a word of each creature in it
        c2 = gym._load(other)
        w2 = [l["trigger"] for l in c2.get("limbs", [])] or [c2.get("tag") or other]
        if not any(w in cap for w in w2):
            l2 = c2.get("limbs") or []
            cap = (rng.choices(l2, weights=[max(1, l.get("count", 1)) for l in l2])[0]["trigger"] if l2 else w2[0]) + ", " + cap
    if not any(w in cap for w in words):
        limbs = c.get("limbs") or []
        cap = (rng.choices(limbs, weights=[max(1, l.get("count", 1)) for l in limbs])[0]["trigger"] if limbs else words[0]) + ", " + cap
    if "danceable" not in cap:
        cap += ", danceable, driving kick"
    if "open" not in cap:
        cap += ", clear open sound, bright crisp top end, wide"
    if "drums in front" not in cap:
        cap += ", loud drums in front of everything"
    x.update(caption=cap[:900], bpm=int(max(84, min(190, int(x.get("bpm") or 140)))), duration=int(max(100, min(200, int(x.get("duration") or 150)))),
             title=" ".join(str(x.get("title") or "untitled").split())[:40], lyrics=str(x.get("lyrics") or "[Instrumental]")[:3000])
    return x


def _open(path: str) -> dict:
    """How released a sound is, in two numbers: "air", the share of its energy above 6 kHz in percent (the pieces the artist
    called choked have about 0.5, the open ones 2 or more, like the records the creatures were raised on), and "width",
    how much of it lives at the sides (0.25 is nearly mono, 0.4 to 0.5 is a record)."""
    import numpy as np
    import soundfile as sf
    try:
        x, sr = sf.read(path, always_2d=True, dtype="float32")
        m = x.mean(1)
        n = len(m) // 4096 * 4096
        S = (np.abs(np.fft.rfft(m[:n].reshape(-1, 4096) * np.hanning(4096), axis=1)) ** 2).mean(0)
        f = np.fft.rfftfreq(4096, 1 / sr)
        rms = float(np.sqrt((m ** 2).mean())) + 1e-9
        side = (x[:, 0] - x[:, 1]) / 2 if x.shape[1] > 1 else m * 0
        return {"air": round(float(S[f > 6000].sum() / (S.sum() + 1e-12) * 100), 2), "width": round(float(np.sqrt((side ** 2).mean())) / rms, 2)}
    except Exception:
        return {"air": 1.0, "width": .35}


def measure(path: str) -> dict:
    m = _measure(path)
    m.update(_open(path))
    return m


def _measure(path: str) -> dict:
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
    try:                                                               # does it reach extremes? how far its slow rise and fall spans, and how much of it sits at the top or the bottom
        hop1 = sr // 10
        e10 = 20 * np.log10(np.sqrt((m[:len(m) // hop1 * hop1].reshape(-1, hop1) ** 2).mean(1)) + 1e-6)
        slow = np.convolve(np.pad(e10, 20, mode="edge"), np.hanning(41) / np.hanning(41).sum(), "valid")
        top, bot = float(np.percentile(slow, 97)), float(np.percentile(slow, 3))
        out["range"] = round(top - bot, 1)                               # dB between its peaks and its depths: 6 is a wall of sound, 25 is a real fall
        out["at_extremes"] = round(float(np.mean((slow > top - (top - bot) * .2) | (slow < bot + (top - bot) * .2))), 2) if top - bot > 1 else 0.0
    except Exception:
        out.update(range=0.0, at_extremes=0.0)
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


def silences(path: str, amount: float = 1.0) -> dict:
    """Cut real silence into a song. The model never quite stops: where a song is meant to go quiet it only gets a little
    quieter, so there is always something sounding. This follows the song's own loudness and pushes down whatever falls
    well below the sounds around it: tails, beds, the murmur between hits. Loud sounds are not touched, so hits keep their
    full weight and gain an edge, and the gaps between them become actual gaps. `amount` 0 = nothing, 1 = firm, 2 = hard."""
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(path, always_2d=True, dtype="float32")
    hop, win = int(sr * .005), int(sr * .02)
    m = np.abs(x).max(1)
    n = (len(m) - win) // hop
    if n < 200 or amount <= 0:
        return {"changed": False}
    idx = np.arange(n)[:, None] * hop + np.arange(0, win, 4)[None]
    e = np.sqrt((m[idx] ** 2).mean(1)) + 1e-7                           # level every 5 ms
    span = int(1.5 / .005)
    ref = np.lib.stride_tricks.sliding_window_view(np.pad(e, span, mode="edge"), 2 * span + 1)[:, ::10].max(1)   # the loudest thing within a second and a half
    top = float(np.percentile(e, 95))
    d = e / np.maximum(ref, top * .2)                                   # how loud this moment is next to what surrounds it
    thr, p = .2, 1.2 * amount                                           # under about -14 dB of its surroundings, it is pushed down further
    g = np.where(d < thr, (d / thr) ** p, 1.0)
    look = 3                                                            # open 15 ms early, so the front of a hit is never shaved
    g = np.lib.stride_tricks.sliding_window_view(np.pad(g, (0, look), mode="edge"), look + 1).max(1)
    rel, out, cur = np.exp(-.005 / .05), np.empty_like(g), 1.0          # close over about 50 ms: a tail, not a click
    for i, v in enumerate(g):
        cur = v if v > cur else cur * rel + v * (1 - rel)
        out[i] = cur
    gain = np.interp(np.arange(len(x)), np.arange(n) * hop + win // 2, out).astype("float32")
    y = x * gain[:, None]
    sf.write(path, y, sr, subtype=sf.info(path).subtype)
    one = sr
    lv = lambda a: np.sqrt((a.mean(1)[:len(a) // one * one].reshape(-1, one) ** 2).mean(1))
    fl = lambda a: float(20 * np.log10(np.percentile(lv(a)[2:-2], 3) / (lv(a).max() + 1e-9) + 1e-7))
    return {"changed": True, "quietest_before": round(fl(x), 1), "quietest_after": round(fl(y), 1), "silent_share": round(float((gain < .05).mean()), 3),
            "loud_kept": round(float(20 * np.log10(np.sqrt((y ** 2).mean()) / (np.sqrt((x ** 2).mean()) + 1e-9))), 2)}


def gaps(path: str, bpm: float = 0, n: int = 4) -> dict:
    """Put real silences into a song, where they do the most: just before it comes back in. The songs here are walls of
    sound (no moment is much quieter than the next), so silence cannot be uncovered, it has to be made. The biggest
    re-entries are found (where the level steps up and stays up), and the beat or two before each is cut to nothing, ending
    exactly on the hit. The hit lands harder for it, and the song gets its stops."""
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(path, always_2d=True, dtype="float32")
    m = x.mean(1)
    hop = int(sr * .05)
    k = len(m) // hop
    if k < 600:
        return {"gaps": []}
    e = 20 * np.log10(np.sqrt((m[:k * hop].reshape(k, hop) ** 2).mean(1)) + 1e-6)     # level every 50 ms
    w = 40                                                                            # two seconds each side
    c = np.concatenate([[0], np.cumsum(e)])
    jump = np.full(k, -99.0)
    idx = np.arange(w, k - w)
    jump[idx] = (c[idx + w] - c[idx]) / w - (c[idx] - c[idx - w]) / w                 # how much louder the next two seconds are than the last two
    beat = 60.0 / bpm if bpm and 50 <= bpm <= 200 else .5
    length = float(min(.9, max(.3, beat * (2 if beat < .45 else 1))))                 # about half a second: one beat, or two fast ones
    picked = []
    for i in np.argsort(-jump):
        if jump[i] < 1.5 or len(picked) >= n:
            break
        t = i * .05
        if t < 8 or t > k * .05 - 6 or any(abs(t - q) < 14 for q in picked):
            continue
        picked.append(t)
    out, y = [], x.copy()
    for t in sorted(picked):
        a0, a1 = int((t - .35) * sr), int((t + .35) * sr)                              # land the end of the gap exactly on the hit
        seg = np.abs(m[a0:a1])
        f = sr // 200
        env = seg[:len(seg) // f * f].reshape(-1, f).max(1)
        hit = a0 + int(np.argmax(np.diff(env, prepend=env[0]))) * f
        g0, g1 = hit - int(length * sr), hit - int(.004 * sr)
        if g0 < sr:
            continue
        fade = int(.012 * sr)
        y[g0:g0 + fade] *= np.linspace(1, 0, fade, dtype="float32")[:, None]
        y[g0 + fade:g1] = 0
        out.append({"at": round(g0 / sr, 2), "seconds": round((g1 - g0) / sr, 2), "step_db": round(float(jump[int(round(t / .05))]), 1)})
    if out:
        sf.write(path, y, sr, subtype=sf.info(path).subtype)
    return {"gaps": out}


def extremes(path: str, target: float = 30.0, most: float = 3.5) -> dict:
    """Stretch a song toward its extremes. The model's loud and quiet passages are only a few dB apart; here the song's own
    slow rise and fall (over a couple of seconds) is exaggerated, so its peaks stay at full weight and its low passages
    sink toward nothing: the bottomless depths, and the bounce between the two. Hits inside a passage keep their shape,
    because only the slow movement is stretched, not each sound."""
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(path, always_2d=True, dtype="float32")
    m = x.mean(1)
    hop = int(sr * .1)
    k = len(m) // hop
    if k < 300:
        return {"changed": False}
    e = 20 * np.log10(np.sqrt((m[:k * hop].reshape(k, hop) ** 2).mean(1)) + 1e-6)
    w = 20                                                              # two seconds: slow enough that single hits do not move it
    slow = np.convolve(np.pad(e, w, mode="edge"), np.hanning(2 * w + 1) / np.hanning(2 * w + 1).sum(), "valid")
    hi, lo = float(np.percentile(slow, 97)), float(np.percentile(slow, 3))
    had = hi - lo
    if had < 1.5:
        return {"changed": False, "range_before": round(had, 1)}        # one level throughout: there is nothing to stretch
    ratio = float(min(most, max(1.0, target / had)))
    gdb = np.maximum(-6.0, np.minimum(0, (slow - hi) * (ratio - 1)))    # at its peaks nothing changes; lower passages sink a little, never far: pressed down hard, a sound chokes
    gain = np.interp(np.arange(len(x)), np.arange(k) * hop + hop // 2, 10 ** (gdb / 20)).astype("float32")
    sf.write(path, x * gain[:, None], sr, subtype=sf.info(path).subtype)
    return {"changed": True, "range_before": round(had, 1), "range_after": round(had * ratio, 1), "ratio": round(ratio, 2)}


def release(path: str, air: float = 2.2, width: float = .42) -> dict:
    """Let a closed sound out. If a piece has much less top end than a record, its highs are lifted (a smooth shelf from
    about 3 kHz, never more than 6 dB); if it is nearly mono, what it has at the sides is brought up above the bass (never
    more than 1.6 times). A piece that is already open is left alone. Its loudest moment stays as loud as it was."""
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(path, always_2d=True, dtype="float32")
    before = _open(path)
    lift = float(min(6.0, max(0.0, 10 * np.log10(air / max(before["air"], .05)) * .7)))
    wide = float(min(1.6, max(1.0, width / max(before["width"], .05)))) if x.shape[1] > 1 else 1.0
    if lift < .5 and wide < 1.05:
        return {"changed": False, **before}
    peak = float(np.abs(x).max()) + 1e-9
    f = np.fft.rfftfreq(len(x), 1 / sr)

    def step(lo, hi):
        u = np.clip((np.log(np.maximum(f, 1.0)) - np.log(lo)) / (np.log(hi) - np.log(lo)), 0, 1)
        return u * u * (3 - 2 * u)
    shelf = 1 + (10 ** (lift / 20) - 1) * step(2500.0, 8000.0)
    if x.shape[1] > 1:
        M, S = np.fft.rfft((x[:, 0] + x[:, 1]) / 2), np.fft.rfft((x[:, 0] - x[:, 1]) / 2)
        M, S = M * shelf, S * shelf * (1 + (wide - 1) * step(150.0, 400.0))
        mid, side = np.fft.irfft(M, len(x)), np.fft.irfft(S, len(x))
        y = np.stack([mid + side, mid - side], 1).astype("float32")
    else:
        y = np.fft.irfft(np.fft.rfft(x[:, 0]) * shelf, len(x)).astype("float32")[:, None]
    y *= peak / (float(np.abs(y).max()) + 1e-9)
    sf.write(path, y, sr, subtype=sf.info(path).subtype)
    after = _open(path)
    return {"changed": True, "lift_db": round(lift, 1), "widened": round(wide, 2), "air": [before["air"], after["air"]], "width": [before["width"], after["width"]]}


def finish(raw: str, dst: str, bpm: float) -> dict:
    """From a take as the model made it to the piece as it is heard: the machine's buzz out, and its own slow rise and fall
    made a little deeper, so a low passage really is lower than a peak. Nothing is cut and no silence is added.
    The raw take is not changed."""
    shutil.copy(raw, dst)
    info = {}
    for name, fn in (("buzz", lambda: polish(dst)), ("extremes", lambda: extremes(dst, 12.0, 1.4)), ("release", lambda: release(dst)),
                     ("drums", lambda: drums_forward(dst, _measure(raw).get("attack", .2)))):   # no silences are cut in: the artist does not want them forced
        try:
            info[name] = fn()
        except Exception as ex:
            info[name] = "skipped: " + str(ex)[:120]
    return info


def river(paths: list, out: str, cross: float = 7.0) -> float:
    """The whole collection as one piece that never stops: each ending melts into the next beginning."""
    import numpy as np
    import soundfile as sf
    acc, sr = None, 48000
    for p in paths:
        x, sr = sf.read(p, always_2d=True, dtype="float32")
        if x.shape[1] == 1:
            x = np.repeat(x, 2, 1)
        if acc is None:
            acc = x
            continue
        n = int(min(cross * sr, len(acc) / 3, len(x) / 3))
        t = np.linspace(0, np.pi / 2, n, dtype="float32")[:, None]
        acc = np.concatenate([acc[:-n], acc[-n:] * np.cos(t) + x[:n] * np.sin(t), x[n:]])
    if acc is None:
        return 0.0
    sf.write(out, acc, sr, subtype="PCM_16")
    return len(acc) / sr


def drier(path: str, keep: float = .45) -> dict:
    """Turn down what is held and keep what is struck. Sound is split into the part that stays (tones, beds, the hum under
    everything) and the part that happens (hits, clicks, the front of a shout); the staying part is turned down to `keep`
    of its level. Needs the ACE-Step environment's audio tools, so it runs there."""
    code = (
        "import sys, numpy as np, soundfile as sf\n"
        "from scipy.ndimage import median_filter\n"
        "from scipy.signal import stft, istft\n"
        "p, keep = sys.argv[1], float(sys.argv[2])\n"
        "x, sr = sf.read(p, always_2d=True, dtype='float32')\n"
        "f, t, Z = stft(x.T, sr, nperseg=2048, noverlap=1536)\n"
        "M = np.abs(Z).mean(0)\n"
        "H = median_filter(M, size=(1, 31)); P = median_filter(M, size=(31, 1))\n"
        "mh = H**2 / (H**2 + P**2 + 1e-12)\n"
        "g = (1 - mh) + mh * keep\n"
        "_, y = istft(Z * g[None], sr, nperseg=2048, noverlap=1536)\n"
        "y = y.T[:len(x)].astype('float32')\n"
        "y *= float(np.abs(x).max()) / (float(np.abs(y).max()) or 1.0)\n"
        "sf.write(p, y, sr, subtype=sf.info(p).subtype)\n"
        "print('ok')\n")
    from .paths import ENVS_DIR
    r = subprocess.run([str(ENVS_DIR / "ace_step" / "bin" / "python"), "-c", code, path, str(keep)], capture_output=True, text=True, timeout=300)
    if r.returncode:
        raise RuntimeError((r.stderr or "could not process").strip()[-300:])
    return {"keep": keep}


def drums_forward(path: str, attack: float, want: float = .26) -> dict:
    """Bring the percussion to the front. The sound is split into what is struck (hits, clicks, the crack of a snare) and
    what is held; when a piece's drums measure weaker than the artist wants, the struck part is turned up (by up to 7 dB,
    more the weaker they are) and the piece is brought back to the loudness it had, so everything else sits behind the
    drums. A piece whose drums are already in front is left alone. Runs in the ACE-Step environment, which has the tools."""
    up = float(min(7.0, max(0.0, (want - float(attack)) / .1 * 6.0)))
    if up < 1.0:
        return {"changed": False, "drums": attack}
    code = (
        "import sys, numpy as np, soundfile as sf\n"
        "from scipy.ndimage import median_filter\n"
        "from scipy.signal import stft, istft\n"
        "p, up = sys.argv[1], float(sys.argv[2])\n"
        "x, sr = sf.read(p, always_2d=True, dtype='float32')\n"
        "f, t, Z = stft(x.T, sr, nperseg=2048, noverlap=1536)\n"
        "M = np.abs(Z).mean(0)\n"
        "H = median_filter(M, size=(1, 31)); P = median_filter(M, size=(31, 1))\n"
        "mp = P**2 / (H**2 + P**2 + 1e-12)\n"
        "g = 1 + (10 ** (up / 20) - 1) * mp\n"
        "_, y = istft(Z * g[None], sr, nperseg=2048, noverlap=1536)\n"
        "y = y.T[:len(x)].astype('float32')\n"
        "y *= float(np.abs(x).max()) / (float(np.abs(y).max()) or 1.0)\n"
        "sf.write(p, y, sr, subtype=sf.info(p).subtype)\n"
        "print('ok')\n")
    from .paths import ENVS_DIR
    r = subprocess.run([str(ENVS_DIR / "ace_step" / "bin" / "python"), "-c", code, path, str(up)], capture_output=True, text=True, timeout=300)
    if r.returncode:
        raise RuntimeError((r.stderr or "could not process").strip()[-300:])
    return {"changed": True, "up_db": round(up, 1), "drums": attack}


def score(m: dict, others: list[dict]) -> dict:
    """A stand-in for judgement, made of things that can be measured, in the artist's terms: can it be danced to (a steady
    pulse and real drum hits at a dance tempo), is it clear (no tone that never stops), does it reach extremes, do its
    states hold, and is it unlike the pieces already finished. It cannot tell whether a piece moves anyone."""
    drums = .5 * min(1, max(0, (m["attack"] - .06) / .22)) + .5 * min(1, m["steady"] / .45)
    tempo = 1.0 if 110 <= m["bpm"] <= 190 or 55 <= m["bpm"] < 95 else .6          # found tempo in a dance range (or its half)
    dance = drums * tempo
    ext = .7 * min(1, float(m.get("range", 0)) / 12) + .3 * min(1, float(m.get("at_extremes", 0)) / .6)
    far, near = 1.0, None
    for o in others:
        d = (sum((m[k] - o["m"][k]) ** 2 for k in VEC) / len(VEC) + ((m["bpm"] - o["m"]["bpm"]) / 200) ** 2) ** .5
        if d < far:
            far, near = d, o["title"]
    variety = min(1, far / .22) if others else 1.0
    defn = float(m.get("definition", 0))
    opened = .7 * min(1, max(0, (float(m.get("air", 1.0)) - .5) / 1.7)) + .3 * min(1, max(0, (float(m.get("width", .35)) - .2) / .22))   # released, not choked: a top end and some width
    clear = min(1, max(0, 1 - (float(m.get("hum", 0)) - 7) / 9))           # no tone that never stops. Silence is not rewarded for its own sake.
    return {"total": round(.36 * dance + .13 * clear + .14 * opened + .09 * ext + .03 * defn + .25 * variety, 3), "open": round(opened, 2), "dance": round(dance, 2), "extremes": round(ext, 2), "clarity": round(clear, 2), "drums": round(drums, 2),
            "definition": round(defn, 2), "variety": round(variety, 2), "nearest": near, "shape": round(ext, 2)}


def revise(song: dict, m: dict, sc: dict, tries_left: int, rng) -> dict:
    """What to change for the next try. Claude reads the measurements and rewrites the plan; without it, drums are added by rule."""
    try:
        said = lambda v, lo, hi: "low" if v < lo else "high" if v > hi else "middling"
        prompt = (f'Song: "{song["title"]}" for the creature {song["creature"]}. Its idea: {song["idea"]}\n\nCAPTION\n{song["caption"]}\n\nLYRICS\n{song["lyrics"]}\n\n'
                  f"It was made, and measured (nobody has heard it; these numbers are all there is):\n"
                  f'- sharp drum hits: {m["attack"]} ({said(m["attack"], .12, .3)}; under 0.12 means almost no drums can be found)\n'
                  f'- steady pulse: {m["steady"]} ({said(m["steady"], .25, .5)}; this is what people dance to: under 0.25 there is no beat to follow, 0.45 and over is a floor that moves)\n- tempo found: {m["bpm"]} bpm (asked for {song["bpm"]})\n'
                  f'- clear pitches vs noise: tonal {m["tonal"]}, hiss {m["noise"]}\n- voice-like movement: {m["voice"]}\n- how squashed and distorted: {m["dist"]}\n'
                  f'- loudness through the piece in 5-second steps, in dB below its loudest: {m["sections"]}\n'
                  f'  (its peaks and depths are {m.get("range")} dB apart: under 6 it is a wall of sound with no depth at all; and {m.get("at_extremes")} of its time is spent at one extreme or the other)\n'
                  + f'- a constant tone under everything: {m.get("hum")} dB at {m.get("hum_hz")} Hz (under 8 is clean, over 12 is a hum the artist hears and dislikes)\n'
                  f'- its quietest second: {m.get("floor")} dB below its loudest (for information only: silence is not a goal, and must not be added unless this piece is about emptiness)\n'
                  + (f'- the finished song it is most like: "{sc["nearest"]}" (variety {sc["variety"]}, 1 = very different)\n' if sc.get("nearest") else "")
                  + f"\nTries left for this song: {tries_left}. The artist heard a song that measured 0.12 for drum hits and said it needed more drums, so merely detectable is not enough: aim for drum hits of 0.2 or more in the parts where drums play. It must be danceable above all. Answer keep=true only if the steady pulse is at least 0.4, drum hits are at least 0.2, the constant tone is under 10 dB, and it is unlike the others (still return the caption, lyrics and bpm unchanged).\n"
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


LENSES = ("release: the stretch that sounds most choked (muffled, squeezed, boxed in, everything pressed into one lump), to be opened so that each sound is clear and rings out",
          "the beat: where it falls apart, where the kick goes missing, where a body would stop moving",
          "the extremes: a peak that is not overwhelming enough, a depth that is not heavy enough",
          "the edges: a stretch that is a blur, a mass of sound with no separate, countable events",
          "the passage: a change of state that is too orderly, or one that should melt and instead jolts")


def chisel_plan(song: dict, m: dict, tried: list, rng, lens: str = "", guest: str = "", history=None, learned=None) -> dict:
    """Which stretch of the song to carve next, and into what. Claude reads the song as a timeline; without it, the stretch
    with the fewest drum hits that has not been tried is given drums."""
    secs, hits, lev = float(m.get("secs") or song["duration"]), m.get("hits") or [], m.get("sections") or []
    words = _word(guest, rng) if guest else song["caption"].split(",")[0].strip()
    try:
        line = lambda arr: " ".join(f"{int(i * 5)}s:{v}" for i, v in enumerate(arr))
        told = lambda c: f"{c['from']:.0f}-{c['to']:.0f}s {'KEPT' if c.get('kept') else 'thrown away'}" + (f" (by {c['by']})" if c.get("by") else "") + f": {str(c.get('why') or '')[:170]}"
        hist = ""
        if history:                                            # what carving has already done to this piece, so it builds on what worked
            hist += "- carvings already tried on THIS piece (kept = the piece measured better afterwards):\n" + "\n".join("  · " + told(c) for c in history[-8:]) + "\n"
        if learned:
            hist += "- carvings on OTHER pieces tonight:\n" + "\n".join(f'  · "{t}" ' + told(c) for t, c in learned) + "\n"
        if hist:
            hist += "  Learn from these: make the KIND of change that was kept, and do not repeat the kind that was thrown away.\n"
        prompt = (f'Song: "{song["title"]}" ({secs:.0f} seconds) for the creature {song["creature"]}. Its idea: {song["idea"]}\n\nCAPTION\n{song["caption"]}\n\nLYRICS (the plan it was made from)\n{song["lyrics"]}\n\n'
                  "It exists as audio now. Nobody has heard it; this is what can be measured:\n"
                  f"- level in 5-second steps (dB below its loudest): {line(lev)}\n- drum hits in 5-second steps (0 none .. 1 hard): {line(hits)}\n"
                  f'- its kinds of sound, one letter per 2.5 seconds: {m.get("kinds", "")}\n  (a defined song reads like AAAABBBBAAAACCCCBBBB: clear blocks that hold and return. A wash reads like ABACBADC or AAAAAAAAAAAA.)\n'
                  f'- a constant tone under everything: {m.get("hum")} dB at {m.get("hum_hz")} Hz (over 12 is a hum the artist hears); its quietest second is {m.get("floor")} dB below its loudest (-12 means it never lets go)\n'
                  f'- how defined its structure measures: {m.get("definition")} of 1. Drums overall: {m["attack"]} (the artist wants 0.2 or more). In the 5-second timeline, a stretch with real drums reads about 0.2 to 0.4, and under 0.1 means none.\n'
                  f'- how released it is: {m.get("air")} percent of its energy is above 6 kHz (0.5 is choked and muffled, 2 or more is open) and its stereo width is {m.get("width")} (0.25 is nearly mono, 0.4 is open)\n'
                  + hist + understood()
                  + ("- stretches already reworked, do not pick these again: " + ", ".join(f"{a:.0f}-{b:.0f}s" for a, b in tried) + "\n" if tried else "")
                  + (f"\nThis time look especially at {lens}." if lens else "")
                  + (f"\nFor this stretch ANOTHER CREATURE takes over: {_sides(guest)}. Write the stretch for what that creature would do with it, so the piece becomes a meeting of the two." if guest else "")
                  + "\nChiselling means RELEASING the piece from the block, as a sculptor frees a statue: every carving must leave the sound clearer and more open than it found it, never denser. "
                  "The drums are the front of the piece: a carving must leave them at least as loud and as present as it found them, never thinner or further back. "
                  "Pick ONE stretch of 12 to 30 seconds to make again, the one whose remaking would most free the piece as dance music that reaches extremes: a stretch that is choked or a lump of sound, a stretch where the beat falls apart or the kick goes missing (unless that is a planned void), a peak that is not overwhelming enough, a depth that is not heavy enough, "
                  "a stretch that is merely in-between, or a peak whose drums are missing. Do not add silences: only if the plan itself has a void section and the timeline shows that it is not empty may that one be made emptier. "
                  f'Give start and end in seconds, and a caption for JUST that stretch: it must begin with "{words}", then say concretely what plays there (which drums and how, the low end, the voices, the noise), fewer things rather than more, and end with "loud drums in front of everything, clear open sound, bright crisp top end, wide, every hit rings out". '
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
        return {"start": float(i * 5), "end": float(min(secs, i * 5 + 20)), "caption": words + ", " + ", ".join(rng.sample(DRUMS, 2)) + ", hard clear hits on every beat, open bright sound, " + rng.choice(VOICE),
                "note": "by rule: the stretch with the fewest drum hits gets drums (Claude did not answer: " + str(ex)[:60] + ")"}


def hybrid(who: list, d: Path) -> str:
    """Two, three or four creatures merged into one adapter, made on the spot (nothing is trained), each with an equal share.
    Returns the folder of the merged adapter."""
    who = list(dict.fromkeys(who))
    paths = [gym.adapter_path(c) for c in who]
    if len(who) < 2 or not all(paths):
        raise RuntimeError("every creature in a hybrid must be trained")
    py, tool = str(ENVS_DIR / "ace_step" / "bin" / "python"), str(ENGINES_DIR / "ace_step" / "breed.py")
    cur, name = paths[0], re.sub(r"[^0-9A-Za-z]", "_", who[0])
    for k in range(1, len(who)):                              # folded in one at a time, weighted so that all end up equal
        name += "__" + re.sub(r"[^0-9A-Za-z]", "_", who[k])
        out = d / "hybrids" / ("hy_" + name)
        if not (out / "adapter_model.safetensors").exists():
            out.parent.mkdir(parents=True, exist_ok=True)
            r = subprocess.run([py, tool, str(cur), str(paths[k]), str(out), str(k / (k + 1))], capture_output=True, text=True, timeout=300)
            if r.returncode or not (out / "adapter_model.safetensors").exists():
                raise RuntimeError("could not merge the creatures: " + (r.stdout or r.stderr or "").strip()[-200:])
        cur = out
    return str(cur)


def _word(slug: str, rng) -> str:
    c = gym._load(slug)
    limbs = c.get("limbs") or []
    return rng.choices(limbs, weights=[max(1, l.get("count", 1)) for l in limbs])[0]["trigger"] if limbs else (c.get("tag") or slug)


def rebuild(d: Path, sheet: dict) -> list:
    """The finished pieces of a collection, read back from disk, so that chiselling can go on after the app was closed or the
    time ran out. Each piece's plan is in the library next to it, and its untouched take is in the collection's folder."""
    done = []
    for e in sheet.get("songs", []):
        path = e.get("path")
        if not path or not Path(path).exists():
            continue
        raw = d / "as made" / Path(path).name
        meta = Path(path).parent / "meta.json"
        if not raw.exists() or not meta.exists():
            continue
        p = json.loads(meta.read_text()).get("params") or {}
        song = {"title": e["title"], "creature": p.get("creature") or e.get("creature"), "idea": e.get("idea", ""), "caption": p.get("caption", ""), "lyrics": p.get("lyrics", "[Instrumental]"),
                "bpm": int(p.get("bpm") or 140), "duration": int(float(p.get("duration") or 150))}
        e.setdefault("carving", [])
        at = p.get("creature_at") if p.get("creature_at") and Path(str(p.get("creature_at"))).exists() else ""
        done.append({"title": e["title"], "m": measure(str(raw)), "n": e["n"], "path": path, "raw": str(raw), "song": song, "sc": None, "strength": float(p.get("creature_strength") or 1.6), "at": at, "entry": e,
                     "tried": [(c["from"], c["to"]) for c in e["carving"]][-3:], "misses": 0, "carved": 0})
    for s_ in done:
        s_["sc"] = score(s_["m"], [o for o in done if o is not s_])
    return done


def status() -> dict:
    s = {k: v for k, v in _state.items() if k not in ("job", "stop")}
    return s or {"running": False}


def stop():
    if _state.get("running"):
        _state["stop"] = True
        if _state.get("job"):
            _state["job"]["cancel"] = True


def start(engines: dict, jobs: dict, coerce, creatures, count: int = 10, direction: str = "", tries: int = 1, name: str = "", hours: float = 0, resume: str = "", merges_only=()) -> dict:
    """Make a collection. Every song starts as its own idea and gets up to `tries` goes: made, measured, revised, made again.
    The best go of each is the song; only those reach the library.
    With `hours`, it then keeps chiselling until that time is up: one stretch of one song is made again, and the change is
    kept only if the song measures as more defined than before. A song is left alone once three carvings in a row did not help."""
    if _state.get("running"):
        raise RuntimeError("a night shift is already running")
    e = engines.get("ace_step")
    if not e or not e.installed:
        raise RuntimeError("ACE-Step is not installed")
    old = None
    if resume:                                                # carry on chiselling a collection that already exists
        if not re.fullmatch(r"[a-z0-9]{6,16}", resume) or not (DIR / resume / "collection.json").exists():
            raise FileNotFoundError("no such collection")
        old = json.loads((DIR / resume / "collection.json").read_text())
        creatures, name, direction = old.get("creatures") or creatures, old.get("name") or name, old.get("direction") or direction
    creatures = [c for c in ([creatures] if isinstance(creatures, str) else list(creatures or [])) if c and gym.adapter_path(c)]
    if not creatures:
        raise RuntimeError("pick at least one trained creature")
    count, tries = max(1, min(200, int(count))), max(1, min(8, int(tries)))
    sid = resume or uuid.uuid4().hex[:10]
    d = DIR / sid
    d.mkdir(parents=True, exist_ok=True)
    job = {"id": uuid.uuid4().hex[:12], "engine": "night shift", "state": "running", "msg": "starting", "frac": 0, "outputs": [], "info": {}, "error": None, "seed": None, "cancel": False}
    jobs[job["id"]] = job
    tag = (name.strip() or time.strftime("collection %Y-%m-%d"))[:50]
    _state.clear()
    hours = max(0.0, min(16.0, float(hours or 0)))
    _state.update(running=True, id=sid, creatures=creatures, creature=creatures[0], count=count, tries=tries, made=0, thrown=0, msg="starting…", started=time.time(), songs=[], tag=tag,
                  job=job, stop=False, error=None, per=None, hours=hours, until=time.time() + hours * 3600 if hours else None, phase="making", carved=0, carves=0)
    sheet = old or {"id": sid, "name": tag, "creatures": creatures, "direction": direction, "tries": tries, "started": time.strftime("%Y-%m-%d %H:%M:%S"), "songs": []}
    save = lambda: (d / "collection.json").write_text(json.dumps(sheet, indent=1, ensure_ascii=False))

    def make(song, where: Path, strength: float, seed: int):
        mix = song.get("mix") or ([song["creature2"]] if song.get("creature2") else [])
        at = hybrid([song["creature"], *mix], d) if mix else ""
        params = gym.bred_boost(coerce(e.spec, {"task": "text2music", "caption": song["caption"], "lyrics": song["lyrics"], "duration": song["duration"], "bpm": song["bpm"],
                                                "thinking": True, "batch": 1, "seed": seed, "creature": song["creature"], "creature_strength": round(strength * (1 + .1 * len(mix)), 2)}))   # measured: a merge played at double smears the drums; a little above a single creature's strength is clearest
        if at:
            params["creature_at"] = at
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
            awake = subprocess.Popen(["caffeinate", "-i", "-s", "-w", str(os.getpid())])   # this Mac stays awake for as long as the shift runs, and never longer than Zvoid itself
        except Exception:
            pass
        rng, fails = random.Random(), 0
        try:
            done = []                                              # finished songs: {title, m}
            if old:
                _state["msg"] = "reading the collection back…"
                plan, done = [], rebuild(d, sheet)
                _state.update(made=len(done), count=len(done), songs=[{"n": s_["n"], "name": s_["title"], "path": s_["path"], "creature": s_["song"]["creature"], "idea": s_["song"]["idea"]} for s_ in done])
            else:
                _state["msg"] = f"writing {count} different ideas…"
                job.update(msg=_state["msg"])
                plan = ideas(creatures, count, direction, rng, [c for c in (merges_only or []) if c in creatures])
                sheet["ideas"] = [{k: x.get(k) for k in ("title", "creature", "mix", "idea", "bpm", "duration", "starts", "ends")} for x in plan]
                save()
            for n, song in enumerate(plan, 1):
                if _state["stop"] or _state["error"]:
                    break
                entry = {"n": n, "title": song["title"], "creature": song["creature"], "creature2": song.get("creature2", ""), "mix": song.get("mix") or [], "idea": song["idea"], "tries": []}
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
                    work = d / "as made"                            # every piece as the model made it, untouched: what carving works on, and what can always be gone back to
                    work.mkdir(exist_ok=True)
                    raw = work / dst.name
                    shutil.move(str(src), str(raw))
                    shutil.rmtree(src.parent, ignore_errors=True)
                    entry["finish"] = finish(str(raw), str(dst), best["m"].get("bpm") or best["song"]["bpm"])
                    library.write_meta(run, {"engine": "ace_step", "engine_name": "night shift", "created": time.strftime("%Y-%m-%d %H:%M:%S"), "label": label,
                                             "params": best["params"], "outputs": [{"path": str(dst), "kind": "audio", "label": best["song"]["title"]}],
                                             "info": {"idea": best["song"]["idea"], "score": best["sc"]}, "seconds": 0})
                    done.append({"title": best["song"]["title"], "m": best["m"], "n": n, "path": str(dst), "raw": str(raw), "song": best["song"], "sc": best["sc"],
                                 "strength": float(best["params"].get("creature_strength") or strength), "entry": entry, "at": best["params"].get("creature_at") or "",
                                 "tried": [], "misses": 0, "carved": 0})
                    first = d / "first takes"                       # the piece before any carving
                    first.mkdir(exist_ok=True)
                    shutil.copy(raw, first / dst.name)
                    entry.update(path=str(dst), score=best["sc"], carving=[])
                    _state["made"] = len(done)
                    _state["songs"].append({"n": n, "name": best["song"]["title"], "path": str(dst), "creature": " × ".join([best["song"]["creature"], *(best["song"].get("mix") or [])]), "idea": best["song"]["idea"]})
                    _state["per"] = round((time.time() - _state["started"]) / len(done), 1)
                sheet["songs"].append(entry)
                save()
            # ---- the rest of the night: chisel. One stretch of one song is made again; it is kept only if the song measures as more defined
            rnd, cycle, idle_cycles = 0, 0, 0
            while hours and done and not _state["stop"] and not _state["error"] and time.time() < _state["until"]:
                live = [s_ for s_ in done if s_["misses"] < 3 and s_["carved"] < 6]
                if not live:                                       # every piece has settled under this way of looking: look again another way, for as long as the night lasts
                    if _state["carved"] == _state.get("carved_at_cycle", -1):
                        idle_cycles += 1
                        if idle_cycles >= len(LENSES):             # a whole turn of every way of looking without one improvement: it is as carved as this can make it
                            break
                    else:
                        idle_cycles = 0
                    _state["carved_at_cycle"] = _state["carved"]
                    cycle += 1
                    for s_ in done:
                        s_.update(misses=0, carved=0, tried=s_["tried"][-2:])
                    continue
                _state["lens"] = LENSES[cycle % len(LENSES)]
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
                        others_ = [c_ for c_ in creatures if c_ not in (s_["song"]["creature"], *(s_["song"].get("mix") or []), s_["song"].get("creature2"))]
                        guest = rng.choice(others_) if others_ and rng.random() < .4 else ""      # now and then another creature carves the stretch: the creatures meet inside a piece
                        seen = [(o["title"], c) for o in done if o is not s_ for c in o["entry"].get("carving", [])]
                        cp = chisel_plan(s_["song"], s_["m"], s_["tried"], rng, LENSES[cycle % len(LENSES)], guest, s_["entry"].get("carving", []),
                                         [x for x in seen if x[1].get("kept")][-3:] + [x for x in seen if not x[1].get("kept")][-3:])
                        s_["tried"].append((cp["start"], cp["end"]))
                        _state["msg"] = base + f" · remaking {cp['start']:.0f}–{cp['end']:.0f}s"
                        where.mkdir()
                        params = gym.bred_boost(coerce(e.spec, {"task": "repaint", "src_audio": s_["raw"], "repaint_start": cp["start"], "repaint_end": cp["end"], "caption": cp["caption"],
                                                                "lyrics": s_["song"]["lyrics"], "duration": round(float(s_["m"].get("secs") or s_["song"]["duration"]), 1), "thinking": False, "batch": 1,
                                                                "seed": rng.randint(1, 2 ** 31 - 1), "creature": guest or s_["song"]["creature"],
                                                                "creature_strength": 1.6 if guest else s_["strength"]}))
                        if s_.get("at") and not guest:
                            params["creature_at"] = s_["at"]
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
                        better = bool(sc2) and sc2["total"] > s_["sc"]["total"] + .002 and m2["attack"] >= s_["m"]["attack"] - .015   # a carving that costs the piece its drums is never kept, whatever else it gains
                        s_["entry"]["carving"].append({"round": rnd, "lens": LENSES[cycle % len(LENSES)].split(":")[0], "from": cp["start"], "to": cp["end"], "why": cp["note"], "by": guest or "", "kept": better, "broken": why or None,
                                                       "before": s_["sc"]["total"], "after": sc2["total"] if sc2 else None, "definition": [s_["sc"]["definition"], sc2["definition"] if sc2 else None]})
                        if better:
                            shutil.copy(outs[0]["path"], s_["raw"])             # the working copy is now the carved one,
                            s_["entry"]["finish"] = finish(s_["raw"], s_["path"], m2.get("bpm") or s_["song"]["bpm"])   # and the piece in the library is made from it again
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
            if len(done) >= 2:                                  # and the whole of it as one piece that never stops
                try:
                    _state["msg"] = "joining them into one piece…"
                    label = f"{tag} · the whole passage as one"
                    run = Path(sheet["river"]) if sheet.get("river") and Path(sheet["river"]).is_dir() else library.new_run_dir("ace_step", label)
                    sheet["river"] = str(run)
                    secs = river([s_["path"] for s_ in sorted(done, key=lambda q: q["n"])], str(run / "the whole passage.wav"))
                    library.write_meta(run, {"engine": "ace_step", "engine_name": "night shift", "created": time.strftime("%Y-%m-%d %H:%M:%S"), "label": label, "params": {},
                                             "outputs": [{"path": str(run / "the whole passage.wav"), "kind": "audio", "label": "the whole passage"}], "info": {"seconds": round(secs)}, "seconds": 0})
                except Exception as ex:
                    print("[night] could not join them: " + str(ex)[:300], flush=True)
            _state["msg"] = (f"stopped: {_state['made']} songs are in the library" if _state["stop"] else "stopped: " + _state["error"] if _state["error"]
                             else f"done: {_state['made']} songs are in the library as “{tag}”" + (f", {_state['carved']} carvings kept of {_state['carves']} tried" if _state.get("carves") else ""))
        except Exception as ex:
            _state["error"] = str(ex).strip().splitlines()[0][:300] if str(ex).strip() else "it failed"
            _state["msg"] = "stopped: " + _state["error"]
            print("[night] stopped: " + str(ex).strip()[-800:], flush=True)
        finally:
            if awake:
                awake.terminate()
            for o in sheet["songs"]:
                o.pop("entry", None)
            for t_ in d.glob("s*_t*"):
                shutil.rmtree(t_, ignore_errors=True)                # no leftovers: only the finished songs and the sheet remain
            _state.update(running=False, finished=time.time())
            job.update(state="cancelled" if _state.get("stop") else "error" if _state.get("error") else "done", msg=_state["msg"], frac=1)

    threading.Thread(target=work, daemon=True).start()
    return status()
