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

/* The frame being drawn gets a full refresh after wiping the panel black and then
 * white: about 2 s more, but no ghost of the screen before. For a screen that stays
 * up for long, such as the last one before switching off. */
void epd_hint_clean(void);

/* Wait until everything drawn so far is on the panel, grey pass included.
 * False on timeout. Call from the UI task after lv_refr_now(). */
bool epd_wait_idle(uint32_t timeout_ms);

/* Before switching off: wait as epd_wait_idle(), then put the panel to sleep and
 * draw nothing more. False on timeout (the panel is then left as it is). */
bool epd_finish(uint32_t timeout_ms);

#endif /* EPD_H */
