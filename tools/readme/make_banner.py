"""The README's banner and the device-framed screens, from the simulator's renders.

    uv run --no-project --with pillow python -I tools/readme/make_banner.py

Reads design/renders/ui-*.png (simulator/tools/render-ui.sh) and the switched-off art
(tools/offart), writes docs/images/. Pure black and white with dithered greys, like
the panel.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools" / "offart"))
import make_off_art as art  # noqa: E402

OUT = ROOT / "docs" / "images"
RENDERS = ROOT / "design" / "renders"
FONTS = ROOT / "third_party" / "fonts"
BOLD = FONTS / "sarasa-ui-sc" / "SarasaUiSC-SemiBold.ttf"
REGULAR = FONTS / "sarasa-ui-sc" / "SarasaUiSC-Regular.ttf"
MONO = FONTS / "jetbrains-mono" / "JetBrainsMono-ExtraBold.ttf"

INK = 0
PAPER = 255


def device(screen: Image.Image, scale: float) -> Image.Image:
    """A screen in a plain e-ink reader body: thick dark bezel, rounded corners."""
    w, h = int(480 * scale), int(800 * scale)
    bezel, chin = int(22 * scale), int(64 * scale)
    body = Image.new("L", (w + 2 * bezel, h + bezel + chin), PAPER)
    d = ImageDraw.Draw(body)
    r = int(34 * scale)
    d.rounded_rectangle((0, 0, body.width - 1, body.height - 1), r, fill=38)
    d.rounded_rectangle((3, 3, body.width - 4, body.height - 4), r - 3, outline=90, width=2)
    body.paste(screen.convert("L").resize((w, h), Image.LANCZOS), (bezel, bezel))
    # The BOOT key under the screen.
    cx, cy = body.width // 2, h + bezel + chin // 2
    d.rounded_rectangle((cx - int(40 * scale), cy - int(7 * scale), cx + int(40 * scale), cy + int(7 * scale)), int(7 * scale), fill=70)
    mask = Image.new("L", body.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, body.width - 1, body.height - 1), r, fill=255)
    out = Image.new("LA", body.size)
    out.paste(body, (0, 0))
    out.putalpha(mask)
    return out


def shadow(canvas: Image.Image, box, offset=14):
    """The logo's checkerboard shadow, as a drop shadow."""
    x0, y0, x1, y1 = box
    px = canvas.load()
    for y in range(y0 + offset, y1 + offset):
        for x in range(x0 + offset, x1 + offset):
            if 0 <= x < canvas.width and 0 <= y < canvas.height and (x // 3 + y // 3) % 2 == 0:
                px[x, y] = INK


def banner():
    W, H = 1760, 860
    img = Image.new("L", (W, H), PAPER)
    d = ImageDraw.Draw(img)

    # Dithered fade along the bottom, as on the switched-off screen.
    fade = art.draw_fade().convert("L")
    strip = Image.new("L", (W, fade.height), PAPER)
    for x in range(0, W, fade.width):
        strip.paste(fade, (x, 0))
    strip = strip.crop((0, 0, W, 170)).resize((W, 170), Image.NEAREST)
    img.paste(strip, (0, H - 170))

    # Logo and wordmark (pixel art), scaled by whole pixels to stay crisp.
    logo = art.draw_logo().convert("L").crop((0, 80, 480, 384))
    logo = logo.resize((logo.width * 3 // 2, logo.height * 3 // 2), Image.NEAREST)
    img.paste(logo, (40, 40))

    bold = ImageFont.truetype(str(BOLD), 46)
    regular = ImageFont.truetype(str(REGULAR), 28)
    mono = ImageFont.truetype(str(MONO), 24)
    d.text((100, 520), "墨水屏上的 AI 编程遥控器", font=bold, fill=INK)
    lines = ["Claude Code、Codex 在电脑上干活，", "你在沙发上看进度、点批准、说一句改方向。"]
    for i, line in enumerate(lines):
        d.text((100, 590 + i * 42), line, font=regular, fill=INK)
    tag = "ESP32-S3 · 480×800 E-INK · LVGL 9.5 · TypeScript"
    tw = d.textlength(tag, font=mono)
    d.rectangle((96, 688, 96 + tw + 28, 688 + 42), fill=PAPER, outline=INK, width=3)
    d.text((110, 695), tag, font=mono, fill=INK)

    # Three devices, staggered.
    shots = [("ui-01-list.png", 0.62, 830, 70), ("ui-05-approve.png", 0.62, 1130, 20), ("ui-06-question.png", 0.62, 1430, 90)]
    for name, scale, x, y in shots:
        dev = device(Image.open(RENDERS / name), scale)
        shadow(img, (x, y, x + dev.width, y + dev.height), offset=16)
        img.paste(dev.convert("L"), (x, y), dev.getchannel("A"))
    return img


def gallery():
    """Each screen used in the README, framed."""
    for name in [
        "ui-01-list", "ui-02-overview", "ui-05-approve", "ui-06-question", "ui-07-done",
        "ui-09-voice", "ui-19-plan", "ui-25-diff", "ui-14-two-computers", "ui-17-pair",
    ]:
        dev = device(Image.open(RENDERS / f"{name}.png"), 0.6)
        flat = Image.new("L", dev.size, PAPER)
        flat.paste(dev.convert("L"), (0, 0), dev.getchannel("A"))
        flat.save(OUT / f"{name[3:]}.png", optimize=True)


def off():
    screen = Image.new("L", (art.W, art.H), PAPER)
    screen.paste(art.draw_logo().convert("L"), (0, 0))
    screen.paste(art.draw_fade().convert("L"), (0, art.H - art.FADE_H))
    d = ImageDraw.Draw(screen)
    b32 = ImageFont.truetype(str(BOLD), 32)
    b24 = ImageFont.truetype(str(BOLD), 24)
    m32 = ImageFont.truetype(str(MONO), 32)
    d.text((art.W // 2, 438), "已关机", font=b32, fill=INK, anchor="mm")
    d.text((art.W // 2, 490), "按电源键开机", font=b24, fill=INK, anchor="mm")
    parts = [("电量 ", b32), ("82%", m32), (" · ", b32), ("19:53", m32), (" 关机", b32)]
    x = (art.W - sum(d.textlength(t, font=f) for t, f in parts)) / 2
    for t, f in parts:
        d.text((x, art.H - art.FADE_SOLID // 2), t, font=f, fill=PAPER, anchor="lm")
        x += d.textlength(t, font=f)
    dev = device(screen, 0.6)
    flat = Image.new("L", dev.size, PAPER)
    flat.paste(dev.convert("L"), (0, 0), dev.getchannel("A"))
    flat.save(OUT / "off.png", optimize=True)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    banner().save(OUT / "banner.png", optimize=True)
    gallery()
    off()
    for f in sorted(OUT.glob("*.png")):
        print(f"{f.relative_to(ROOT)}: {f.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
