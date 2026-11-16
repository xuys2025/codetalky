"""Pixel art for the device's "switched off" screen.

Draws the logo (a speech bubble holding a >_ prompt, with a dithered shadow), the
CODETALKY wordmark and a dithered fade to black, all pure black and white so the
e-ink panel shows them crisply, and writes them as LVGL 1-bit indexed images:

    uv run --no-project --with pillow python -I tools/offart/make_off_art.py [preview.png]

Output: ui/src/ct_art.c (ct_art_logo, ct_art_fade). With a path, also a full-screen
preview with the screen's text roughly in place (the device draws the text itself).
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
W, H = 480, 800

U = 8  # one art "pixel" is 8x8 screen pixels

# Logo + wordmark image: top of the screen.
LOGO_H = 400
BUBBLE_W, BUBBLE_H = 36, 20  # in art pixels
BUBBLE_X = (W - BUBBLE_W * U) // 2
BUBBLE_Y = 88
SHADOW = 2  # art pixels, down and right

# Fade image: bottom of the screen.
FADE_H = 250
FADE_SOLID = 64  # bottom rows that are solid black (the battery line sits there)
CELL = 4  # dither cell, screen pixels

GLYPHS = {
    "C": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
    "O": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    "D": ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
    "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
    "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
    "L": ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
    "K": ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
    "Y": ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
}
WORD = "CODETALKY"
WORD_Y = 324

BAYER8 = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
]


def bubble_cells():
    """Art pixels of the bubble: outline (with rounded corners and a tail) and the
    filled silhouette (for the shadow and for clearing the inside)."""
    outline, silhouette = set(), set()
    t = 2
    corners = {(0, 0), (BUBBLE_W - 1, 0), (0, BUBBLE_H - 1), (BUBBLE_W - 1, BUBBLE_H - 1)}
    inner = {(t, t), (BUBBLE_W - 1 - t, t), (t, BUBBLE_H - 1 - t), (BUBBLE_W - 1 - t, BUBBLE_H - 1 - t)}
    for y in range(BUBBLE_H):
        for x in range(BUBBLE_W):
            if (x, y) in corners:
                continue
            silhouette.add((x, y))
            edge = x < t or x >= BUBBLE_W - t or y < t or y >= BUBBLE_H - t
            if edge or (x, y) in inner:
                outline.add((x, y))
    # Tail under the left part: a solid stepped triangle with a straight left side.
    for k in range(4):
        for x in range(7, 7 + 4 - k):
            outline.add((x, BUBBLE_H + k))
            silhouette.add((x, BUBBLE_H + k))
    return outline, silhouette


def prompt_cells():
    """The >_ inside the bubble: a 2-pixel-thick chevron and an underscore cursor."""
    cells = set()
    top = 6
    for r in range(9):
        off = min(r, 8 - r)
        for dx in range(2):
            cells.add((8 + off + dx, top + r))
    for x in range(17, 25):
        for y in (top + 7, top + 8):
            cells.add((x, y))
    return cells


def draw_logo():
    img = Image.new("1", (W, LOGO_H), 1)
    px = img.load()

    def fill(cx, cy, colour, pattern=False):
        for dy in range(U):
            for dx in range(U):
                x, y = BUBBLE_X + cx * U + dx, BUBBLE_Y + cy * U + dy
                if 0 <= x < W and 0 <= y < LOGO_H:
                    if pattern and ((x // 2 + y // 2) % 2):
                        continue
                    px[x, y] = colour

    outline, silhouette = bubble_cells()
    for cx, cy in silhouette:  # shadow: a 2x2 checkerboard where the bubble would be, offset
        fill(cx + SHADOW, cy + SHADOW, 0, pattern=True)
    for cx, cy in silhouette:
        fill(cx, cy, 1)
    for cx, cy in outline | prompt_cells():
        fill(cx, cy, 0)

    # Wordmark: 5x7 letters, one art pixel apart.
    width = len(WORD) * 5 * U + (len(WORD) - 1) * U
    x0 = (W - width) // 2
    for i, ch in enumerate(WORD):
        for gy, row in enumerate(GLYPHS[ch]):
            for gx, c in enumerate(row):
                if c == "#":
                    for dy in range(U):
                        for dx in range(U):
                            px[x0 + (i * 6 + gx) * U + dx, WORD_Y + gy * U + dy] = 0
    return img


def draw_fade():
    """White at the top to black at the bottom, ordered dither in CELL-sized dots."""
    img = Image.new("1", (W, FADE_H), 1)
    px = img.load()
    ramp = FADE_H - FADE_SOLID
    for y in range(FADE_H):
        level = 1.0 if y >= ramp else (y / ramp) ** 1.6
        for x in range(W):
            threshold = (BAYER8[(y // CELL) % 8][(x // CELL) % 8] + 0.5) / 64
            if level > threshold:
                px[x, y] = 0
    return img


def c_image(name, img):
    w, h = img.size
    stride = (w + 7) // 8
    data = bytearray()
    # I1: a two-entry palette (B, G, R, A per entry), then rows MSB first; index 1 = white.
    data += bytes([0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF])
    px = img.load()
    for y in range(h):
        for bx in range(stride):
            byte = 0
            for bit in range(8):
                x = bx * 8 + bit
                if x < w and px[x, y]:
                    byte |= 0x80 >> bit
            data.append(byte)
    lines = [f"static const uint8_t {name}_data[] = {{"]
    for i in range(0, len(data), 24):
        lines.append("    " + ", ".join(f"0x{b:02x}" for b in data[i : i + 24]) + ",")
    lines.append("};")
    lines.append(f"const lv_image_dsc_t {name} = {{")
    lines.append(f"    .header = {{.magic = LV_IMAGE_HEADER_MAGIC, .cf = LV_COLOR_FORMAT_I1, .w = {w}, .h = {h}, .stride = {stride}}},")
    lines.append(f"    .data_size = sizeof({name}_data),")
    lines.append(f"    .data = {name}_data,")
    lines.append("};")
    return "\n".join(lines)


def main():
    logo, fade = draw_logo(), draw_fade()
    out = ROOT / "ui" / "src" / "ct_art.c"
    out.write_text(
        "/* Generated by tools/offart/make_off_art.py: do not edit. Pixel art for the\n"
        " * \"switched off\" screen, 1-bit indexed. */\n"
        '#include "ct_art.h"\n\n' + c_image("ct_art_logo", logo) + "\n\n" + c_image("ct_art_fade", fade) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"wrote {out.relative_to(ROOT)}: logo {logo.size}, fade {fade.size}")

    if len(sys.argv) > 1:
        screen = Image.new("L", (W, H), 255)
        screen.paste(logo.convert("L"), (0, 0))
        screen.paste(fade.convert("L"), (0, H - FADE_H))
        d = ImageDraw.Draw(screen)
        fonts = ROOT / "third_party" / "fonts"
        b24 = ImageFont.truetype(str(fonts / "sarasa-ui-sc" / "SarasaUiSC-SemiBold.ttf"), 24)
        mb32 = ImageFont.truetype(str(fonts / "jetbrains-mono" / "JetBrainsMono-ExtraBold.ttf"), 32)
        d.text((W // 2, 438), "已关机", font=b24.font_variant(size=32), fill=0, anchor="mm")
        d.text((W // 2, 490), "按电源键开机", font=b24, fill=0, anchor="mm")
        b32 = b24.font_variant(size=32)
        parts = [("电量 ", b32), ("82%", mb32), (" · ", b32), ("19:53", mb32), (" 关机", b32)]
        x = (W - sum(d.textlength(t, font=f) for t, f in parts)) / 2
        for t, f in parts:  # the device's font falls back to the CJK one the same way
            d.text((x, H - FADE_SOLID // 2), t, font=f, fill=255, anchor="lm")
            x += d.textlength(t, font=f)
        screen.save(sys.argv[1])
        print(f"preview: {sys.argv[1]}")


if __name__ == "__main__":
    main()
