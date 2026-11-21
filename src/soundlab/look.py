"""Soundlab's look: near-black void, hairline borders, one acid gradient, mono labels."""

import base64

import gradio as gr

from .paths import ROOT

INK = "#05050a"        # background
PANEL = "#0b0b14"      # surfaces
LINE = "#1d1d2e"       # hairlines
LINE_HI = "#34344d"
TEXT = "#e9e7f5"
MUTED = "#7d7a96"
ACID = "linear-gradient(100deg, #ff2d9b 0%, #a43cff 35%, #2ee6d6 100%)"


def theme():
    t = gr.themes.Base(
        primary_hue=gr.themes.colors.fuchsia,
        secondary_hue=gr.themes.colors.cyan,
        neutral_hue=gr.themes.colors.zinc,
        font=[gr.themes.GoogleFont("Space Grotesk"), "ui-sans-serif", "system-ui", "sans-serif"],
        font_mono=[gr.themes.GoogleFont("JetBrains Mono"), "ui-monospace", "monospace"],
        radius_size=gr.themes.sizes.radius_sm,
        spacing_size=gr.themes.sizes.spacing_md,
    )
    vals = dict(
        body_background_fill=INK, body_text_color=TEXT, body_text_color_subdued=MUTED,
        background_fill_primary=INK, background_fill_secondary=PANEL,
        block_background_fill="transparent", block_border_color=LINE, block_border_width="1px",
        block_shadow="none", block_radius="10px",
        block_label_background_fill="transparent", block_label_text_color=MUTED, block_label_border_width="0px",
        block_title_text_color=MUTED, block_title_background_fill="transparent",
        block_info_text_color="#5f5c78",
        panel_background_fill="transparent", panel_border_color=LINE,
        border_color_primary=LINE, border_color_accent="#a43cff",
        input_background_fill=PANEL, input_background_fill_focus="#10101c", input_border_color=LINE,
        input_border_color_focus="#a43cff", input_shadow="none", input_shadow_focus="0 0 0 1px #a43cff55",
        input_placeholder_color="#4a4862",
        button_primary_background_fill=ACID, button_primary_background_fill_hover=ACID,
        button_primary_text_color="#05050a", button_primary_border_color="transparent",
        button_secondary_background_fill="transparent", button_secondary_background_fill_hover="#13131f",
        button_secondary_text_color=TEXT, button_secondary_border_color=LINE_HI,
        button_cancel_background_fill="transparent", button_cancel_background_fill_hover="#2a0d1c",
        button_cancel_text_color="#ff5c9d", button_cancel_border_color="#4a1530",
        slider_color="#c04dff", checkbox_background_color=PANEL, checkbox_border_color=LINE_HI,
        checkbox_background_color_selected="#a43cff", checkbox_border_color_selected="#a43cff",
        table_even_background_fill=INK, table_odd_background_fill=PANEL, table_border_color=LINE,
        table_row_focus="#16162a", color_accent_soft="#1a1030",
        code_background_fill=PANEL, shadow_drop="none", shadow_drop_lg="0 20px 60px #0008",
        loader_color="#2ee6d6", stat_background_fill=ACID,
    )
    both = {}
    for k, v in vals.items():
        both[k] = v
        both[k + "_dark"] = v
    valid = {k: v for k, v in both.items() if hasattr(t, k)}
    return t.set(**valid)


CSS = """
:root { color-scheme: dark; }
body, .gradio-container { background: #05050a !important; }
.gradio-container { max-width: 1500px !important; padding: 0 28px 40px !important; }
footer { display: none !important; }

/* ambient field behind everything */
body::before {
  content: ""; position: fixed; inset: -20%; z-index: -1; pointer-events: none;
  background:
    radial-gradient(40% 35% at 85% 0%, #a43cff22, transparent 70%),
    radial-gradient(35% 30% at 0% 100%, #2ee6d61a, transparent 70%),
    radial-gradient(30% 25% at 60% 60%, #ff2d9b10, transparent 70%);
  filter: blur(20px); animation: sl-drift 28s ease-in-out infinite alternate;
}
@keyframes sl-drift { to { transform: translate3d(-3%, 2%, 0) rotate(4deg); } }

/* header */
.sl-head { display: flex; align-items: center; gap: 18px; padding: 26px 0 14px; }
.sl-orb { width: 46px; height: 46px; border-radius: 14px; box-shadow: 0 0 40px #a43cff55; animation: sl-pulse 6s ease-in-out infinite; }
@keyframes sl-pulse { 50% { box-shadow: 0 0 60px #2ee6d655; transform: rotate(3deg) scale(1.03); } }
.sl-word { font-family: 'Space Grotesk', sans-serif; font-weight: 500; font-size: 22px; letter-spacing: .55em; color: #e9e7f5; }
.sl-sub { font-family: 'JetBrains Mono', monospace; font-size: 11px; letter-spacing: .12em; color: #5f5c78; text-transform: lowercase; }
.sl-line { height: 1px; background: linear-gradient(90deg, #ff2d9b, #a43cff 30%, #2ee6d6 60%, transparent); opacity: .7; margin-bottom: 8px; }

/* tabs: bare words with a glowing underline */
.tab-wrapper, .tab-container, [role="tablist"] { border: none !important; background: transparent !important; }
[role="tablist"] { gap: 6px; padding: 6px 0 18px; }
[role="tab"], .tab-container button {
  font-family: 'JetBrains Mono', monospace !important; font-size: 12px !important; letter-spacing: .14em;
  text-transform: lowercase; color: #6d6a88 !important; background: transparent !important;
  border: none !important; padding: 8px 12px !important; position: relative;
}
[role="tab"]:hover { color: #e9e7f5 !important; }
[role="tab"][aria-selected="true"], .tab-container button.selected { color: #fff !important; }
[role="tab"][aria-selected="true"]::after, .tab-container button.selected::after {
  content: ""; position: absolute; left: 12px; right: 12px; bottom: 0; height: 2px; border-radius: 2px;
  background: linear-gradient(90deg, #ff2d9b, #a43cff, #2ee6d6); box-shadow: 0 0 12px #a43cff;
}

/* labels: tiny mono caps, no pills */
[data-testid="block-info"], .block-info, label > span:first-child, .label-wrap span, span[data-testid="block-label"] {
  font-family: 'JetBrains Mono', monospace !important; font-size: 10.5px !important; letter-spacing: .16em !important;
  text-transform: uppercase; color: #7d7a96 !important; background: transparent !important; box-shadow: none !important;
}
[data-testid="block-label"] { border: none !important; }
.block { backdrop-filter: blur(6px); transition: border-color .25s; }
.block:hover { border-color: #2a2a40 !important; }
.form, .form > .block { background: transparent !important; border-color: #1d1d2e !important; }

/* engine intro */
.sl-intro h3 { font-weight: 400 !important; font-size: 26px !important; letter-spacing: .02em; margin: 0 0 4px !important;
  background: linear-gradient(90deg, #fff, #b9a8ff 60%, #2ee6d6); -webkit-background-clip: text; color: transparent !important; }
.sl-intro p { color: #8a87a3 !important; max-width: 900px; font-size: 14px; }
.sl-intro strong { color: #e9e7f5; font-weight: 500; }

/* buttons */
button.primary { font-weight: 600 !important; letter-spacing: .12em; text-transform: lowercase;
  box-shadow: 0 0 0 1px #ffffff14, 0 8px 30px -8px #a43cffaa; transition: transform .15s, box-shadow .3s, filter .3s; }
button.primary:hover { filter: brightness(1.12) saturate(1.2); box-shadow: 0 0 0 1px #fff3, 0 10px 40px -6px #2ee6d6aa; transform: translateY(-1px); }
button.secondary, button.stop { letter-spacing: .1em; text-transform: lowercase; font-family: 'JetBrains Mono', monospace !important; font-size: 12px !important; }
.sl-small-btn { min-width: 0 !important; }

/* status line: a pulsing dot and mono text, no box */
.sl-status { min-height: 2.4em; font-family: 'JetBrains Mono', monospace; font-size: 12.5px; color: #b9b5d6;
  border: none !important; border-radius: 0 !important; background: transparent !important; padding: 6px 0 6px 22px !important; position: relative; }
.sl-status::before { content: ""; position: absolute; left: 4px; top: 13px; width: 8px; height: 8px; border-radius: 50%;
  background: #2ee6d6; box-shadow: 0 0 10px #2ee6d6; animation: sl-blink 2.4s ease-in-out infinite; }
@keyframes sl-blink { 50% { opacity: .35; background: #ff2d9b; box-shadow: 0 0 14px #ff2d9b; } }
.sl-status p { margin: 0 !important; }

/* groups and drop zones: hairline, dashed, no glare */
.gr-group, .styler { background: transparent !important; border-color: #1d1d2e !important; }
.block:has(.audio-container), .block:has(.upload-container) { border: 1px dashed #2c2c44 !important; border-radius: 10px !important; }
.block:has(.audio-container):hover { border-color: #a43cff !important; box-shadow: 0 0 30px -10px #a43cff88; }
.upload-container, .audio-container { outline: none !important; }
.upload-container { color: #5f5c78 !important; }

/* inputs */
textarea, input[type="text"], input[type="number"] { font-family: 'Space Grotesk', sans-serif !important; }
input[type="range"] { accent-color: #c04dff; }
.gradio-container { --neutral-200: #23233a; --neutral-300: #2c2c44; --slider-color: #c04dff; }
input[type="range"]::-webkit-slider-thumb { box-shadow: 0 0 12px #c04dff; }
button.secondary { border: 1px solid #23233a !important; }
button.secondary:hover { border-color: #a43cff !important; }
.accordion, details { border-color: #1d1d2e !important; }

/* audio players: let the waveform glow */
.waveform-container, [data-testid="waveform-x"] { filter: drop-shadow(0 0 8px #a43cff66); }

/* scrollbar */
::-webkit-scrollbar { width: 8px; height: 8px; } ::-webkit-scrollbar-thumb { background: #22223a; border-radius: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::selection { background: #a43cff66; }
"""


def header(n_engines: int) -> str:
    icon = ROOT / "assets" / "icon_small.png"
    orb = ""
    if icon.exists():
        orb = f'<img class="sl-orb" src="data:image/png;base64,{base64.b64encode(icon.read_bytes()).decode()}">'
    return (f'<div class="sl-head">{orb}<div><div class="sl-word">SOUNDLAB</div>'
            f'<div class="sl-sub">local · apple gpu · {n_engines} engines · nothing leaves this machine</div></div></div>'
            f'<div class="sl-line"></div>')
