# 🎛️ Soundlab

A local playground for open-source AI music models. Everything runs on your Mac.

Double-click **Soundlab.app** in this folder (drag it to your Dock to keep it handy), or run:

```bash
./soundlab            # opens Soundlab in its own window
```

It's a real Mac window, not a browser tab. `./soundlab run --browser` opens it in your browser instead.
Logs from the app go to `~/Library/Logs/Soundlab.log`. To redraw the icon with a new random pattern, run
`uv run --no-project --with pillow --with numpy python assets/make_icon.py 42` (any number).

## What's inside

| Tab | Engine | What it's for |
|---|---|---|
| **ACE-Step** | ACE-Step 1.5 | Full tracks from tags and lyrics, up to 10 min. Restyle your own track (*cover*), redo a section (*repaint*), add an instrument (*lego*), or arrange around an idea (*complete*). |
| **MusicGen** | Meta MusicGen | Text-to-music. *Melody* models follow a tune you give them; other models **continue** your audio. Extends past 30s in windows. |
| **Stable Audio** | Stable Audio Open 1.0 | Loops, drums, one-shots, textures and FX, plus variations of your own audio with a strength slider. |
| **Stems** | Demucs | Split any track into drums / bass / vocals / other (or 6 stems). |
| **Audio → MIDI** | Basic Pitch | Turn audio into a .mid file for your DAW. |
| **Library** | — | Every run with its exact settings and seed, searchable and playable. |
| **Engines** | — | Install, reinstall, unload or remove each engine. |

## Ways to feed it your music

- Every audio input has **↺ Latest result** and a **pick from library** dropdown, so you can chain steps:
  *split your track → feed the drums into MusicGen continuation → transcribe the bass to MIDI.*
- Drag files straight from Finder onto any audio input, or record from the mic.
- **Runs** generates several takes; a fixed seed plus Runs gives you seed, seed+1, seed+2…
- **Extra kwargs (JSON)** in *Advanced* passes any setting straight to the model, even ones not in the UI.

## Where things live

| Folder | What |
|---|---|
| `outputs/<date>/<time>_<engine>_<prompt>/` | Your results, plus `meta.json` with every setting and `inputs/` with copies of what you fed in |
| `engines/<id>/` | One folder per engine: `engine.json` (the UI) and `engine.py` (the code) |
| `.envs/<id>/` | Each engine's own Python environment (they need clashing library versions) |
| `models/ace_step/` | ACE-Step weights. Other models go in the shared `~/.cache/huggingface` |

## Commands

```bash
./soundlab                 # start the app
./soundlab install         # (re)install all engines
./soundlab install musicgen demucs
./soundlab list            # engines, install status, env size
./soundlab login           # Hugging Face login (needed once for Stable Audio Open)
./soundlab run --browser            # in your web browser instead of a window
./soundlab run --headless --port 7861
```

## Stable Audio Open: one-time setup

The official weights are gated. Accept the license on
<https://huggingface.co/stabilityai/stable-audio-open-1.0>, then run `./soundlab login` and paste a
read token from <https://huggingface.co/settings/tokens>.

## Adding your own engine

1. Make `engines/<id>/engine.json`. Give it `name`, `python`, `requirements` and a `params` list.
   Param types: `text`, `textarea`, `slider`, `int`, `number`, `seed`, `choice`, `bool`, `audio`, `file`.
   Add `"advanced": true` to put one under *Advanced*.
2. Make `engines/<id>/engine.py` with `run(params, ctx)`:
   ```python
   from slutil import out, save_audio
   def run(p, ctx):
       ctx.progress("Working…")
       path = save_audio(ctx.path("result.wav"), audio, sr)
       return {"outputs": [out(path)], "info": {}}
   ```
3. Run `./soundlab install <id>` and restart. The tab appears automatically.

`ctx.torch_device()` gives you `mps` (Apple GPU). Load models once into a module-level cache: the
engine runs in a long-lived worker, so they stay loaded between runs. Press **Unload model** to free memory.

## Licenses

Check before releasing anything: MusicGen weights are **non-commercial** (CC-BY-NC). Stable Audio Open uses
the Stability Community License. ACE-Step, Demucs and Basic Pitch are MIT/Apache.
