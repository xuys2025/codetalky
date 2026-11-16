/*
 * E-ink presentation: turns LVGL frames into panel refreshes.
 *
 * Same rule as the simulator's panel model (simulator/web/sim.js): the panel keeps
 * what it was last told to show, every frame is compared with that, and nothing is
 * refreshed if nothing changed. Refreshes run in their own task, so LVGL and touch
 * never wait for the panel; frames that arrive meanwhile are merged into the next one.
 */
#ifndef EPD_H
#define EPD_H

#include "ct_hal.h"
#include "lvgl.h"

#define EPD_UI_W 480
#define EPD_UI_H 800

/* Panel up, refresh task started, LVGL display created (call after lv_init). */
lv_display_t *epd_init(void);

/* The UI's refresh hint for the frame being drawn (strongest one wins). */
void epd_hint(ct_refresh_t mode);

#endif /* EPD_H */
