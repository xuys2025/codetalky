"""Compare ways of turning one outline font into 1-bit pixels.

usage: python raster_lab.py font.ttf size out.png [zoom]

Each strategy renders the same two lines on a shared baseline. The sheet is
saved at `zoom`x (nearest neighbour) so individual pixels can be inspected.
"""
import sys

import freetype
from PIL import Image, ImageDraw, ImageFont

LINES = [
    "计划书里也补上了这个界面。七张都确认的话，",
    "我就开始用 LVGL 写进仿真器，测试通过 12 个。",
]
LABEL = ImageFont.load_default()
F = freetype


def glyph_image(face, ch, flags):
    face.load_char(ch, flags)
    g = face.glyph
    bm = g.bitmap
    w, h = bm.width, bm.rows
    img = Image.new("L", (max(w, 1), max(h, 1)), 0)
    if w and h:
        buf = bytes(bm.buffer)
        if bm.pixel_mode == F.FT_PIXEL_MODE_MONO:
            px = img.load()
            for y in range(h):
                row = buf[y * bm.pitch:(y + 1) * bm.pitch]
                for x in range(w):
                    if row[x >> 3] & (0x80 >> (x & 7)):
                        px[x, y] = 255
        else:
            img = Image.frombytes("L", (w, h), buf, "raw", "L", bm.pitch)
    return img, g.bitmap_left, g.bitmap_top, g.advance.x / 64.0


def render_line(face, text, flags, width, height, baseline, scale=1):
    """Coverage image (0..255, ink = 255) of one line."""
    img = Image.new("L", (width * scale, height * scale), 0)
    pen = 14.0 * scale
    for ch in text:
        glyph, left, top, adv = glyph_image(face, ch, flags)
        x = int(round(pen)) + left
        y = baseline * scale - top
        img.paste(Image.eval(glyph, lambda v: v), (x, y), glyph)
        pen += adv
    return img


def strategies(path, size):
    def face_at(px):
        face = freetype.Face(path)
        face.set_pixel_sizes(0, px)
        return face

    mono = F.FT_LOAD_RENDER | F.FT_LOAD_TARGET_MONO
    gray = F.FT_LOAD_RENDER
    return [
        ("A mono, font's own hinting (what round 1 used)", face_at(size), mono, 1, None),
        ("B mono, forced autohinter", face_at(size), mono | F.FT_LOAD_FORCE_AUTOHINT, 1, None),
        ("C mono, no hinting", face_at(size), mono | F.FT_LOAD_NO_HINTING, 1, None),
        ("D grey unhinted, threshold 50%", face_at(size), gray | F.FT_LOAD_NO_HINTING, 1, 128),
        ("E grey light-hinted, threshold 45%", face_at(size), gray | F.FT_LOAD_TARGET_LIGHT, 1, 115),
        ("F 4x supersampled unhinted, threshold 45%", face_at(size * 4), gray | F.FT_LOAD_NO_HINTING, 4, 115),
        ("G 4x supersampled unhinted, threshold 35% (bolder)", face_at(size * 4), gray | F.FT_LOAD_NO_HINTING, 4, 90),
    ]


def main():
    path, size, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
    zoom = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    width, line_h = 480, round(size * 1.35)
    baseline = round(size * 0.95)
    block_h = line_h * len(LINES) + 6
    rows = []
    for name, face, flags, scale, threshold in strategies(path, size):
        block = Image.new("1", (width, block_h), 1)
        for i, text in enumerate(LINES):
            cov = render_line(face, text, flags, width, line_h, baseline, scale)
            if scale > 1:
                cov = cov.resize((width, line_h), Image.BOX)
            cut = 128 if threshold is None else threshold
            ink = cov.point(lambda v: 0 if v >= cut else 255).convert("1")
            block.paste(ink, (0, 3 + i * line_h))
        rows.append((name, block))

    label_h = 14
    sheet = Image.new("1", (width * zoom, sum(label_h + block_h * zoom + 6 for _ in rows)), 1)
    draw = ImageDraw.Draw(sheet)
    y = 0
    for name, block in rows:
        draw.text((2, y + 1), name, font=LABEL, fill=0)
        y += label_h
        if zoom > 1:
            block = block.resize((width * zoom, block_h * zoom), Image.NEAREST)
        sheet.paste(block, (0, y))
        y += block_h * zoom + 6
    sheet.save(out)
    print(f"{out}  {sheet.width}x{sheet.height}")


if __name__ == "__main__":
    main()
