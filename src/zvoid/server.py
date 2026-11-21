"""Local API + the patch-canvas frontend. Binds to 127.0.0.1 only."""

from __future__ import annotations

import json
import random
import re
import socket
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from . import chat, gym, library
from .engines import discover, env_size
from .paths import NAME, OUTPUTS_DIR, PATCHES_DIR, UPLOADS_DIR, WEB_DIR

LOCAL = ("127.0.0.1", "localhost")
NO_CACHE = {"Cache-Control": "no-store"}


def _inside_outputs(path: str) -> Path:
    p = Path(path).resolve()
    if OUTPUTS_DIR.resolve() not in p.parents or not p.exists():
        raise HTTPException(400, "file is not in the outputs folder")
    return p


def _num(v):
    f = float(v)
    return int(f) if f.is_integer() else f


def _coerce(spec: dict, params: dict) -> dict:
    """Turn what the canvas sends into the types each engine expects."""
    out = {}
    for q in spec.get("params", []):
        k, t = q["name"], q.get("type", "text")
        v = params.get(k, q.get("default"))
        if t in ("int", "seed"):
            v = int(float(v)) if v not in (None, "") else (-1 if t == "seed" else None)
        elif t in ("slider", "number"):
            v = _num(v) if v not in (None, "") else None
        elif t == "bool":
            v = bool(v)
        elif t in ("audio", "file"):
            v = str(_inside_outputs(v)) if v else None
        out[k] = v
    extra = params.get("extra") or {}
    if isinstance(extra, str):
        try:
            extra = json.loads(extra or "{}")
        except ValueError:
            raise HTTPException(400, 'Extra kwargs must be JSON, like {"top_k": 250}')
    if not isinstance(extra, dict):
        raise HTTPException(400, "Extra kwargs must be a JSON object")
    out["extra"] = extra
    if "seed" in out and (out["seed"] is None or out["seed"] < 0):
        out["seed"] = random.randint(0, 2**31 - 1)
    return out


def create_app():
    engines = discover()
    jobs: dict[str, dict] = {}
    installs: dict[str, dict] = {}
    app = FastAPI(title=NAME, docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        # Refuse anything that isn't this machine talking to itself (blocks other sites poking the API)
        host = request.headers.get("host", "").rsplit(":", 1)[0]
        origin = request.headers.get("origin")
        if host not in LOCAL or (origin and origin.split("//")[-1].rsplit(":", 1)[0] not in LOCAL):
            return JSONResponse({"detail": "local only"}, status_code=403)
        return await call_next(request)

    # ---- frontend ---------------------------------------------------
    @app.get("/")
    def index():
        return FileResponse(WEB_DIR / "index.html", headers=NO_CACHE)

    @app.get("/web/{name}")
    def asset(name: str):
        f = (WEB_DIR / name).resolve()
        if WEB_DIR.resolve() not in f.parents or not f.is_file():
            raise HTTPException(404)
        return FileResponse(f, headers=NO_CACHE)

    @app.post("/api/clientlog")
    def clientlog(body: dict):
        """Errors from the window's JavaScript, so they show up in the app log."""
        print("[ui]", str(body.get("msg", ""))[:1500], flush=True)
        return {"ok": True}

    @app.get("/api/meta")
    def meta():
        return {"name": NAME, "claude": chat.available()}

    @app.post("/api/chat")
    def chat_turn(body: dict):
        try:
            return chat.ask(engines, NAME, str(body.get("message", ""))[:4000], body.get("patch") or {}, body.get("session"))
        except RuntimeError as ex:
            raise HTTPException(502, str(ex))

    # ---- engines ------------------------------------------------------
    def engine_or_404(eid):
        if eid not in engines:
            raise HTTPException(404, f"unknown engine {eid}")
        return engines[eid]

    @app.get("/api/engines")
    def list_engines(sizes: bool = False):
        creatures = gym.trained_slugs()
        return [dict(e.spec, id=e.id, installed=e.installed, running=e.running,
                     params=[dict(q, choices=[""] + creatures) if q.get("type") == "creature" else q for q in e.spec.get("params", [])],
                     env_size=env_size(e) if sizes else None,
                     installing=installs.get(e.id, {}).get("running", False)) for e in engines.values()]

    @app.post("/api/engines/{eid}/unload")
    def unload(eid: str):
        engine_or_404(eid).stop()
        return {"ok": True}

    @app.post("/api/engines/{eid}/install")
    def install(eid: str):
        e = engine_or_404(eid)
        if installs.get(eid, {}).get("running"):
            return {"ok": True}
        st = installs[eid] = {"running": True, "log": [], "error": None}

        def work():
            try:
                e.install(st["log"].append)
            except Exception as ex:
                st["error"] = str(ex)
                st["log"].append(f"✖ {ex}")
            st["running"] = False

        threading.Thread(target=work, daemon=True).start()
        return {"ok": True}

    @app.get("/api/engines/{eid}/install")
    def install_status(eid: str):
        st = installs.get(eid) or {"running": False, "log": [], "error": None}
        return {"running": st["running"], "error": st["error"], "log": "\n".join(st["log"][-200:])}

    # ---- jobs -----------------------------------------------------------
    @app.post("/api/run")
    async def run(request: Request):
        body = await request.json()
        e = engine_or_404(body.get("engine"))
        params = _coerce(e.spec, body.get("params") or {})
        lp = e.spec.get("label_param", "prompt")
        lv = params.get(lp)
        is_file = any(q["name"] == lp and q.get("type") in ("audio", "file") for q in e.spec.get("params", []))
        label = (re.sub(r"^\d{6}_", "", Path(lv).stem) if lv else "") if is_file else str(lv or "")
        job = {"id": uuid.uuid4().hex[:12], "engine": e.id, "state": "queued", "msg": "queued", "frac": None,
               "outputs": [], "info": {}, "error": None, "seed": params.get("seed"), "cancel": False}
        jobs[job["id"]] = job

        def work():
            run_dir = library.new_run_dir(e.id, label)
            t0 = time.time()
            try:
                outputs, info = [], {}
                for ev in e.run(params, run_dir):
                    if job["state"] == "queued":
                        job.update(state="running", msg="starting")
                    if ev[0] == "progress":
                        job.update(msg=ev[1], frac=ev[2])
                    else:
                        outputs, info = ev[1], ev[2]
            except Exception as ex:
                if not any(run_dir.iterdir()):
                    run_dir.rmdir()
                job.update(state="cancelled" if job["cancel"] else "error", error=str(ex), msg="stopped" if job["cancel"] else "failed")
                return
            secs = round(time.time() - t0, 1)
            library.write_meta(run_dir, {
                "engine": e.id, "engine_name": e.name, "created": time.strftime("%Y-%m-%d %H:%M:%S"),
                "label": label, "params": params, "outputs": outputs, "info": info, "seconds": secs})
            for o in outputs:
                o["name"] = Path(o["path"]).name
            job.update(state="done", outputs=outputs, info=dict(info, seconds=secs, folder=str(run_dir)),
                       msg=f"done in {secs}s", frac=1)

        threading.Thread(target=work, daemon=True).start()
        return {"id": job["id"], "seed": job["seed"]}

    @app.get("/api/jobs/{jid}")
    def job_status(jid: str):
        if jid not in jobs:
            raise HTTPException(404)
        return jobs[jid]

    @app.post("/api/jobs/{jid}/cancel")
    def cancel(jid: str):
        job = jobs.get(jid)
        if job and job["state"] in ("queued", "running"):
            job["cancel"] = True
            engines[job["engine"]].stop()  # kills the worker; the model reloads on the next run
        return {"ok": True}

    # ---- files ----------------------------------------------------------
    @app.get("/api/file")
    def get_file(path: str):
        return FileResponse(_inside_outputs(path))

    @app.post("/api/upload")
    async def upload(request: Request, name: str = "audio.wav"):
        safe = re.sub(r"[^\w.\- ]+", "_", Path(name).name)[-80:] or "audio.wav"
        dst = UPLOADS_DIR / f"{time.strftime('%H%M%S')}_{safe}"
        dst.write_bytes(await request.body())
        return {"path": str(dst), "name": safe}

    @app.get("/api/made")
    def made():
        return library.list_items()

    @app.post("/api/made/star")
    async def made_star(request: Request):
        b = await request.json()
        return {"star": library.star(str(_inside_outputs(b.get("path"))), bool(b.get("on")))}

    @app.post("/api/made/trash")
    async def made_trash(request: Request):
        f = _inside_outputs((await request.json()).get("path"))
        if not f.is_file():
            raise HTTPException(404, "that file is gone")
        library.trash(f)
        return {"ok": True}

    @app.get("/api/thumb")
    def thumb(path: str):
        try:
            return FileResponse(library.thumb(_inside_outputs(path)), media_type="image/jpeg")
        except FileNotFoundError as ex:
            raise HTTPException(404, str(ex))

    @app.post("/api/reveal")
    async def reveal(request: Request):
        path = (await request.json()).get("path")
        target = _inside_outputs(path) if path else OUTPUTS_DIR
        subprocess.run(["open", "-R", str(target)] if path and target.is_file() else ["open", str(target)])
        return {"ok": True}

    @app.get("/api/library")
    def lib(q: str = ""):
        runs = library.list_runs(300)
        if q:
            runs = [r for r in runs if q.lower() in json.dumps(r).lower()]
        return [{"created": r.get("created"), "engine": r.get("engine"), "engine_name": r.get("engine_name"),
                 "label": r.get("label"), "seed": (r.get("params") or {}).get("seed"),
                 "model": (r.get("params") or {}).get("model"), "folder": r["_dir"],
                 "files": [{"path": f, "name": Path(f).name,
                            "kind": "audio" if Path(f).suffix.lower() in library.AUDIO_EXT else "file"}
                           for f in library.run_files(r["_dir"])]} for r in runs]

    # ---- gym (creatures = adapters trained on your audio) -----------------
    def gym_call(fn, *a, **k):
        try:
            return fn(*a, **k)
        except FileNotFoundError as ex:
            raise HTTPException(404, str(ex))
        except (ValueError, RuntimeError) as ex:
            raise HTTPException(400, str(ex))

    @app.get("/api/gym")
    def gym_list():
        return gym.list_creatures()

    @app.post("/api/gym")
    def gym_hatch(body: dict):
        return gym_call(gym.hatch, str(body.get("name", "")))

    @app.post("/api/gym_breed")
    def gym_breed(body: dict):
        return gym_call(gym.breed, str(body.get("a", "")), str(body.get("b", "")), str(body.get("name", "")))

    @app.get("/api/gym/{slug}")
    def gym_get(slug: str):
        return gym_call(gym.get, slug)

    @app.put("/api/gym/{slug}")
    def gym_update(slug: str, body: dict):
        return gym_call(gym.update, slug, body)

    @app.delete("/api/gym/{slug}")
    def gym_release(slug: str):
        gym_call(gym.release, slug)
        return {"ok": True}

    @app.post("/api/gym/{slug}/feed")
    async def gym_feed(slug: str, request: Request, name: str = "track.wav", path: str = ""):
        if path:                                        # feed something already in the library
            return gym_call(gym.feed, slug, _inside_outputs(path), Path(path).name)
        tmp = UPLOADS_DIR / f"feed_{uuid.uuid4().hex[:8]}{Path(name).suffix[:8]}"
        tmp.write_bytes(await request.body())
        try:
            return gym_call(gym.feed, slug, tmp, name)
        finally:
            tmp.unlink(missing_ok=True)

    @app.post("/api/pick_folder")
    def pick_folder():
        """Native macOS folder chooser. Returns {"path": null} if cancelled."""
        r = subprocess.run(["osascript", "-e", 'POSIX path of (choose folder with prompt "Choose a folder of audio to feed")'],
                           capture_output=True, text=True)
        return {"path": r.stdout.strip() or None}

    @app.post("/api/gym_scan")
    def gym_scan(body: dict):
        return gym_call(gym.scan, str(body.get("path", "")))

    @app.post("/api/gym/{slug}/feed_links")
    def gym_feed_links(slug: str, body: dict):
        return gym_call(gym.feed_links, slug, [str(p) for p in (body.get("paths") or [])][:50])

    @app.get("/api/gym/{slug}/food/{name}")
    def gym_food_file(slug: str, name: str):
        f = gym_call(gym._dir, slug) / "food" / Path(name).name
        if not f.exists():
            raise HTTPException(404, "that track is gone (was the original moved?)")
        return FileResponse(f.resolve())

    @app.get("/api/gym/{slug}/grain/{name}")
    def gym_grain_file(slug: str, name: str):
        return FileResponse(gym_call(gym.grain, slug, name), media_type="audio/wav")

    @app.post("/api/gym/{slug}/capture")
    async def gym_capture(slug: str, request: Request):
        data = await request.body()
        if not data.startswith(b"\x89PNG") or len(data) > 150_000_000:
            raise HTTPException(400, "not a PNG")
        d = OUTPUTS_DIR / "captures"
        d.mkdir(parents=True, exist_ok=True)
        f = d / f"{gym.slugify(slug)}-{time.strftime('%Y%m%d-%H%M%S')}.png"
        f.write_bytes(data)
        if request.query_params.get("quiet") != "1":
            subprocess.run(["open", "-R", str(f)])
        return {"path": str(f), "name": f.name}

    @app.post("/api/gym/{slug}/film")
    async def gym_film(slug: str, request: Request):
        data = await request.body()
        is_mp4, is_webm = data[4:8] == b"ftyp", data[:4] == b"\x1a\x45\xdf\xa3"
        if not (is_mp4 or is_webm) or len(data) > 2_000_000_000:
            raise HTTPException(400, "not a video")
        d = OUTPUTS_DIR / "recordings"
        d.mkdir(parents=True, exist_ok=True)
        stem = f"{gym.slugify(slug)}-film-{time.strftime('%Y%m%d-%H%M%S')}"
        raw = d / (stem + (".raw.mp4" if is_mp4 else ".raw.webm"))
        raw.write_bytes(data)
        out = d / (stem + ".mp4")
        # the browser's own recording is tidied into a normal MP4: H.264 picture, AAC sound, playable everywhere
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                            "-crf", "17", "-preset", "fast", "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", str(out)], capture_output=True, text=True)
        if r.returncode or not out.exists():
            out = raw                                   # keep what the browser made rather than lose the take
        else:
            raw.unlink(missing_ok=True)
        secs = _probe(out)
        subprocess.run(["open", "-R", str(out)])
        return {"path": str(out), "name": out.name, "seconds": secs}

    @app.post("/api/gym/{slug}/tape")
    async def gym_tape(slug: str, request: Request):
        data = await request.body()
        if not (data[:4] == b"RIFF" and data[8:12] == b"WAVE") or len(data) > 400_000_000:
            raise HTTPException(400, "not a WAV")
        d = OUTPUTS_DIR / "recordings"
        d.mkdir(parents=True, exist_ok=True)
        f = d / f"{gym.slugify(slug)}-sound-{time.strftime('%Y%m%d-%H%M%S')}.wav"
        f.write_bytes(data)
        subprocess.run(["open", "-R", str(f)])
        rate = int.from_bytes(data[28:32], "little") or 1
        return {"path": str(f), "name": f.name, "seconds": round((len(data) - 44) / rate, 1)}

    def _probe(f: Path) -> float:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(f)], capture_output=True, text=True)
        try:
            return round(float(r.stdout.strip()), 1)
        except ValueError:
            return 0.0

    def _rec_dir(slug: str, rid: str) -> Path:
        if not re.fullmatch(r"\d{8}-\d{6}", rid):
            raise HTTPException(400, "bad recording id")
        return OUTPUTS_DIR / "recordings" / f"{gym.slugify(slug)}-{rid}"

    @app.post("/api/gym/{slug}/rec/start")
    def gym_rec_start(slug: str):
        rid = time.strftime("%Y%m%d-%H%M%S")
        _rec_dir(slug, rid).mkdir(parents=True, exist_ok=True)
        return {"id": rid}

    @app.post("/api/gym/{slug}/rec/{rid}/frame/{i}")
    async def gym_rec_frame(slug: str, rid: str, i: int, request: Request):
        d = _rec_dir(slug, rid)
        data = await request.body()
        if not d.is_dir() or not data.startswith(b"\xff\xd8") or len(data) > 20_000_000:
            raise HTTPException(400, "not a frame")
        (d / f"f_{i:06d}.jpg").write_bytes(data)
        return {"ok": True}

    def lapse_sound(slug: str, video: Path, e0: float, e1: float, job: dict):
        """Give a time-lapse its sound: the creature's voice growing up, and what it could really make at each stage it passed."""
        say = lambda m, f=None: job.update(msg=m, frac=f)
        c, cdir = gym.get(slug), gym._dir(slug)
        st = cdir / "stages"
        st.mkdir(exist_ok=True)
        pr = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)], capture_output=True, text=True)
        dur = float((pr.stdout or "0").strip() or 0)
        if dur < 1:
            raise RuntimeError("that video is too short to score")
        say("gathering its memories…", .05)
        limbs = []
        for l in c.get("limbs") or [{"id": 0, "count": len(c["food"]), "mean": {}}]:
            fs = sorted([f for f in c["food"] if (f.get("limb") or 0) == l["id"]] or c["food"], key=lambda f: f.get("core") or 0)[:3]
            tracks = []
            for f in fs:
                try:
                    tracks.append(str(gym.grain(slug, f["name"])))
                except Exception:
                    pass
            if tracks:
                limbs.append({"share": l["count"] / max(1, len(c["food"])), "low": (l.get("mean") or {}).get("low", .3), "tracks": tracks})
        clips, song, tail = [], None, 0.0
        e = engines.get("ace_step")
        busy_here = gym._train.get("state") in ("running", "stopping") and not gym._train.get("remote")   # while it trains on this Mac the GPU is taken
        if e and not busy_here:
            main = max(c.get("limbs") or [{}], key=lambda l: l.get("count", 0))
            caption = ", ".join(x for x in [c.get("style") or "", *((main.get("tags") or []) if not c.get("style") else []), "instrumental"] if x)
            bpm = (main.get("mean") or {}).get("bpm")

            def gen(at: Path, secs: float, out: Path, seed: int, label: str):
                params = _coerce(e.spec, {"task": "text2music", "caption": caption, "lyrics": "[Instrumental]", "duration": secs, "thinking": False, "batch": 1,
                                          "seed": seed, "creature": slug, "creature_strength": 1, **({"bpm": int(min(200, max(50, bpm)))} if bpm else {})})
                params["creature_at"] = str(at)
                run_dir = st / "_run"
                shutil.rmtree(run_dir, ignore_errors=True)
                run_dir.mkdir(parents=True)
                outs = []
                for ev in e.run(params, run_dir):
                    if ev[0] == "progress":
                        job.update(msg=f"{label}: {ev[1]}")
                    else:
                        outs = ev[1]
                if outs:
                    shutil.move(outs[0]["path"], out)
                shutil.rmtree(run_dir, ignore_errors=True)

            try:
                stages = gym.stage_dirs(slug)
                inside = sorted(ep for ep in stages if e0 < ep <= e1 + .5)
                have = sorted(int(p.stem.split("_")[1]) for p in st.glob("epoch_*.wav") if e0 < int(p.stem.split("_")[1]) <= e1 + .5)
                pick = inside if len(inside) <= 7 else sorted({inside[round(i * (len(inside) - 1) / 6)] for i in range(7)})
                for k, ep in enumerate(pick):
                    wav = st / f"epoch_{ep}.wav"
                    if not wav.exists():
                        say(f"hearing it as it was at epoch {ep}…", .1 + .5 * k / max(1, len(pick)))
                        gen(stages[ep], 6, wav, 4242, f"epoch {ep}")
                    if stages[ep].parent == st and wav.exists():
                        shutil.rmtree(stages[ep], ignore_errors=True)        # its sound is kept; the snapshot itself is no longer needed
                clips = [{"epoch": ep, "path": str(st / f"epoch_{ep}.wav")} for ep in sorted(set(pick) | set(have)) if (st / f"epoch_{ep}.wav").exists()]
            except Exception as ex:
                job["info"]["note"] = f"made without generated clips: {str(ex)[:160]}"
        say("composing the soundtrack…", .8)
        py = gym.ENVS_DIR / "ace_step" / "bin" / "python"
        wav = video.with_suffix(".soundtrack.wav")
        spec = video.with_suffix(".soundtrack.json")
        spec.write_text(json.dumps({"out": str(wav), "dur": dur, "tail": tail or 1.5, "e0": e0, "e1": e1, "history": c.get("history", []), "limbs": limbs, "clips": clips, "song": song,
                                    "seed": abs(hash(video.name)) % 100000}), encoding="utf-8")
        r = subprocess.run([str(py), str(Path(__file__).with_name("soundtrack_synth.py")), str(spec)], capture_output=True, text=True)
        spec.unlink(missing_ok=True)
        if r.returncode or not wav.exists():
            raise RuntimeError("could not make the soundtrack: " + (r.stderr or "").strip()[-200:])
        say("joining sound and picture…", .9)
        out = video.with_name(video.stem + "-sound.mp4")
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(video), "-i", str(wav), "-filter_complex", f"[0:v]tpad=stop_mode=clone:stop_duration={(tail or 1.5):.2f}[v]",
                            "-map", "[v]", "-map", "1:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", str(out)],
                           capture_output=True, text=True)
        wav.unlink(missing_ok=True)
        if r.returncode or not out.exists():
            raise RuntimeError("ffmpeg could not join them: " + (r.stderr or "").strip()[-200:])
        return out, {"stages": [x["epoch"] for x in clips], "song": bool(song)}

    def lapse_sound_job(slug: str, video: Path, e0: float, e1: float) -> dict:
        job = {"id": uuid.uuid4().hex[:12], "engine": "timelapse", "state": "running", "msg": "starting", "frac": 0, "outputs": [], "info": {}, "error": None, "seed": None, "cancel": False}
        jobs[job["id"]] = job

        def work():
            try:
                out, info = lapse_sound(slug, video, e0, e1, job)
                job["info"].update(info)
                job.update(state="done", outputs=[{"path": str(out), "name": out.name, "type": "video"}], msg="sound added", frac=1)
            except Exception as ex:
                job.update(state="error", error=str(ex), msg="failed")

        threading.Thread(target=work, daemon=True).start()
        return job

    @app.post("/api/gym/{slug}/lapse_sound")
    def gym_lapse_sound(slug: str, body: dict):
        """Add sound to a time-lapse that already exists. body: name (a file in outputs/recordings), e0, e1 (the epochs it covers)."""
        video = OUTPUTS_DIR / "recordings" / Path(str(body.get("name", ""))).name
        if not video.is_file() or video.suffix != ".mp4":
            raise HTTPException(404, "no such time-lapse")
        c = gym_call(gym.get, slug)
        job = lapse_sound_job(slug, video, float(body.get("e0", 0)), float(body.get("e1", c.get("epochs", 0))))
        return {"id": job["id"]}

    @app.post("/api/gym/{slug}/rec/{rid}/finish")
    def gym_rec_finish(slug: str, rid: str, body: dict | None = None):
        d = _rec_dir(slug, rid)
        frames = sorted(d.glob("f_*.jpg")) if d.is_dir() else []
        if not frames:
            raise HTTPException(400, "no frames were recorded")
        for k, f in enumerate(frames):                       # close any gaps so ffmpeg sees one unbroken sequence
            f.rename(d / f"g_{k:06d}.jpg")
        out = d.with_suffix(".mp4")
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "30", "-i", str(d / "g_%06d.jpg"), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", "-movflags", "+faststart", str(out)], capture_output=True, text=True)
        if r.returncode or not out.exists():
            raise HTTPException(400, "ffmpeg could not join the frames: " + (r.stderr or "").strip()[-200:])
        shutil.rmtree(d, ignore_errors=True)
        subprocess.run(["open", "-R", str(out)])
        res = {"path": str(out), "name": out.name, "frames": len(frames), "seconds": round(len(frames) / 30, 1)}
        b = body or {}
        if b.get("e1") is not None and len(frames) >= 60:        # give it its sound, in the background
            try:
                res["sound_job"] = lapse_sound_job(slug, out, float(b.get("e0") or 0), float(b["e1"]))["id"]
            except Exception:
                pass
        return res

    @app.delete("/api/gym/{slug}/food/{name}")
    def gym_unfeed(slug: str, name: str):
        return gym_call(gym.unfeed, slug, name)

    @app.post("/api/gym/{slug}/train")
    def gym_train(slug: str, body: dict):
        return gym_call(gym.train, slug, body, before=lambda: "ace_step" in engines and engines["ace_step"].stop())

    @app.get("/api/gym_remote")
    def gym_remote(fresh: int = 0):
        return gym.remote_status(bool(fresh))

    @app.post("/api/gym/{slug}/stop")
    def gym_stop(slug: str):
        gym.stop(slug)
        return {"ok": True}

    # ---- patches (saved wiring) -----------------------------------------
    def patch_file(name: str) -> Path:
        if not re.fullmatch(r"[\w\- ]{1,40}", name):
            raise HTTPException(400, "bad patch name")
        return PATCHES_DIR / f"{name}.json"

    @app.get("/api/patches")
    def patches():
        return sorted(p.stem for p in PATCHES_DIR.glob("*.json") if p.stem != "autosave")

    @app.get("/api/patches/{name}")
    def get_patch(name: str):
        f = patch_file(name)
        return json.loads(f.read_text()) if f.exists() else None

    @app.put("/api/patches/{name}")
    async def put_patch(name: str, request: Request):
        patch_file(name).write_text(json.dumps(await request.json()))
        return {"ok": True}

    @app.delete("/api/patches/{name}")
    def del_patch(name: str):
        patch_file(name).unlink(missing_ok=True)
        return {"ok": True}

    return app, engines


def _free_port(start: int = 7860) -> int:
    for port in range(start, start + 50):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("no free port")


def launch(port: int | None = None, open_browser: bool = False, window: bool = True):
    """Start the app. By default it opens in its own native window."""
    import uvicorn

    app, engines = create_app()
    port = port or _free_port()
    url = f"http://127.0.0.1:{port}"
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    try:
        if not window:
            if open_browser:
                import webbrowser

                threading.Timer(1.0, webbrowser.open, [url]).start()
            print(f"{NAME} is running at {url}")
            server.run()
            return
        threading.Thread(target=server.run, daemon=True).start()
        while not server.started:
            time.sleep(0.05)
        import webview

        webview.settings["ALLOW_DOWNLOADS"] = True
        webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
        webview.create_window(NAME, url, width=1500, height=960, min_size=(1000, 640),
                              background_color="#05050a", text_select=True)
        webview.start()
        server.should_exit = True
    finally:
        gym.shutdown()
        for e in engines.values():
            e.stop()
