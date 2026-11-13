/*
 * LVGL configuration for the simulator. Only overrides are listed; everything
 * else takes LVGL's defaults (lv_conf_internal.h).
 */
#ifndef LV_CONF_H
#define LV_CONF_H

/* Rendered as RGB565; the e-ink panel model turns it into black/white and grey. */
#define LV_COLOR_DEPTH 16

#define LV_USE_STDLIB_MALLOC LV_STDLIB_CLIB
#define LV_USE_STDLIB_STRING LV_STDLIB_CLIB
#define LV_USE_STDLIB_SPRINTF LV_STDLIB_CLIB
#define LV_USE_OS LV_OS_NONE

#define LV_DEF_REFR_PERIOD 33
/* 3.97", 480x800 panel. */
#define LV_DPI_DEF 235

#define LV_USE_LOG 1
#define LV_LOG_LEVEL LV_LOG_LEVEL_WARN
#define LV_LOG_PRINTF 1

/* The UI styles every object itself: no theme, so nothing animates or gets rounded. */
#define LV_USE_THEME_DEFAULT 0
#define LV_USE_THEME_SIMPLE 0
#define LV_USE_THEME_MONO 0

/* Fonts come from tools/fontpack (ui/fonts/gen). */
#define LV_FONT_MONTSERRAT_14 0
#define LV_FONT_CUSTOM_DECLARE LV_FONT_DECLARE(ct_font_text_20)
#define LV_FONT_DEFAULT &ct_font_text_20

#define LV_USE_VECTOR_GRAPHIC 0
#define LV_USE_THORVG_INTERNAL 0
#define LV_USE_LOTTIE 0

#endif /* LV_CONF_H */
