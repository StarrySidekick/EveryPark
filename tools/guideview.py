#!/usr/bin/env python3
"""
Draw a baked guide so a person can check it against the park map.

    python3 tools/guideview.py data/guides/bc69dafa2a.json -o /tmp/sg.png
    python3 tools/guideview.py data/guides/*.json --sheet -o /tmp/all.png

What each mark means:
  thin grey outline   DEEP boundary
  coloured line       DEEP trail, in its blaze colour (dark grey: no blaze)
  dashed magenta      OpenStreetMap only, no DEEP trail beside it
  red halo            not connected to the largest piece of the network
  black star          DEEP access point (ringed red if it reaches no trail)
  small triangle      a trail meeting a public road
  dot                 named feature

The point is the red: a network in pieces looks fine as a list of
numbers, and a router on it will say a loop that is plainly on the
ground does not exist.
"""

import argparse
import json
import math
import sys

from PIL import Image, ImageDraw

PAINT = {"blue": (40, 90, 220), "light blue": (110, 170, 240),
         "white": (235, 235, 235), "red": (215, 40, 40), "yellow": (235, 200, 20),
         "orange": (240, 130, 20), "green": (30, 150, 60), "purple": (130, 50, 170),
         "violet": (150, 80, 200), "pink": (240, 120, 180), "black": (20, 20, 20),
         "brown": (130, 80, 40), "teal": (20, 150, 150), "aqua": (20, 200, 220),
         "grey": (140, 140, 140), "silver": (190, 190, 200), "gold": (210, 170, 40),
         "tan": (200, 170, 120)}


def components(g):
    parent = list(range(len(g["nodes"])))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for e in g["edges"]:
        ra, rb = find(e["a"]), find(e["b"])
        if ra != rb:
            parent[ra] = rb
    size = {}
    for e in g["edges"]:
        r = find(e["a"])
        size[r] = size.get(r, 0) + e["m"]
    main = max(size, key=size.get) if size else None
    return find, main


def render(g, W=900):
    w, s, e, n = g["bbox"]
    kx = math.cos(math.radians((s + n) / 2))
    aspect = (n - s) / ((e - w) * kx)
    H = int(W * aspect)
    if H > 1400:
        W, H = int(W * 1400 / H), 1400
    im = Image.new("RGB", (W, H + 22), (250, 248, 240))
    d = ImageDraw.Draw(im)

    def P(lng, lat):
        return ((lng - w) / (e - w) * W, H - (lat - s) / (n - s) * H)

    for ring in g["boundary"]["rings"]:
        d.line([P(*p) for p in ring], fill=(150, 150, 150), width=2)
    find, main = components(g)
    for ed in g["edges"]:
        pts = [P(*p[:2]) for p in ed["g"]]
        if find(ed["a"]) != main:
            d.line(pts, fill=(255, 150, 150), width=9)
    for ed in g["edges"]:
        t = g["trails"][ed["t"]]
        pts = [P(*p[:2]) for p in ed["g"]]
        if t["src"] == "osm":
            for i in range(0, len(pts) - 1, 2):
                d.line(pts[i:i + 2], fill=(220, 0, 200), width=2)
            continue
        col = PAINT.get((t["colours"] or [None])[0], (70, 70, 70))
        if col == PAINT["white"]:
            d.line(pts, fill=(60, 60, 60), width=5)
        d.line(pts, fill=col, width=3)
    for f in g["features"]:
        x, y = P(f["lng"], f["lat"])
        d.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(0, 120, 120))
    for en in g["entrances"]:
        x, y = P(en["lng"], en["lat"])
        if en["kind"] == "deep":
            r = 9
            pts = []
            for k in range(10):
                a = math.pi / 2 + k * math.pi / 5
                rr = r if k % 2 == 0 else r * 0.45
                pts.append((x + rr * math.cos(a), y - rr * math.sin(a)))
            d.polygon(pts, fill=(0, 0, 0))
            if en["node"] is None:
                d.ellipse([x - 13, y - 13, x + 13, y + 13], outline=(230, 0, 0), width=3)
        else:
            d.polygon([(x, y - 6), (x - 5, y + 4), (x + 5, y + 4)], fill=(20, 20, 20))
    a = g["audit"]["graph"]
    d.text((6, H + 5), f"{g['name']}  {a['km']} km  {a['pieces']} piece(s), "
           f"largest {a['largestPiecePct']}%", fill=(0, 0, 0))
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("guides", nargs="+")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--sheet", action="store_true")
    args = ap.parse_args()
    ims = [render(json.load(open(p)), 520 if args.sheet else 900)
           for p in args.guides if not p.endswith(("audit.json", "index.json"))]
    if not args.sheet:
        ims[0].save(args.out)
        return
    cols = 5
    cw = max(i.width for i in ims)
    rows = [ims[i:i + cols] for i in range(0, len(ims), cols)]
    rh = [max(i.height for i in r) for r in rows]
    sheet = Image.new("RGB", (cw * cols, sum(rh)), (255, 255, 255))
    y = 0
    for r, h in zip(rows, rh):
        for k, im in enumerate(r):
            sheet.paste(im, (k * cw, y))
        y += h
    sheet.save(args.out)


if __name__ == "__main__":
    sys.exit(main())
