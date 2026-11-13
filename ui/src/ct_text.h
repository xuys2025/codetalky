/* Small text formatters. The bridge sends numbers and timestamps; the device words them. */
#ifndef CT_TEXT_H
#define CT_TEXT_H

#include <stddef.h>
#include <stdint.h>

#include "lvgl.h"

/* "+18 −7", "+58", "−3", or "" when both are zero. */
void ct_fmt_stat(char *buf, size_t size, int add, int del);

/* Local "14:32" for a Unix time; "--:--" when the clock is not set yet. */
void ct_fmt_clock(char *buf, size_t size, int64_t unix_seconds);

/* "30 秒", "8 分", "1 小时 5 分", "3 小时", "2 天". */
void ct_fmt_span(char *buf, size_t size, int64_t seconds);

/* The part after the last '/'. */
const char *ct_basename(const char *path);

/* A piece of text in one font, for wrapping text that mixes fonts (a bold lead-in
 * followed by body text). ct_wrap writes the text, with a newline added wherever a
 * line should break, to out (give it room for twice the input). */
typedef struct {
    const char *text;
    const lv_font_t *font;
    char *out;
    size_t out_size;
} ct_run_t;

/* Break runs into lines of at most width pixels, following Chinese line-breaking
 * rules: closing punctuation never starts a line, opening punctuation never ends one,
 * and Latin words and paths are only split when a whole line can't hold them. */
void ct_wrap(ct_run_t *runs, int count, int32_t width);

#endif /* CT_TEXT_H */
