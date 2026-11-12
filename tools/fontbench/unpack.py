"""Unpack a downloaded font archive into a directory, then list the font files found.

usage: python unpack.py archive out_dir
Supports .7z (needs py7zr), .tar.gz, .tar.xz, .tar.bz2 and .zip.
"""
import sys
import tarfile
import zipfile
from pathlib import Path

archive, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
name = archive.name.lower()
if name.endswith(".7z"):
    import py7zr

    with py7zr.SevenZipFile(archive) as z:
        z.extractall(out)
elif name.endswith(".zip"):
    with zipfile.ZipFile(archive) as z:
        z.extractall(out)
else:
    with tarfile.open(archive) as t:
        t.extractall(out, filter="data")

for p in sorted(out.rglob("*")):
    if p.suffix.lower() in {".ttf", ".ttc", ".otf", ".bdf", ".pcf"}:
        print(f"{p.stat().st_size:>10}  {p.relative_to(out)}")
