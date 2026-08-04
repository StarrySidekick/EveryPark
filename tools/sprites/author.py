#!/usr/bin/env python3
"""Author the pixel-art sprites for the 3D viewer, and preview them big.

The sprites are INDEXED, exactly like an NES tile: the shape stores a
palette slot per pixel, and the palette is swapped per season. One conifer
shape therefore covers summer, autumn, winter and spring without four
drawings — which is both how the hardware actually worked and the reason
the atlas stays small.

This script is the drawing board. It renders a magnified sheet so the
pixels can be looked at and fixed, then emits the compact string form
that gets pasted into iso.js. Nothing here ships; iso.js builds the real
atlas at runtime so the time-of-day tint can apply to the palette.

    python3 tools/sprites/author.py --preview /tmp/sprites.png --emit
"""
import argparse

# '.' transparent · o outline · a lit · b mid · c shadow · t trunk · u trunk shadow
CONIFER = [
    ".......oo.......",
    "......oaao......",
    "......oaabo.....",
    ".....oaaabo.....",
    ".....oaaabbo....",
    "....oaaaabbo....",
    "...ooaaabbboo...",
    ".....oaaabbo....",
    "....oaaaabbbo...",
    "...oaaaaabbbbo..",
    "..ooaaaabbbbboo.",
    "....oaaaabbbo...",
    "...oaaaaabbbbo..",
    "..oaaaaaabbbbbo.",
    ".ooaaaaabbbbbboo",
    "....oaaaabbbo...",
    "..oaaaaaabbbbbo.",
    ".oaaaaaaabbbbbbo",
    "ooooaaaabbbboooo",
    ".......tu.......",
    ".......tu.......",
    "......ootuoo....",
]

BROADLEAF = [
    ".....oooooo.....",
    "...ooaaaabbboo..",
    "..oaaaaabbbbbbo.",
    ".oaaaaaabbbbbbbo",
    ".oaaaaaabbbbbbbo",
    "oaaaaaaabbbbbbbb",
    "oaaaaaaabbbbbbbb",
    "oaaaaaaabbbbbbbb",
    ".oaaaaaabbbbbbbo",
    ".ooaaaaabbbbbboo",
    "...ooaaabbbboo..",
    ".....oootuoo....",
    "......ottuo.....",
    "......ottuo.....",
    ".....oottuuo....",
]

# A wind-bent one, so a hillside is not a row of clones.
SLIM = [
    "........oo......",
    "......ooaabo....",
    ".....oaaaabbo...",
    ".....oaaaabbo...",
    "....oaaaabbbbo..",
    "....oaaaabbbbo..",
    ".....oaaabbbo...",
    "......oatubo....",
    ".......tu.......",
    ".......tu.......",
    ".......tu.......",
    "......ootuoo....",
]

BUSH = [
    "....oooo....",
    "..ooaabboo..",
    ".oaaaabbbbo.",
    "oaaaaabbbbbo",
    "oaaaaabbbbbo",
    ".oaaabbbbbo.",
    "..ooaaabboo.",
    "....oooo....",
]

TREES = [CONIFER, BROADLEAF, SLIM, BUSH]

# Four frames: contact, pass, contact (mirrored), pass. Small enough that
# the legibility all comes from the leg silhouette.
# p pack · s skin · h hat/hair · c coat · l leg · o outline
HIKER = [[
    "....oooo....",
    "...ohhhho...",
    "..ohhhhhho..",
    "...osssso...",
    "....osso....",
    "..ooccccoo..",
    ".opccccccpo.",
    ".opccccccpo.",
    ".oopccccpoo.",
    "...occcco...",
    "...ollllo...",
    "..oll..llo..",
    "..oll..llo..",
    ".oll....llo.",
    ".oo......oo.",
], [
    "....oooo....",
    "...ohhhho...",
    "..ohhhhhho..",
    "...osssso...",
    "....osso....",
    "..ooccccoo..",
    ".opccccccpo.",
    ".opccccccpo.",
    ".oopccccpoo.",
    "...occcco...",
    "...ollllo...",
    "...ollllo...",
    "...ollllo...",
    "...oll.lo...",
    "...oo..oo...",
], [
    "....oooo....",
    "...ohhhho...",
    "..ohhhhhho..",
    "...osssso...",
    "....osso....",
    "..ooccccoo..",
    ".opccccccpo.",
    ".opccccccpo.",
    ".oopccccpoo.",
    "...occcco...",
    "...ollllo...",
    "...oll.llo..",
    "..oll..llo..",
    "..oll...llo.",
    "..oo.....oo.",
], [
    "....oooo....",
    "...ohhhho...",
    "..ohhhhhho..",
    "...osssso...",
    "....osso....",
    "..ooccccoo..",
    ".opccccccpo.",
    ".opccccccpo.",
    ".oopccccpoo.",
    "...occcco...",
    "...ollllo...",
    "...ollllo...",
    "...ollllo...",
    "...ol.llo...",
    "...oo..oo...",
]]

# Season palettes. Slot 'o' stays near-black in all of them: a constant
# dark outline is what makes limited-palette art read at small sizes.
SEASONS = {
    "summer": {"o": "#1b3320", "a": "#63a552", "b": "#3d7a3c", "c": "#2d5c30",
               "t": "#6b4a2f", "u": "#43301f"},
    "autumn": {"o": "#33220f", "a": "#d8973a", "b": "#a55a24", "c": "#7d3f1c",
               "t": "#6b4a2f", "u": "#43301f"},
    "winter": {"o": "#2a3340", "a": "#e8eef2", "b": "#a9bccb", "c": "#7d94a6",
               "t": "#4f3a28", "u": "#33251a", },
    "spring": {"o": "#1e3524", "a": "#8fc95f", "b": "#5c9c46", "c": "#3f7735",
               "t": "#6b4a2f", "u": "#43301f"},
}
HIKER_PAL = {"o": "#20211f", "h": "#c2452f", "s": "#e0b088", "c": "#d9a441",
             "p": "#4d6b3c", "l": "#37506b"}


def norm(shape):
    w = max(len(r) for r in shape)
    return [r.ljust(w, ".") for r in shape]


def to_rgba(hexstr):
    h = hexstr.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)


def render(shape, palette, scale=1):
    from PIL import Image
    shape = norm(shape)
    w, h = len(shape[0]), len(shape)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = img.load()
    for y, row in enumerate(shape):
        for x, ch in enumerate(row):
            if ch == "." or ch not in palette:
                continue
            px[x, y] = to_rgba(palette[ch])
    if scale > 1:
        img = img.resize((w * scale, h * scale), Image.NEAREST)
    return img


def preview(path):
    from PIL import Image
    S = 10
    cols = [render(t, SEASONS[s], S) for s in SEASONS for t in TREES]
    frames = [render(f, HIKER_PAL, S) for f in HIKER]
    pad = 8
    tw = max(c.width for c in cols) + pad
    th = max(c.height for c in cols) + pad
    sheet = Image.new("RGBA", (tw * len(TREES), th * len(SEASONS) + th // 2 + 90),
                      (46, 52, 46, 255))
    for i, img in enumerate(cols):
        r, c = divmod(i, len(TREES))
        sheet.alpha_composite(img, (c * tw + pad // 2, r * th + pad // 2))
    y = th * len(SEASONS) + 10
    for i, img in enumerate(frames):
        sheet.alpha_composite(img, (i * (img.width + pad) + pad // 2, y))
    sheet.save(path)
    print(f"preview -> {path} ({sheet.width}x{sheet.height})")


def emit():
    def js(name, shapes):
        out = [f"  const {name} = ["]
        for sh in shapes:
            rows = ",".join('"%s"' % r for r in norm(sh))
            out.append(f"    [{rows}],")
        out.append("  ];")
        return "\n".join(out)
    print(js("PIX_TREES", TREES))
    print(js("PIX_HIKER", HIKER))
    for s, pal in SEASONS.items():
        print(f'  // {s}: {pal}')


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview")
    ap.add_argument("--emit", action="store_true")
    a = ap.parse_args()
    for t in TREES + HIKER:
        norm(t)
    if a.preview:
        preview(a.preview)
    if a.emit:
        emit()
