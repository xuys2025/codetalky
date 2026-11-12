"""Render the compact "completion report" screen at device pixels.

usage: python screen.py config.json out_dir

For each font set it writes <slug>[-suffix].png (480x800).
  levels 2: pure black/white. Glyphs come from FreeType's 1-bit rasteriser with the
            autohinter forced on, so every stem snaps to whole pixels.
  levels 4: the panel's 4-grey mode: anti-aliased glyphs quantised to 4 levels.
All text on a line shares one baseline, whatever font each run uses.
"""
import json
import sys
from pathlib import Path

import freetype
from PIL import Image, ImageDraw

W, H, PAD = 480, 800, 14
CLOSERS = "，。；：、！？”）》"
FT = freetype

# The real reply used as test content: (bullet?, [(text, style)]) with style in "", "b", "u".
REPORT = [
    (False, [("“完成汇报”界面已经加到", ""), ("设计稿", "u"), ("最右边，现在一共七张。", "")]),
    (False, [("会话做完时弹出这一页，内容是：", "")]),
    (True, [("它的汇报", "b"), ("：agent 收尾时写的那段总结，原样显示。", "")]),
    (True, [("结果", "b"), ("：改了几个文件、加减多少行、测试通过多少。", "")]),
    (True, [("改动的文件", "b"), ("：前三个文件和各自的加减行数，其余的在下一页，音量键翻过去。", "")]),
    (True, [("两个按钮", "b"), ("：“知道了”收起这条；“回复”发下一步指令，也可以直接按住 BOOT 说。", "")]),
    (True, [("顶部", "b"), ("：项目名、agent 和模型、总用时。", "")]),
    (False, [("两点说明：", "")]),
    (True, [("测试通过数是从它跑的测试命令输出里读的，没跑测试的会话这一格不显示。", "")]),
    (True, [("这张我同样没有渲染检查，有溢出或错位请告诉我。", "")]),
    (False, [("计划书里也补上了这个界面。七张都确认的话，我就开始用 LVGL 写进仿真器。", "")]),
]


class Font:
    """One face at one pixel size, rasterised by FreeType with explicit load flags."""

    def __init__(self, spec, size, grey):
        self.face = FT.Face(spec["path"], index=spec.get("index", 0))
        if "wght" in spec:
            self.face.set_var_design_coords((spec["wght"],))
        self.face.set_pixel_sizes(0, size)
        if grey:
            self.flags = FT.FT_LOAD_RENDER | FT.FT_LOAD_TARGET_LIGHT
        elif spec.get("hinting") == "native":
            # use the font's own TrueType instructions (only useful for properly hinted fonts)
            self.flags = FT.FT_LOAD_RENDER | FT.FT_LOAD_TARGET_MONO
        else:
            self.flags = FT.FT_LOAD_RENDER | FT.FT_LOAD_TARGET_MONO | FT.FT_LOAD_FORCE_AUTOHINT
        self.glyphs = {}

    def glyph(self, ch):
        if ch not in self.glyphs:
            self.face.load_char(ch, self.flags)
            g = self.face.glyph
            bm = g.bitmap
            w, h = bm.width, bm.rows
            mask = Image.new("L", (max(w, 1), max(h, 1)), 0)
            if w and h:
                buf = bytes(bm.buffer)
                if bm.pixel_mode == FT.FT_PIXEL_MODE_MONO:
                    px = mask.load()
                    for y in range(h):
                        row = buf[y * bm.pitch:(y + 1) * bm.pitch]
                        for x in range(w):
                            if row[x >> 3] & (0x80 >> (x & 7)):
                                px[x, y] = 255
                else:
                    mask = Image.frombytes("L", (w, h), buf, "raw", "L", bm.pitch)
            self.glyphs[ch] = (mask, g.bitmap_left, g.bitmap_top, g.advance.x / 64.0)
        return self.glyphs[ch]

    def getlength(self, text):
        return sum(self.glyph(ch)[3] for ch in text)

    def draw(self, img, x, baseline, text, fill):
        pen = float(x)
        for ch in text:
            mask, left, top, adv = self.glyph(ch)
            img.paste(fill, (int(round(pen)) + left, baseline - top), mask)
            pen += adv
        return pen


class Fonts:
    def __init__(self, spec, grey):
        self.spec, self.grey, self.cache = spec, grey, {}

    def has(self, role):
        return role in self.spec

    def get(self, role, size):
        if role not in self.spec:
            role = "text"
        key = (role, size)
        if key not in self.cache:
            self.cache[key] = Font(self.spec[role], size, self.grey)
        return self.cache[key]


def is_wide(ch):
    return ord(ch) >= 0x2E80


def mixed(text, fonts, size, bold=False):
    """UI data string: CJK in the text font, everything else in the mono font."""
    runs, cur, cur_wide = [], "", None
    for ch in text:
        wide = is_wide(ch)
        if cur and wide != cur_wide:
            runs.append((cur, cur_wide))
            cur = ""
        cur += ch
        cur_wide = wide
    if cur:
        runs.append((cur, cur_wide))
    out = []
    for chunk, wide in runs:
        role = ("bold" if bold else "text") if wide else ("mono_bold" if bold else "mono")
        fake = bold and not fonts.has(role)
        out.append((chunk, fonts.get(role if fonts.has(role) else ("text" if wide else "mono"), size), fake))
    return out


def draw_runs(img, x, baseline, runs, fill):
    for chunk, font, fake_bold in runs:
        end = font.draw(img, x, baseline, chunk, fill)
        if fake_bold:
            font.draw(img, x + 1, baseline, chunk, fill)
        x = end
    return x


def width_of(runs):
    return sum(font.getlength(chunk) for chunk, font, _ in runs)


def tokens(text):
    """Break opportunities: between CJK characters and at spaces; Latin words stay whole."""
    out, cur = [], ""
    for ch in text:
        if is_wide(ch) or ch in "“”":
            if cur:
                out.append(cur)
                cur = ""
            out.append(ch)
        elif ch == " ":
            if cur:
                out.append(cur)
                cur = ""
            out.append(" ")
        else:
            cur += ch
    if cur:
        out.append(cur)
    return out


def layout_paragraph(spans, fonts, size, max_w):
    regular = fonts.get("text", size)
    bold = fonts.get("bold", size)
    lines, line, line_w = [], [], 0.0
    for text, style in spans:
        font = bold if style == "b" else regular
        fake = style == "b" and not fonts.has("bold")
        for tok in tokens(text):
            tw = font.getlength(tok)
            hang = len(tok) == 1 and tok in CLOSERS  # closing punctuation may overhang
            if line and line_w + tw > max_w and not hang:
                lines.append(line)
                line, line_w = [], 0.0
                if tok == " ":
                    continue
            line.append((tok, font, fake, style == "u"))
            line_w += tw
    if line:
        lines.append(line)
    return lines


PAPER_RGB = (232, 230, 222)  # the panel's "white" is a light grey (datasheet: reflectance 30 %)
INK_RGB = (32, 32, 32)       # and its black is not pure black (contrast ratio about 7)


def overlay_levels(img):
    """Map coverage to the 4 states of the vendor's grey overlay (epd_gray_aa.cc):
    0 -> white, 1..127 -> light grey, 128..254 -> dark grey, 255 -> black."""
    def level(v):
        cov = 255 - v
        if cov == 0:
            return 255
        if cov < 128:
            return 170
        if cov < 255:
            return 85
        return 0
    return img.point(level)


def panel_tones(img):
    """Show an L or 1-bit image in the panel's real paper and ink tones."""
    grey = img.convert("L")
    bands = [grey.point(lambda v, i=INK_RGB[c], p=PAPER_RGB[c]: round(i + (p - i) * v / 255))
             for c in range(3)]
    return Image.merge("RGB", bands)


def render(spec, levels=2):
    grey = levels != 2
    fonts = Fonts(spec, grey)
    body_size = spec.get("body_size", 20)
    line_h = spec.get("line_height", round(body_size * 1.35))
    paper, ink = (255, 0) if grey else (1, 0)
    img = Image.new("L" if grey else "1", (W, H), paper)
    d = ImageDraw.Draw(img)

    # status bar
    d.rectangle([0, 0, W, 35], fill=ink)
    draw_runs(img, PAD, 25, mixed("codetalky", fonts, 18, bold=True), paper)
    right = mixed("14:32 · 82%", fonts, 18, bold=True)
    draw_runs(img, W - PAD - width_of(right), 25, right, paper)

    # header: every run sits on the same baseline
    x = draw_runs(img, PAD, 70, mixed("CodeTalky", fonts, 24, bold=True), ink)
    draw_runs(img, x + 12, 70, mixed("claude · fable-5.2", fonts, 18), ink)
    chip = mixed("完成", fonts, 18, bold=True)
    cw = int(width_of(chip)) + 20
    d.rectangle([W - PAD - cw, 48, W - PAD, 76], fill=ink)
    draw_runs(img, W - PAD - cw + 10, 69, chip, paper)
    d.rectangle([0, 86, W, 88], fill=ink)

    # one-line stats
    draw_runs(img, PAD, 112, mixed("用时 4 分 · 读 2 · 改 1 · 新 1", fonts, 18), ink)
    stat = mixed("+84 −3", fonts, 18, bold=True)
    draw_runs(img, W - PAD - width_of(stat), 112, stat, ink)
    d.rectangle([0, 122, W, 123], fill=ink)

    # body
    y = 134
    ascent = round(body_size * 0.9)
    for bullet, spans in REPORT:
        indent = 22 if bullet else 0
        lines = layout_paragraph(spans, fonts, body_size, W - 2 * PAD - indent)
        if bullet:
            mid = y + line_h // 2
            d.rectangle([PAD + 6, mid - 2, PAD + 10, mid + 2], fill=ink)
        for line in lines:
            x = PAD + indent
            for tok, font, fake, underline in line:
                end = font.draw(img, x, y + ascent, tok, ink)
                if fake:
                    font.draw(img, x + 1, y + ascent, tok, ink)
                if underline:
                    d.line([(x, y + ascent + 4), (end, y + ascent + 4)], fill=ink)
                x = end
            y += line_h
        y += 2 if bullet else 8
    body_end = y

    # bottom bar
    d.rectangle([0, 718, W, 720], fill=ink)
    draw_runs(img, PAD, 750, mixed("1/1 页", fonts, 18), ink)
    draw_runs(img, PAD, 776, mixed("音量键翻页", fonts, 18), ink)
    for i, (label, filled) in enumerate([("知道了", False), ("回复", True)]):
        x0 = W - PAD - 124 - (1 - i) * 136
        d.rectangle([x0, 729, x0 + 123, 790], fill=ink)
        if not filled:
            d.rectangle([x0 + 3, 732, x0 + 120, 787], fill=paper)
        runs = mixed(label, fonts, 22, bold=True)
        draw_runs(img, x0 + (124 - width_of(runs)) / 2, 768, runs, paper if filled else ink)

    if levels == "overlay":
        img = overlay_levels(img)
    elif grey:
        step = 255 / (levels - 1)
        img = img.point(lambda v: round(round(v / step) * step))
    if spec.get("tones"):
        img = panel_tones(img)
    return img, body_end


def main():
    cfg = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    for spec in cfg["sets"]:
        for levels in cfg.get("levels", [2]):
            try:
                img, body_end = render(spec, levels)
            except Exception as error:
                print(f"skip {spec['slug']}: {type(error).__name__}: {error}")
                continue
            suffix = "-bw" if levels == 2 else ("-overlay" if levels == "overlay" else f"-{levels}gray")
            path = out_dir / f"{spec['slug']}{suffix}.png"
            img.save(path)
            fits = "fits" if body_end <= 718 else f"OVERFLOWS by {body_end - 718}px"
            print(f"{path.name}: body ends at y={body_end} ({fits})")


if __name__ == "__main__":
    main()
