"""Serve the API with the same bind rules as the packaged entry point.

Unknown arguments are tolerated for compatibility with other shell versions.
Export the chosen bind before importing the app so callbacks and LAN discovery
use the actual address.
"""
import argparse
import os
import sys


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="krobi-backend", add_help=True)
    parser.add_argument("--host", default="0.0.0.0", help="address to bind (default 0.0.0.0)")
    parser.add_argument("--port", type=int, default=8000, help="port to bind (default 8000)")
    parser.add_argument("--data-dir", help="server data root (overrides environment roots)")
    args, _unknown = parser.parse_known_args(argv)
    return args


def main(argv: list[str] | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "reset-password":
        from app.dependencies import reset_account_password
        reset_account_password(argv[1:])
        return
    args = _parse_args(argv)
    from app.infra.paths import set_data_dir
    set_data_dir(args.data_dir)
    os.environ["KROBI_BACKEND_HOST"] = args.host
    os.environ["KROBI_BACKEND_PORT"] = str(args.port)

    import uvicorn

    from app.main import app

    if os.environ.get("KROBI_SUPERVISOR") == "desktop" and sys.stdin is not None:
        from app.infra.desktop_supervisor import watch_desktop

        server = uvicorn.Server(uvicorn.Config(app, host=args.host, port=args.port))
        watch_desktop(server, sys.stdin)
        server.run()
    else:
        uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
