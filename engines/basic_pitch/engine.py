"""Basic Pitch: polyphonic audio-to-MIDI."""

import os

from slutil import out, save_audio

_model = {}


def run(p, ctx):
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import Model, predict

    if not p.get("audio"):
        raise ValueError("Add some audio to transcribe first.")
    if "m" not in _model:
        ctx.progress("Loading Basic Pitch…")
        _model["m"] = Model(ICASSP_2022_MODEL_PATH)
    ctx.progress("Transcribing…")
    _, midi, notes = predict(
        p["audio"], _model["m"],
        onset_threshold=float(p.get("onset_threshold", 0.5)),
        frame_threshold=float(p.get("frame_threshold", 0.3)),
        minimum_note_length=float(p.get("min_note_ms", 128)),
        minimum_frequency=float(p["min_freq"]) if p.get("min_freq") else None,
        maximum_frequency=float(p["max_freq"]) if p.get("max_freq") else None,
        multiple_pitch_bends=bool(p.get("pitch_bends")),
        melodia_trick=bool(p.get("melodia_trick", True)),
        midi_tempo=float(p.get("tempo") or 120),
        **(p.get("extra") or {}),
    )
    base = os.path.splitext(os.path.basename(p["audio"]))[0][:40]
    mid = ctx.path(f"{base}.mid")
    midi.write(mid)
    outputs = [out(mid, "MIDI", kind="midi")]
    if p.get("preview", True) and notes:
        ctx.progress("Rendering preview…")
        sr = 22050
        outputs.insert(0, out(save_audio(ctx.path(f"{base}_midi_preview.wav"), midi.synthesize(fs=sr), sr, normalize=True),
                              "MIDI preview (sine)"))
    if not notes:
        ctx.progress("No notes found. Try lowering the thresholds.")
    pitches = [int(n[2]) for n in notes]
    return {"outputs": outputs, "info": {
        "notes": len(notes),
        "pitch_range": [min(pitches), max(pitches)] if pitches else None,
        "midi_length_s": round(midi.get_end_time(), 2)}}
