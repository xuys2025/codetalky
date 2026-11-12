/*
 * Hardware abstraction for the CodeTalky UI.
 *
 * The UI in ui/ only talks to hardware through these functions. The simulator
 * and the device firmware each provide one implementation, so the same UI code
 * runs in both.
 */
#ifndef CT_HAL_H
#define CT_HAL_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* How the e-ink panel should apply the next batch of changed pixels. */
typedef enum {
    CT_REFRESH_PARTIAL = 0, /* small change (a pressed button): fastest, may ghost */
    CT_REFRESH_FAST = 1,    /* page change: quick waveform, light flash */
    CT_REFRESH_FULL = 2,    /* clears ghosting: slow, whole-screen flash */
} ct_refresh_t;

/* Applies to everything drawn until the next frame is flushed. */
void ct_hal_refresh_hint(ct_refresh_t mode);

/* One short haptic pulse. */
void ct_hal_vibrate(uint16_t ms);

#ifdef __cplusplus
}
#endif

#endif /* CT_HAL_H */
