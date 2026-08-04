#!/usr/bin/env bash
# Build /tmp/eptest: a copy of the site that runs with NO network.
#
# The sandbox can't reach unpkg, so index.html's CDN <script> tags are
# rewritten to vendored copies. Hand-copying files into the scratch dir
# silently undoes that rewrite and the next test run dies with
# "L is not defined" — hence this script. Always rebuild with it.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST=/tmp/eptest
VENDOR="${VENDOR_SRC:-/tmp/epui/vendor}"

rm -rf "$DEST"; mkdir -p "$DEST/vendor"
cp -r "$REPO"/index.html "$REPO"/app.js "$REPO"/config.js "$REPO"/vectorlayers.js \
      "$REPO"/iso.js "$REPO"/styles.css "$REPO"/icons "$REPO"/data "$DEST"/
cp "$VENDOR"/leaflet.js "$VENDOR"/leaflet.css "$VENDOR"/protomaps-leaflet.js "$DEST/vendor/"

python3 - "$DEST/index.html" <<'PY'
import re, sys
p = sys.argv[1]
s = open(p).read()
s = re.sub(r'<link rel="stylesheet" href="https://unpkg\.com/leaflet[^>]*>',
           '<link rel="stylesheet" href="vendor/leaflet.css">', s)
s = re.sub(r'<script src="https://unpkg\.com/leaflet[^>]*></script>',
           '<script src="vendor/leaflet.js"></script>', s, flags=re.S)
s = re.sub(r'<script src="https://unpkg\.com/protomaps-leaflet[^>]*></script>',
           '<script src="vendor/protomaps-leaflet.js"></script>', s)
assert "unpkg.com" not in s, "a CDN reference survived the rewrite"
open(p, "w").write(s)
PY
echo "scratch site built at $DEST"
