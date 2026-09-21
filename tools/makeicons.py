#!/usr/bin/env python3
"""
Draw the app icons the web manifest and iOS need.

    python3 tools/makeicons.py

An installed app needs raster icons at fixed sizes; the map's own glyphs
are SVG and iOS will not take an SVG for its home screen. Rather than
hand-drawing a second version that can drift, this renders the SAME
conifer the map draws for state land (GLYPH.park in app.js) on the
accent-green ground from CONFIG.colors, so the icon and the map cannot
disagree about what the project looks like.

The path is straight segments only, so it converts to a polygon exactly
and needs no SVG library.
"""

import os
from PIL import Image, ImageDraw

# GLYPH.park in app.js, on its 64x64 viewBox, walked out into points.
CONIFER = [(32, 13), (41, 28), (36, 28), (46, 44), (36, 44), (36, 52),
           (28, 52), (28, 44), (16, 44), (26, 28), (21, 28)]

GROUND = "#0f4c3a"      # CONFIG.colors.accent
INK = "#e6e2cf"         # the parchment the map is drawn on
SIZES = {"icon-192.png": 192, "icon-512.png": 512, "apple-touch-icon.png": 180}
OUT = "icons"


def draw(px, rounded=True):
    # 4x supersampling: these are flat shapes with long diagonals, and at
    # 192 px an aliased conifer looks like a mistake rather than a tree.
    s = px * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=GROUND)
    else:
        d.rectangle([0, 0, s - 1, s - 1], fill=GROUND)
    # The glyph sits on 64 units; inset it so it does not touch the edge.
    pad = s * 0.16
    k = (s - pad * 2) / 64.0
    d.polygon([(pad + x * k, pad + y * k) for x, y in CONIFER], fill=INK)
    return img.resize((px, px), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, px in SIZES.items():
        # iOS masks the apple-touch icon itself and draws its own corners;
        # a rounded source under that mask leaves pale corner slivers.
        img = draw(px, rounded=not name.startswith("apple"))
        path = os.path.join(OUT, name)
        img.save(path)
        print(f"  {path}  {px}x{px}  {os.path.getsize(path):,} bytes")


if __name__ == "__main__":
    main()
