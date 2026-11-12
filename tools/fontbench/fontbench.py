"""Render font specimens the way a 1-bit e-ink panel shows them.

usage: python fontbench.py config.json out_dir

Two rasterisation paths are compared for every font, at real device pixels:
  mono : FreeType's 1-bit rasteriser with hinting (what a 1 bpp font pack would hold)
  aa   : anti-aliased greyscale, then a 50 % threshold (what a naive pipeline gives)
Each sheet is 2 columns (mono | aa), one row per font, saved as a 1-bit PNG.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W = 480
PAD = 14
PROSE = "局刷后残影没清干净。先加一个计数器，累计 8 次强制全刷，再跑一遍刷新测试。"
CODE = "Edit display/epd_driver.c +18 −7"
HARD = "编辑器藏餐覆魔警露赢罐髓 0O1lI|"
LABEL = ImageFont.load_default()


def load(spec, size):
    font = ImageFont.truetype(spec["path"], size, index=spec.get("index", 0),
                              layout_engine=ImageFont.Layout.BASIC)
    if "wght" in spec:
        font.set_variation_by_axes([spec["wght"]])
    return font


def wrap(text, font, width):
    lines, cur = [], ""
    for ch in text:
        if cur and font.getlength(cur + ch) > width:
            lines.append(cur)
            cur = "" if ch == " " else ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def render_block(entry, size, mode):
    text_font = load(entry["text"], size)
    code_font = load(entry.get("code", entry["text"]), size)
    line_h = round(size * 1.35)
    lines = [(line, text_font) for line in wrap(PROSE, text_font, W - 2 * PAD)]
    lines.append((CODE, code_font))
    lines.append((HARD, text_font))
    height = line_h * len(lines) + 10
    if mode == "mono":
        img = Image.new("1", (W, height), 1)
        draw = ImageDraw.Draw(img)
        draw.fontmode = "1"
        ink = 0
    else:
        img = Image.new("L", (W, height), 255)
        draw = ImageDraw.Draw(img)
        ink = 0
    y = 5
    for text, font in lines:
        draw.text((PAD, y), text, font=font, fill=ink)
        y += line_h
    if mode == "aa":
        img = img.point(lambda v: 255 if v >= 128 else 0).convert("1")
    return img


def sheet(entries, size):
    rows = []
    for entry in entries:
        try:
            mono = render_block(entry, size, "mono")
            aa = render_block(entry, size, "aa")
        except Exception as error:  # a broken or missing font should not stop the run
            print(f"skip {entry['name']}: {error}")
            continue
        rows.append((entry["name"], mono, aa))
    gap, label_h = 8, 16
    total_h = sum(label_h + max(m.height, a.height) + gap for _, m, a in rows)
    out = Image.new("1", (W * 2 + gap, total_h), 1)
    draw = ImageDraw.Draw(out)
    y = 0
    for name, mono, aa in rows:
        draw.text((2, y + 2), f"{name}  {size}px   left: mono-hinted   right: AA then threshold",
                  font=LABEL, fill=0)
        y += label_h
        out.paste(mono, (0, y))
        out.paste(aa, (W + gap, y))
        y += max(mono.height, aa.height)
        draw.line([(0, y + gap // 2), (out.width, y + gap // 2)], fill=0)
        y += gap
    return out


def main():
    cfg = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    for size in cfg["sizes"]:
        img = sheet(cfg["fonts"], size)
        path = out_dir / f"{cfg.get('prefix', 'sheet')}-{size}px.png"
        img.save(path)
        print(f"{path}  {img.width}x{img.height}")


if __name__ == "__main__":
    main()
