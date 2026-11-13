#!/usr/bin/env bash
# Print the exact names of a few LVGL 9.5 APIs before using them.
L="$HOME/.cache/codetalky/lvgl-v9.5.0/src"
echo "== label long modes"; grep -n "LV_LABEL_LONG" "$L/widgets/label/lv_label.h" | head -12
echo "== span api"; grep -nE "^(lv_span_t|void|lv_style_t|lv_obj_t|uint32_t) \*? ?lv_span(group)?_[a-z_]+\(" "$L/widgets/span/lv_span.h" | head -30
echo "== span modes"; grep -nE "LV_SPAN_(MODE|OVERFLOW)_[A-Z]+" "$L/widgets/span/lv_span.h" | head -10
echo "== text is_a_word / cjk"; grep -nE "is_a_word|is_break_char|CJK|0x4E00" "$L/misc/lv_text.c" "$L/misc/lv_text_private.h" "$L/misc/lv_text.h" 2>/dev/null | head -12
echo "== theme auto init"; grep -nE "LV_USE_THEME_(DEFAULT|SIMPLE|MONO)" "$L/display/lv_display.c" | head -8
echo "== span enabled by default?"; grep -nE "define LV_USE_SPAN|define LV_USE_FLEX|define LV_USE_LABEL" "$L/lv_conf_internal.h" | head -6
echo "== screen load / delete"; grep -nE "^void lv_(screen_load|obj_delete)\(" "$L/display/lv_display.h" "$L/core/lv_obj_tree.h" | head
