"""Crop a region of an image and enlarge it with nearest-neighbour, to inspect pixels.

usage: python crop.py in.png out.png x0 y0 x1 y1 zoom
"""
import sys

from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
x0, y0, x1, y1, zoom = (int(v) for v in sys.argv[3:8])
img = Image.open(src).crop((x0, y0, x1, y1))
img = img.resize((img.width * zoom, img.height * zoom), Image.NEAREST)
img.save(dst)
print(f"{dst}  {img.width}x{img.height}")
