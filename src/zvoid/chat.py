"""Chat copilot: talks to the locally installed Claude Code CLI and gets back canvas actions.

Nothing here needs an API key: it shells out to `claude -p` (your own login). Only text is sent:
your message, the module settings on the canvas, and the engine catalogue. Audio never leaves the machine.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile

SCHEMA = {
    "type": "object",
    "properties": {
        "say": {"type": "string", "description": "Short reply to the user (1-3 sentences, plain text)."},
        "actions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "op": {"type": "string", "enum": ["add", "set", "connect", "disconnect", "remove", "run", "run_all", "clear"]},
                    "id": {"type": "string", "description": "add: a new short id you choose for the module"},
                    "type": {"type": "string", "description": "add: engine id, or 'sample'"},
                    "node": {"type": "string", "description": "set/remove/run: module id"},
                    "params": {"type": "object", "description": "add/set: parameter values by name"},
                    "from": {"type": "string"}, "from_port": {"type": "string"},
                    "to": {"type": "string"}, "to_port": {"type": "string"},
                },
                "required": ["op"],
            },
        },
    },
    "required": ["say", "actions"],
}

RULES = """You are the copilot inside {name}, a local modular patch canvas for AI music models.
The user wires modules together with cables; audio flows left to right. You control the canvas by returning actions.

ACTIONS (applied in order):
- add: {{op, id, type, params}}  create a module. `type` is an engine id below or "sample" (the user's own audio; you cannot fill it, ask them to drop a file on it).
- set: {{op, node, params}}  change settings of an existing module.
- connect: {{op, from, from_port, to, to_port}}  cable from an output port to an audio input port (replaces what was wired there).
- disconnect: {{op, to, to_port}}
- remove: {{op, node}}
- run: {{op, node}}  run one module (anything upstream without a result runs first).
- run_all: {{op}}  re-run the whole patch.
- clear: {{op}}  remove everything.

RULES
- Only use engine ids, parameter names, choices and ports listed below. Stay inside min/max.
- Input ports are the params of type "audio". Output ports are listed per engine; a sample's output port is "out".
- Prefer changing existing modules over adding duplicates. Refer to existing modules by their id.
- If the user asks for sound ("make me...", "generate..."), build or adjust the patch AND run it.
- You cannot hear audio. Say so if asked to judge a result; reason from settings and run info instead.
- Write prompts/captions the way each model likes them: comma-separated tags with genre, bpm, instruments, mood.
- Keep `say` short and concrete: what you did and what to try next. If the request is unclear, ask in `say` and return no actions.
- An engine marked installed=false cannot run; tell the user to install it from "engines".

ENGINES
{engines}
"""


def _catalogue(engines) -> str:
    out = []
    for e in engines.values():
        s = e.spec
        params = []
        for p in s.get("params", []):
            d = {"name": p["name"], "type": p.get("type", "text")}
            for k in ("default", "choices", "min", "max", "help"):
                if p.get(k) not in (None, ""):
                    d[k] = p[k]
            if p.get("type") == "creature":
                from . import gym
                d["choices"] = [""] + gym.trained_slugs()
                d["help"] = "A creature (adapter trained on the user's own music in the gym). Empty = none."
            if p.get("custom"):
                d["any_value_allowed"] = True
            params.append(d)
        out.append(json.dumps({"id": e.id, "name": s.get("name"), "what": s.get("tagline"), "installed": e.installed,
                               "outputs": s.get("outputs", ["out"]), "params": params}, ensure_ascii=False))
    return "\n".join(out)


def available() -> bool:
    return shutil.which("claude") is not None


def ask(engines, name: str, message: str, patch: dict, session: str | None) -> dict:
    exe = shutil.which("claude")
    if not exe:
        raise RuntimeError("The Claude Code CLI isn't installed. Get it from https://claude.com/claude-code, run `claude` once to log in, then try again.")
    prompt = f"CANVAS NOW\n{json.dumps(patch, ensure_ascii=False)}\n\nUSER\n{message}"
    cmd = [exe, "-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--disable-slash-commands",
           "--setting-sources", "", "--system-prompt", RULES.format(name=name, engines=_catalogue(engines)),
           "--json-schema", json.dumps(SCHEMA)]
    if os.environ.get("ZVOID_CLAUDE_MODEL"):
        cmd += ["--model", os.environ["ZVOID_CLAUDE_MODEL"]]
    if session:
        cmd += ["--resume", session]
    # run from an empty folder so the CLI doesn't pick up any project context
    cwd = os.path.join(tempfile.gettempdir(), "zvoid-chat")
    os.makedirs(cwd, exist_ok=True)
    try:
        r = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=180, cwd=cwd)
    except subprocess.TimeoutExpired:
        raise RuntimeError("Claude took too long to answer. Try again.")
    try:
        data = json.loads(r.stdout)
    except ValueError:
        raise RuntimeError((r.stderr or r.stdout or "Claude CLI returned nothing").strip()[-600:])
    if data.get("is_error"):
        raise RuntimeError(str(data.get("result") or "Claude CLI error")[:600])
    out = data.get("structured_output")
    if not isinstance(out, dict):
        try:
            out = json.loads(data.get("result") or "")
        except ValueError:
            out = {"say": str(data.get("result") or ""), "actions": []}
    return {"say": out.get("say", ""), "actions": out.get("actions") or [], "session": data.get("session_id")}
