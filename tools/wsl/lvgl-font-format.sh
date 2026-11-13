#!/usr/bin/env bash
# Print the parts of LVGL's bitmap-font format that a font generator must match.
L="$HOME/.cache/codetalky/lvgl-v9.5.0"
echo "== glyph dsc struct"
sed -n '/^typedef struct {/,/} lv_font_fmt_txt_glyph_dsc_t;/p' "$L/src/font/fmt_txt/lv_font_fmt_txt.h" | grep -v '^\s*/\*\*' | head -40
echo "== font dsc struct"
awk '/Describe store additional data for fonts/,/} lv_font_fmt_txt_dsc_t;/' "$L/src/font/fmt_txt/lv_font_fmt_txt.h" | grep -E '^\s+[a-z_A-Z0-9 \*]+[;:]' | head -30
echo "== tail of a generated font (montserrat 14)"
tail -n 60 "$L/src/font/lv_font_montserrat_14.c"
echo "== head of the same file"
sed -n '1,30p' "$L/src/font/lv_font_montserrat_14.c"
