"""Serve only the isolated PoC and prepared assets on loopback (no inference API)."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from app.config import ROOT
from scripts.prepare_webgpu import SITE

UI = ROOT / "webgpu"


class Handler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = unquote(urlsplit(path).path)
        if path == "/":
            return str(UI / "index.html")
        root = UI if path.startswith("/ui/") else SITE
        relative = path[4:] if path.startswith("/ui/") else path.lstrip("/")
        candidate = (root / relative).resolve()
        if not candidate.is_relative_to(root.resolve()):
            return str(root / "__missing__")
        return str(candidate)

    def list_directory(self, path):
        self.send_error(403, "Directory listing disabled")

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def guess_type(self, path):
        return "text/javascript" if Path(path).suffix == ".mjs" else super().guess_type(path)

    def log_message(self, format, *args):
        if len(args) < 2 or str(args[1]) != "200":
            super().log_message(format, *args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8018)
    args = parser.parse_args()
    if not (SITE / "manifest.json").exists():
        parser.error("Run scripts.prepare_webgpu first")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=str(SITE)))
    print(f"WebGPU PoC: http://localhost:{args.port} (Ctrl+C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
