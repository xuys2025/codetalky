"""Tile screenshots into one overview image, to check many screens at a glance.

usage: python contact-sheet.py out.png columns scale img1.png img2.png ...
"""
import sys

from PIL import Image

out, cols, scale = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
paths = sys.argv[4:]
tiles = []
for p in paths:
    img = Image.open(p).convert("RGB")
    tiles.append(img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS))
gap = 12
w = max(t.width for t in tiles)
h = max(t.height for t in tiles)
rows = (len(tiles) + cols - 1) // cols
sheet = Image.new("RGB", (cols * w + (cols + 1) * gap, rows * h + (rows + 1) * gap), (120, 120, 120))
for i, t in enumerate(tiles):
    sheet.paste(t, (gap + (i % cols) * (w + gap), gap + (i // cols) * (h + gap)))
sheet.save(out)
print(f"{out}  {sheet.width}x{sheet.height}  {len(tiles)} tiles")
