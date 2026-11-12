"""Print the text of a PDF, page by page, optionally only pages matching keywords.

usage: python pdftext.py file.pdf [max_chars_per_page] [keyword ...]
"""
import sys

from pypdf import PdfReader

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
path = sys.argv[1]
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 1500
keywords = [k.lower() for k in sys.argv[3:]]
reader = PdfReader(path)
print(f"pages: {len(reader.pages)}")
for i, page in enumerate(reader.pages, 1):
    text = " ".join((page.extract_text() or "").split())
    if keywords and not any(k in text.lower() for k in keywords):
        continue
    print(f"--- page {i} ({len(text)} chars)")
    print(text[:limit])
