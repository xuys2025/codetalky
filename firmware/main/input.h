/*
 * Touch screen (CST816S), the three touch keys below the screen, and the physical
 * keys. A task samples them every 10 ms; touches are latched as press/release
 * edges so a quick tap is not lost while LVGL is busy.
 */
#ifndef INPUT_H
#define INPUT_H

#include "lvgl.h"

/* Creates the LVGL pointer device and starts sampling. Call after epd_init(). */
lv_indev_t *input_init(void);

#endif /* INPUT_H */
