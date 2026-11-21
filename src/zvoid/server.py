"""Local API + the patch-canvas frontend. Binds to 127.0.0.1 only."""

from __future__ import annotations

import json
import random
import re
import socket
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

    @app.delete("/api/gym/{slug}/food/{name}")
    def gym_unfeed(slug: str, name: str):
        return gym_call(gym.unfeed, slug, name)

    @app.post("/api/gym/{slug}/train")
    def gym_train(slug: str, body: dict):
        return gym_call(gym.train, slug, body, before=lambda: "ace_step" in engines and engines["ace_step"].stop())

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
