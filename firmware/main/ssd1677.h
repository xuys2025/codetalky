/*
 * SSD1677 e-ink controller, 800 x 480. Low level: load images into its two RAM
 * planes and run one refresh at a time. Blocking; call from one task only.
 */
#ifndef SSD1677_DRIVER_H
#define SSD1677_DRIVER_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#define SSD1677_W 800
#define SSD1677_H 480
#define SSD1677_STRIDE (SSD1677_W / 8)
#define SSD1677_PLANE_BYTES (SSD1677_STRIDE * SSD1677_H)

/* Plane bits: 1 = white, 0 = black. Byte (y * STRIDE + x / 8), bit 0x80 >> (x % 8). */

typedef enum {
    SSD1677_PARTIAL,   /* drives only pixels whose two plane bits differ, no flash */
    SSD1677_FULL_FAST, /* whole screen, one black/white flash, MCU waveform (~0.8 s) */
    SSD1677_FULL,      /* whole screen, the panel's own (OTP) waveform: slow, cleanest */
    SSD1677_GREY,      /* grey overlay: plane bits pick how much each black pixel lightens */
} ssd1677_mode_t;

esp_err_t ssd1677_init(void);

/* new_plane: 0x24, the image to show. old_plane: 0x26, what the panel shows now
 * (a partial refresh moves only pixels where they differ). Either may be NULL to
 * leave that plane as it is. Buffers may be anywhere; they are copied for DMA. */
esp_err_t ssd1677_load(const uint8_t *new_plane, const uint8_t *old_plane);

/* Run one refresh and wait for it. *ms (optional) gets how long the panel was busy. */
esp_err_t ssd1677_refresh(ssd1677_mode_t mode, int *ms);

/* Panel deep sleep; ssd1677_init() wakes it again. */
esp_err_t ssd1677_sleep(void);

#endif /* SSD1677_DRIVER_H */
