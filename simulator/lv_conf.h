/*
 * LVGL configuration for the simulator. Only overrides are listed; everything
 * else takes LVGL's defaults (lv_conf_internal.h).
 */
#ifndef LV_CONF_H
#define LV_CONF_H

/* Rendered as RGB565, then thresholded to 1-bit by the e-ink panel model. */
#define LV_COLOR_DEPTH 16

#define LV_USE_STDLIB_MALLOC LV_STDLIB_CLIB
#define LV_USE_STDLIB_STRING LV_STDLIB_CLIB
#define LV_USE_STDLIB_SPRINTF LV_STDLIB_CLIB
#define LV_USE_OS LV_OS_NONE

#define LV_DEF_REFR_PERIOD 33
/* 3.97", 800x480 panel. */
#define LV_DPI_DEF 235

#define LV_USE_LOG 1
#define LV_LOG_LEVEL LV_LOG_LEVEL_WARN
#define LV_LOG_PRINTF 1

/* E-ink: no colour theme, no transitions. */
#define LV_USE_THEME_DEFAULT 0
#define LV_USE_THEME_SIMPLE 0
#define LV_USE_THEME_MONO 1

#define LV_FONT_MONTSERRAT_14 1
#define LV_FONT_MONTSERRAT_24 1
#define LV_FONT_MONTSERRAT_32 1
#define LV_FONT_SOURCE_HAN_SANS_SC_16_CJK 1
#define LV_FONT_DEFAULT &lv_font_montserrat_24

/* Real fonts are loaded from TTF data at run time in the simulator. */
#define LV_USE_TINY_TTF 1
#define LV_TINY_TTF_FILE_SUPPORT 0

#define LV_USE_VECTOR_GRAPHIC 0
#define LV_USE_THORVG_INTERNAL 0
#define LV_USE_LOTTIE 0

#endif /* LV_CONF_H */
