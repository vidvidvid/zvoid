"""The Gradio UI. Engine tabs are generated from each engine.json, so adding an engine = adding a folder."""

from __future__ import annotations

import json
import random
import shutil
import time
from pathlib import Path

import gradio as gr

from . import library
from .engines import Engine, discover, env_size
from . import look
from .paths import OUTPUTS_DIR, ROOT

MAX_AUDIO_SLOTS = 4

CSS = """
.sl-small-btn {min-width: 0 !important;}
.sl-status {min-height: 2.5em;}
footer {display: none !important;}
"""


# ---------------------------------------------------------------- components from spec
def _component(p: dict):
    t = p.get("type", "text")
    label = p.get("label", p["name"].replace("_", " ").capitalize())
    info = p.get("help")
    d = p.get("default")
    if t == "text":
        return gr.Textbox(label=label, value=d or "", info=info, lines=1)
    if t == "textarea":
        return gr.Textbox(label=label, value=d or "", info=info, lines=p.get("lines", 3))
    if t == "slider":
        return gr.Slider(p["min"], p["max"], value=d, step=p.get("step", 1), label=label, info=info)
    if t in ("number", "int"):
        return gr.Number(value=d, label=label, info=info, precision=0 if t == "int" else None)
    if t == "seed":
        return gr.Number(value=-1 if d is None else d, label=label or "Seed", info=info or "-1 = random", precision=0)
    if t == "choice":
        return gr.Dropdown(p["choices"], value=d, label=label, info=info, allow_custom_value=p.get("custom", False))
    if t == "bool":
        return gr.Checkbox(value=bool(d), label=label, info=info)
    if t == "audio":
        return gr.Audio(label=label, type="filepath", sources=["upload", "microphone"])
    if t == "file":
        return gr.File(label=label, type="filepath", file_types=p.get("file_types"))
    raise ValueError(f"Unknown param type {t!r} in {p['name']}")


def _audio_input(p: dict):
    """An audio input plus quick ways to feed it from previous results."""
    with gr.Group():
        comp = _component(p)
        if p.get("help"):
            gr.Markdown(f"<small>{p['help']}</small>")
        with gr.Row():
            latest = gr.Button("↺ Latest result", size="sm", elem_classes="sl-small-btn")
            pick = gr.Dropdown([], label="…or pick from library", scale=3, container=False)
    latest.click(lambda: library.latest_audio(), outputs=comp)
    pick.focus(lambda: gr.Dropdown(choices=library.all_audio()), outputs=pick)
    pick.change(lambda f: f or None, inputs=pick, outputs=comp)
    return comp


# ---------------------------------------------------------------- engine tab
def engine_tab(engine: Engine):
    spec = engine.spec
    params = spec.get("params", [])
    names, comps = [], []

    gr.Markdown(f"### {engine.name}\n{spec.get('tagline', '')}", elem_classes="sl-intro")
    status_md = gr.Markdown(_install_hint(engine))

    with gr.Row(equal_height=False):
        with gr.Column(scale=5):
            basic = [p for p in params if not p.get("advanced")]
            adv = [p for p in params if p.get("advanced")]
            for p in basic:
                names.append(p["name"])
                comps.append(_audio_input(p) if p.get("type") == "audio" else _component(p))
            with gr.Accordion("Advanced", open=False):
                for p in adv:
                    names.append(p["name"])
                    comps.append(_audio_input(p) if p.get("type") == "audio" else _component(p))
                runs = gr.Slider(1, 16, value=1, step=1, label="Runs", info="Generate this many times. Seed goes up by 1 each run.")
                extra = gr.Code(
                    value="{}",
                    language="json",
                    label="Extra kwargs (JSON)",
                    lines=3,
                )
                gr.Markdown("<small>Passed straight to the model call. Use it for any setting not shown above.</small>")
            with gr.Row():
                go = gr.Button(spec.get("action", "Generate"), variant="primary", scale=3)
                stop = gr.Button("Stop", variant="stop", scale=1)
                unload = gr.Button("Unload model", scale=1)
                finder = gr.Button("Show in Finder", scale=1)
            if spec.get("notes"):
                with gr.Accordion("Tips", open=False):
                    gr.Markdown(spec["notes"])

        with gr.Column(scale=5):
            status = gr.Markdown("ready_", elem_classes="sl-status")
            slots = [gr.Audio(label=f"Result {i + 1}", type="filepath", visible=(i == 0), interactive=False)
                     for i in range(MAX_AUDIO_SLOTS)]
            files = gr.File(label="All files from this run (audio, MIDI, stems…)", file_count="multiple", interactive=False)
            info = gr.JSON(label="Run info")

    def generate(n_runs, extra_json, *values):
        try:
            extra_kwargs = json.loads(extra_json or "{}")
            if not isinstance(extra_kwargs, dict):
                raise ValueError
        except ValueError:
            yield _err("Extra kwargs must be a JSON object, like {\"top_k\": 250}"), *[gr.update()] * (MAX_AUDIO_SLOTS + 2)
            return
        base = dict(zip(names, values))
        for p in params:  # make ints ints
            if p.get("type") in ("int", "seed") and base.get(p["name"]) is not None:
                base[p["name"]] = int(base[p["name"]])
        base_seed = base.get("seed")
        all_audio, all_files, infos = [], [], []
        lp = spec.get("label_param", "prompt")
        lv = base.get(lp)
        is_file = any(q["name"] == lp and q.get("type") in ("audio", "file") for q in params)
        label = (Path(str(lv)).stem if lv else "") if is_file else str(lv or "")
        for i in range(int(n_runs)):
            p = dict(base, extra=extra_kwargs)
            if "seed" in p:
                p["seed"] = (random.randint(0, 2**31 - 1) if (base_seed is None or base_seed < 0) else base_seed + i)
            run_dir = library.new_run_dir(engine.id, label)
            _keep_inputs(params, p, run_dir)
            t0 = time.time()
            head = f"**Run {i + 1}/{int(n_runs)}**" if n_runs > 1 else ""
            yield f"{head} Starting {engine.name}… (first run loads the model, which can take a while)", *_slots(all_audio), gr.update(), gr.update()
            try:
                for ev in engine.run(p, run_dir):
                    if ev[0] == "progress":
                        frac = f" — {ev[2] * 100:.0f}%" if ev[2] is not None else ""
                        yield f"{head} {ev[1]}{frac}", *_slots(all_audio), gr.update(), gr.update()
                    else:
                        outputs, run_info = ev[1], ev[2]
            except Exception as e:
                shutil.rmtree(run_dir, ignore_errors=True) if not any(run_dir.iterdir()) else None
                yield _err(str(e)), *_slots(all_audio), all_files or None, infos or None
                return
            secs = round(time.time() - t0, 1)
            library.write_meta(run_dir, {
                "engine": engine.id, "engine_name": engine.name, "created": time.strftime("%Y-%m-%d %H:%M:%S"),
                "label": label, "params": p, "outputs": outputs, "info": run_info, "seconds": secs,
            })
            for o in outputs:
                all_files.append(o["path"])
                if o.get("kind", "audio") == "audio":
                    all_audio.append(o)
            infos.append({"run": i + 1, "seconds": secs, "seed": p.get("seed"), "folder": str(run_dir), **run_info})
            yield f"{head} Done in {secs}s ✔", *_slots(all_audio), all_files, infos if len(infos) > 1 else infos[0]
        if n_runs > 1:
            yield f"All {int(n_runs)} runs done ✔", *_slots(all_audio), all_files, infos

    ev = go.click(generate, inputs=[runs, extra, *comps], outputs=[status, *slots, files, info])
    stop.click(lambda: (engine.stop(), "Stopped. The model was unloaded.")[1], outputs=status, cancels=[ev])
    unload.click(lambda: (engine.stop(), "Model unloaded, memory freed.")[1], outputs=status)
    finder.click(lambda: _reveal(library.latest_run_dir(engine.id)), outputs=status)
    return status_md


def _keep_inputs(params, p, run_dir):
    """Copy uploaded inputs into the run folder so the library can replay them after Gradio's temp files vanish."""
    for q in params:
        src = p.get(q["name"])
        if q.get("type") not in ("audio", "file") or not src:
            continue
        src = Path(src)
        if OUTPUTS_DIR in src.resolve().parents:
            continue  # already one of our outputs
        dst = run_dir / "inputs" / src.name
        if dst.exists():
            dst = dst.with_name(f"{q['name']}_{src.name}")
        dst.parent.mkdir(exist_ok=True)
        shutil.copy2(src, dst)
        p[q["name"]] = str(dst)


def _slots(audio_outputs):
    shown = audio_outputs[-MAX_AUDIO_SLOTS:]
    ups = []
    for i in range(MAX_AUDIO_SLOTS):
        if i < len(shown):
            ups.append(gr.update(value=shown[i]["path"], label=shown[i].get("label") or f"Result {i + 1}", visible=True))
        else:
            ups.append(gr.update(visible=(i == 0 and not shown)))
    return ups


def _reveal(path):
    """Open Finder at a run folder (or the outputs folder)."""
    import subprocess

    target = Path(path) if path else OUTPUTS_DIR
    subprocess.run(["open", str(target)])
    return f"Opened `{target.relative_to(ROOT) if ROOT in target.parents else target}` in Finder."


def _err(msg):
    first, _, rest = msg.partition("\n")
    out = f"❌ **{first}**"
    if rest.strip():
        out += f"\n<details><summary>Details</summary>\n\n```\n{rest.strip()[-4000:]}\n```\n</details>"
    return out


def _install_hint(engine: Engine):
    if engine.installed:
        return ""
    return (f"⚠️ **Not installed yet.** Go to the **Engines** tab and install *{engine.name}* "
            f"(or run `./soundlab install {engine.id}`).")


# ---------------------------------------------------------------- engines tab
def engines_tab(engines: dict[str, Engine], hints: dict):
    gr.Markdown("### Engines\nEach engine gets its own Python environment, so their libraries never clash. "
                "Installing sets up the code. Model weights download the first time you use a model "
                "(into `~/.cache/huggingface`, shared between engines).", elem_classes="sl-intro")
    table = gr.Dataframe(headers=["Engine", "Status", "Env size", "Model download", "License"],
                         value=lambda: _engine_rows(engines), interactive=False, wrap=True)
    with gr.Row():
        pick = gr.Dropdown([(e.name, e.id) for e in engines.values()], label="Engine", value=next(iter(engines)))
        install = gr.Button("Install / reinstall", variant="primary")
        unload = gr.Button("Unload model")
        remove = gr.Button("Remove env", variant="stop")
    log = gr.Textbox(label="Log", lines=14, max_lines=14, autoscroll=True)

    def do_install(eid):
        lines = []
        e = engines[eid]

        def add(line):
            lines.append(line)

        import threading
        err = []
        t = threading.Thread(target=lambda: _catch(lambda: e.install(add), err), daemon=True)
        t.start()
        while t.is_alive():
            time.sleep(0.5)
            yield "\n".join(lines[-300:]), gr.update()
        if err:
            lines.append(f"❌ {err[0]}")
        yield "\n".join(lines[-300:]), _engine_rows(engines)

    outs = [log, table]
    install.click(do_install, inputs=pick, outputs=outs).then(
        lambda: [_install_hint(e) for e in engines.values()], outputs=list(hints.values()))
    unload.click(lambda eid: (engines[eid].stop(), f"{engines[eid].name} unloaded.")[1], inputs=pick, outputs=log)
    remove.click(lambda eid: (engines[eid].uninstall(), f"Removed env for {engines[eid].name}.", _engine_rows(engines))[1:],
                 inputs=pick, outputs=outs).then(
        lambda: [_install_hint(e) for e in engines.values()], outputs=list(hints.values()))


def _catch(fn, err):
    try:
        fn()
    except Exception as e:
        err.append(str(e))


def _engine_rows(engines):
    rows = []
    for e in engines.values():
        status = ("🟢 loaded" if e.running else "✅ installed") if e.installed else "— not installed"
        rows.append([e.name, status, env_size(e), e.spec.get("disk", ""), e.spec.get("license", "")])
    return rows


# ---------------------------------------------------------------- library tab
def library_tab():
    gr.Markdown(f"### Library\nEverything you make is saved in `{OUTPUTS_DIR.relative_to(ROOT)}/`, "
                "one folder per run, with a `meta.json` holding the exact settings and seed.", elem_classes="sl-intro")
    with gr.Row():
        refresh = gr.Button("Refresh", size="sm")
        open_out = gr.Button("Open outputs folder", size="sm")
        search = gr.Textbox(placeholder="Filter by prompt, engine, model…", show_label=False, scale=4)
    table = gr.Dataframe(headers=["When", "Engine", "Model", "Prompt / input", "Seed", "Files"],
                         interactive=False, wrap=True, max_height=360)
    state = gr.State([])
    with gr.Row(equal_height=False):
        with gr.Column():
            player = gr.Audio(label="Preview", type="filepath", interactive=False)
            files = gr.File(label="Files", file_count="multiple", interactive=False)
        with gr.Column():
            reveal = gr.Button("Show this run in Finder", size="sm")
            meta = gr.JSON(label="Settings used")

    def load(q):
        runs = library.list_runs()
        if q:
            ql = q.lower()
            runs = [r for r in runs if ql in json.dumps(r).lower()]
        rows = [[r.get("created", ""), r.get("engine_name", r.get("engine")), r.get("params", {}).get("model", ""),
                 (r.get("label") or "")[:80], r.get("params", {}).get("seed", ""), len(library.run_files(r["_dir"]))]
                for r in runs]
        return rows, runs

    def select(runs, evt: gr.SelectData):
        r = runs[evt.index[0]]
        fs = library.run_files(r["_dir"])
        audio = next((f for f in fs if Path(f).suffix.lower() in library.AUDIO_EXT), None)
        return audio, fs, {k: v for k, v in r.items() if k != "_dir"} | {"folder": r["_dir"]}

    refresh.click(load, inputs=search, outputs=[table, state])
    search.submit(load, inputs=search, outputs=[table, state])
    table.select(select, inputs=state, outputs=[player, files, meta])
    open_out.click(lambda: _reveal(None) and None)
    reveal.click(lambda m: _reveal((m or {}).get("folder")) and None, inputs=meta)
    return load, search, table, state


# ---------------------------------------------------------------- app
def build():
    engines = discover()
    order = [e for e in engines.values() if e.spec.get("kind", "generate") == "generate"] + \
            [e for e in engines.values() if e.spec.get("kind", "generate") != "generate"]
    hints = {}
    with gr.Blocks(title="Soundlab") as app:
        gr.HTML(look.header(len(engines)))
        with gr.Tabs():
            for e in order:
                with gr.Tab(e.spec.get("tab", e.name)):
                    hints[e.id] = engine_tab(e)
            with gr.Tab("Library") as lib_tab:
                load, search, table, state = library_tab()
            with gr.Tab("Engines"):
                engines_tab(engines, hints)
        lib_tab.select(load, inputs=search, outputs=[table, state])
        app.load(load, inputs=search, outputs=[table, state])
    app._soundlab_engines = engines
    return app


def launch(port: int | None = None, open_browser: bool = False, window: bool = True):
    """Start the app. By default it opens in its own native window (no browser)."""
    app = build()
    try:
        app.queue(default_concurrency_limit=4).launch(
            server_name="127.0.0.1", server_port=port, inbrowser=open_browser and not window,
            allowed_paths=[str(OUTPUTS_DIR)], theme=look.theme(), css=CSS + look.CSS,
            prevent_thread_lock=window, quiet=window,
        )
        if window:
            import webview

            webview.settings["ALLOW_DOWNLOADS"] = True
            webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
            webview.create_window("Soundlab", app.local_url, width=1440, height=940, min_size=(900, 600),
                                  background_color="#05050a", text_select=True)
            webview.start(private_mode=False, storage_path=str(ROOT / ".webview"))
            app.close()
    finally:
        for e in app._soundlab_engines.values():
            e.stop()
