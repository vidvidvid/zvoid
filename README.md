# ZVOID

A modular patch canvas for open-source AI music models. Everything runs locally on your Mac.

Drop modules on the void, drag cables between them, and audio flows down the wires:
generate a track, split it into stems, continue the drums with another model, turn the bass into MIDI.

<p align="center"><img src="assets/icon.png" width="160" alt=""></p>

## What it does

| Module | Engine | What it's for |
|---|---|---|
| **ace-step** | [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5) | Full tracks from tags and lyrics, up to 10 min. Restyle your own track (*cover*), redo a section (*repaint*), add an instrument (*lego*), arrange around an idea (*complete*). |
| **musicgen** | [MusicGen](https://huggingface.co/facebook/musicgen-melody) | Text-to-music. *Melody* models follow a tune you give them; other models continue your audio. |
| **stable audio** | [Stable Audio Open](https://huggingface.co/stabilityai/stable-audio-open-1.0) | Loops, drums, one-shots, textures and FX, plus variations of your own audio. |
| **stems** | [Demucs](https://github.com/adefossez/demucs) | Split a track into drums / bass / vocals / other. |
| **audio → midi** | [Basic Pitch](https://github.com/spotify/basic-pitch) | Turn audio into a `.mid` file for your DAW. |
| **sample** | — | Your own audio. Drop files anywhere on the canvas. |

- **Wiring:** drag from an output port to an input port. Running a module runs whatever feeds it first.
- **Every knob:** each module exposes the model's settings, an *advanced* section, and a raw JSON box for anything else.
- **✦ claude:** a chat panel that builds, tweaks and runs patches for you, through your own [Claude Code](https://claude.com/claude-code) CLI.
- **Library:** every run is saved with its exact settings and seed.
- **Patches:** save and reload your wiring.

## Requirements

- An Apple Silicon Mac (it uses the Apple GPU through PyTorch MPS). 32 GB+ of memory recommended.
- [uv](https://docs.astral.sh/uv/) (`brew install uv`) and `ffmpeg` (`brew install ffmpeg`).
- About 25 GB of free disk for all model weights.
- Optional: the Claude Code CLI, logged in, for the chat panel.

## Install and run

```bash
git clone https://github.com/vidvidvid/zvoid && cd zvoid
./zvoid install        # creates one Python env per engine (a few minutes)
./zvoid                # opens the app in its own window
```

You can also double-click **Zvoid.app** in this folder and drag it to your Dock.

**No model weights are in this repo.** Each engine downloads its weights from Hugging Face the first time
you use it. ACE-Step goes into `models/`; the others go into the shared `~/.cache/huggingface`.

Stable Audio Open is gated: accept the license on its
[model page](https://huggingface.co/stabilityai/stable-audio-open-1.0), then run `./zvoid login`.

## Using it

| Do this | To |
|---|---|
| Double-click the void, or press `space` | Add a module |
| Drag from a port on the right of a module to a port on the left of another | Wire them |
| Select a cable or module and press `⌫` | Remove it |
| `▸` on a module (shift-click to redo everything upstream) | Run it |
| `⌘↵` | Run the whole patch |
| `⌘K` | Open the Claude chat |
| Scroll / pinch, `F` | Pan / zoom, fit everything |
| Drop audio files on the canvas or on a module | Bring in your own music |

## The gym: raise a creature on your own music

Press **◍ gym**. A creature is a LoRA adapter for ACE-Step, trained on audio you feed it.

1. **Hatch** one by giving it a name.
2. **Feed** it (audio or video files; only the sound is used): drop your tracks on the gym screen, press `◍` on any result on the canvas, or use
   **feed a folder** to scan a whole folder and tick the tracks you want (they are linked, not copied).
   10–30 tracks in one style is a good start. Describe its sound in tags, since good captions matter a lot.
3. **Train** it. Training runs on the Apple GPU with ACE-Step's own trainer, saves a checkpoint every
   10 epochs, and can be stopped and continued any time.
4. **Use** it: pick it as *creature* in any ace-step module and set *creature strength*.

To delete a creature, press the × on its row or *delete creature* in the gym (click twice to confirm). Your original audio is never touched.

**What you see** is the entity: a nebula made of the sound it ate, rendered on the GPU as real 3D dust and gas
(a ray-marched volume, so there are no lines or particles).

- **Pillars:** one per limb. Their size follows how much that limb ate, their colour its brightness. Feeding makes them grow.
- **Dust and light:** the dust is lit by one wandering light with true self-shadowing, so it has dark cores and bright rims.
  Untrained, the entity is soft fog. Training sharpens it into sculpted forms.
- **Stars:** one ignites inside the dust for every 25 finished epochs and lights the cloud around it. Voids are cavities carved out of it.
- **It hears.** Press ▶ on a track in the food list, or play anything on the canvas: the pillars swell with the bass,
  the dust churns with the level, and the rims sparkle with the treble.
- **It builds a frame.** The cloud gains a skeleton that is under construction the whole time it trains, not only when
  an epoch lands. In order: a spine of stacked vertebrae along each limb (the first few epochs), then ribs that form a
  cage around the cloud, each arc closing as it finishes, then cables wound around it, then segmented armour plates over
  its back. Where it is being built it glows white-hot, and the readout says which part is in progress. The frame is
  dark and glossy, its seams glow and carry the sound, and the whole entity is mirrored across a midline (one central
  spine, the other limbs in pairs). The dust thins to a veil as soon as the spine exists, and crystallises into a lattice
  of thin sheets. The voids become faceted cavities, and arcs begin to orbit it, one ring per limb.
- **It grows like a fractal.** Every limb sprouts branches, and branches sprout smaller ones. Each has its own life
  cycle: it builds outward with a glowing tip, holds, then crumbles into dust and regrows elsewhere, so something is
  always being made and unmade. Branching gets deeper with training.
- **It reverberates.** Every pillar emits waves at its limb's tempo. They cross and interfere, so the dust shows moving
  standing patterns. Beats, touches and feeding send shock fronts that echo three times, and it rings on after sound stops.
- **It behaves.** It drifts, breathes unevenly, and leans toward your pointer when it is curious.
- **It answers touch, in its own voice.** A void flinches and answers with a deep tone. A pillar sings the track that lives
  at the height you touched. The haze chimes. Empty space gets a chirp. Each sends a shock front through the dust.
  How it answers also varies, never the same twice running: plain echoes, a gallop of quick repeats, a rising or falling
  run that sweeps a sheet of light through it, a slow shimmer of overtones, a swarm of small bursts, a breath in before a
  strike (the dust implodes, then bursts), or one long still tone while the dust twists.
  **Drag** across it to push through the dust and bow it: a continuous voice whose pitch follows what you pass over.
  Untrained, the voice is noisy, detuned and short. Training makes it purer, richer and longer.

The picture is built up over many frames: each frame looks through a slightly different spot inside every pixel, and the
frames are blended, so edges are smooth and there is no grain. It is shown at your display's full resolution. The renderer
picks the highest internal resolution that holds full frame rate on your machine (shown small in the top right).
The dust has a grain that runs along each limb, like fibre, and faint veins that pulse outward from the base.

- **It is struck from outside.** Rarely, energy reaches it from far outside the frame and lands on a real part of it: a limb's
  tip, a point on its spine, or its core. It is never the same twice running: a jagged bolt that re-strikes and hops between
  parts, a slow thick tendril that hums and carries beads of light inward, a discharge between two of its own parts, a web
  from three sides, a fork, or one bare flicker. Every strike is heard (a crack, then the struck limb rings in its own note)
  and felt (the dust there dissolves, regrows and lights up). They come more often while it trains or hears sound.
- **The space it lives in** is made of slow folded clouds in the creature's own colours, with dark lanes, two depths of stars,
  and a faint web of threads that brightens with sound and training.
- **Touch changes its matter.** A touch sends a front that dissolves the dust as it passes; the dust grows back thicker
  behind it, the veins fire as the front crosses them, and the touched spot stays lit for a moment.

**Watching it train.** A readout above the entity shows the phase (digest, wake, train), the epoch and step, the loss
and its trend, and the time left. The entity shows the rest itself. While it digests, the tracks drift around it as
soft clumps of its own dust and are drawn in to where the spine is being built. While it trains, light rises through the pillars from base
to tip once per epoch, and two broken arcs grow in its orbit: the outer one is the whole session, the inner one the
current epoch. Every training step sends a pulse and every finished epoch a shock front.

**Limbs.** Tracks that sound alike are grouped automatically (k-means on tempo, bass, brightness, dynamics and noise) and
grow together as one limb. Each limb gets a description and its own trigger word, which goes into the training
captions, so a single creature can hold several sub-styles and you can call one by putting its word in a caption.

**Time.** Every track is one training step per epoch, so more or longer tracks mean slower epochs. The gym shows an
estimate before you start, timed on your own Mac after the first epoch. For big collections, set
*train on at most N tracks* and it picks the most typical tracks of every limb. Stopping keeps the last checkpoint,
and a paused creature is already usable.

Creatures live in `creatures/<name>/` (food, checkpoints, the final adapter and `creature.json`).
That folder is not committed, so your music and adapters stay on your machine.

## About the Claude chat

The chat shells out to the `claude` CLI on your machine, using your own login. It sends your message,
the settings of the modules on the canvas, and the list of engines. **Audio is never sent.** Everything else in
Zvoid works offline once the models are downloaded. Set `ZVOID_CLAUDE_MODEL` to pick a model.

## Commands

```bash
./zvoid                    # start the app
./zvoid install [engine…]  # install or reinstall engines
./zvoid list               # engines, install status, env size
./zvoid login              # Hugging Face login (for gated models)
./zvoid run --browser      # open in your web browser instead of a window
./zvoid run --headless --port 7861
```

## Where things live

| Folder | What |
|---|---|
| `outputs/` | Everything you generate, one folder per run with a `meta.json` |
| `patches/` | Saved wiring |
| `creatures/` | Gym creatures: the audio you fed them and their trained adapters |
| `engines/<id>/` | One folder per engine: `engine.json` (ports and knobs) and `engine.py` (the code) |
| `.envs/<id>/` | Each engine's own Python environment |
| `src/zvoid/` | The app: a small local server (`server.py`) and the canvas (`web/`) |

## Adding your own engine

1. Create `engines/<id>/engine.json` with `name`, `python`, `requirements`, `outputs` and a `params` list.
   Param types: `text`, `textarea`, `slider`, `int`, `number`, `seed`, `choice`, `bool`, `audio`.
   Every `audio` param becomes an input port. Add `"advanced": true` to tuck a knob away.
2. Create `engines/<id>/engine.py` with `run(params, ctx)`:
   ```python
   from slutil import out, save_audio

   def run(p, ctx):
       ctx.progress("working…")
       path = save_audio(ctx.path("result.wav"), audio, sr)
       return {"outputs": [out(path)], "info": {}}
   ```
3. Run `./zvoid install <id>` and restart. The module appears in the dock, and Claude can use it too.

Engines run in long-lived worker processes, so models stay loaded between runs.

## Licenses

Zvoid's own code is MIT. The models have their own terms, so check before you release music:
MusicGen weights are **non-commercial** (CC-BY-NC 4.0), Stable Audio Open uses the Stability AI Community
License, and ACE-Step, Demucs and Basic Pitch are MIT / Apache 2.0.
