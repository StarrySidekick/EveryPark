#!/usr/bin/env python3
"""
A static server that honours Range requests, for the checks in this folder.

    python3 tools/isotest/serve.py 8125 &

Python's own http.server does not implement Range. PMTiles is nothing but
range requests — the whole archive is one file the browser reads pieces
of — so under a plain SimpleHTTPRequestHandler the map draws no
boundaries and no roads, and protomaps reports "storage backend does not
support HTTP Byte Serving" rather than anything about the data. GitHub
Pages does support ranges, so this only ever bites locally.
"""
import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class RangeHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        rng = self.headers.get("Range")
        if not rng:
            return super().send_head()
        path = self.translate_path(self.path)
        if os.path.isdir(path) or not os.path.exists(path):
            return super().send_head()
        m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
        if not m:
            return super().send_head()
        size = os.path.getsize(path)
        start, end = m.group(1), m.group(2)
        if start == "":                       # bytes=-N, the last N bytes
            length = min(int(end or 0), size)
            start = size - length
            end = size - 1
        else:
            start = int(start)
            end = int(end) if end else size - 1
            end = min(end, size - 1)
        if start > end or start >= size:
            self.send_error(416, "Requested range not satisfiable")
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        return _Slice(f, end - start + 1)

    def log_message(self, *a):
        pass


class _Slice:
    """Only hands over the requested bytes, then reports EOF."""

    def __init__(self, fh, length):
        self.fh, self.left = fh, length

    def read(self, n=-1):
        if self.left <= 0:
            return b""
        if n is None or n < 0:
            n = self.left
        data = self.fh.read(min(n, self.left))
        self.left -= len(data)
        return data

    def close(self):
        self.fh.close()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8125
    ThreadingHTTPServer(("127.0.0.1", port), RangeHandler).serve_forever()
