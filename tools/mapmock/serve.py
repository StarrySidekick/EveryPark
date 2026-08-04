#!/usr/bin/env python3
"""Static server that honours HTTP Range requests.

Python's stock http.server ignores Range entirely, which silently breaks
PMTiles: the archive is read by byte range, so every tile request gets
the whole 14 MB file back and the reader gives up. GitHub Pages serves
ranges correctly, so this only matters for local previews.
"""
import http.server, os, re, socketserver, sys

ROOT = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else ".")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8124


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def send_head(self):
        rng = self.headers.get("Range")
        if not rng:
            return super().send_head()
        m = re.match(r"bytes=(\d+)-(\d*)", rng.strip())
        path = self.translate_path(self.path)
        if not m or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else size - 1
        end = min(end, size - 1)
        if start > end:
            self.send_error(416, "Requested range not satisfiable")
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        # SimpleHTTPRequestHandler copies to EOF, so hand back only the slice.
        return _Slice(f, end - start + 1)


class _Slice:
    def __init__(self, f, n):
        self.f, self.n = f, n

    def read(self, k=-1):
        if self.n <= 0:
            return b""
        k = self.n if k < 0 else min(k, self.n)
        b = self.f.read(k)
        self.n -= len(b)
        return b

    def close(self):
        self.f.close()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    print(f"serving {ROOT} on :{PORT} (with Range)", flush=True)
    Server(("127.0.0.1", PORT), RangeHandler).serve_forever()
