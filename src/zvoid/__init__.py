"""Zvoid: a local playground for open-source AI music models."""

import argparse


def main():
    ap = argparse.ArgumentParser(prog="zvoid", description="Local AI music lab")
    sub = ap.add_subparsers(dest="cmd")
    run = sub.add_parser("run", help="start the app (default)")
    for p in (ap, run):
        p.add_argument("--port", type=int, default=None, help="default: first free port from 7860")
        p.add_argument("--browser", action="store_true", help="open in your web browser instead of an app window")
        p.add_argument("--headless", action="store_true", help="just run the server (no window, no browser)")
    inst = sub.add_parser("install", help="install engines (all if none given)")
    inst.add_argument("engines", nargs="*")
    sub.add_parser("list", help="list engines and whether they're installed")
    sub.add_parser("login", help="log in to Hugging Face (needed for gated models like Stable Audio Open)")
    args = ap.parse_args()

    if args.cmd == "install":
        from .engines import cli_install

        cli_install(args.engines)
    elif args.cmd == "list":
        from .engines import discover, env_size

        for e in discover().values():
            print(f"{e.id:14} {'installed' if e.installed else '-':10} {env_size(e):>6}  {e.name}")
    elif args.cmd == "login":
        import subprocess

        raise SystemExit(subprocess.call(["uvx", "--from", "huggingface_hub", "hf", "auth", "login"]))
    else:
        from .server import launch

        launch(port=args.port, open_browser=args.browser, window=not (args.browser or args.headless))
