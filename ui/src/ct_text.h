/* Small text formatters. The bridge sends numbers and timestamps; the device words them. */
#ifndef CT_TEXT_H
#define CT_TEXT_H

#include <stddef.h>
#include <stdint.h>

/* "+18 −7", "+58", "−3", or "" when both are zero. */
void ct_fmt_stat(char *buf, size_t size, int add, int del);

/* Local "14:32" for a Unix time; "--:--" when the clock is not set yet. */
void ct_fmt_clock(char *buf, size_t size, int64_t unix_seconds);

/* "30 秒", "8 分", "1 小时 5 分", "3 小时", "2 天". */
void ct_fmt_span(char *buf, size_t size, int64_t seconds);

/* The part after the last '/'. */
const char *ct_basename(const char *path);

#endif /* CT_TEXT_H */
