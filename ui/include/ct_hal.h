/*
 * Hardware abstraction for the CodeTalky UI.
 *
 * The UI in ui/ only talks to hardware through these functions. The simulator
 * and the device firmware each provide one implementation, so the same UI code
 * runs in both.
 */
#ifndef CT_HAL_H
#define CT_HAL_H

#include <stdbool.h>
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

/* Send one text frame (JSON) to the bridge on a link (one per computer). False if that link is down. */
bool ct_hal_net_send(int link, const char *json);

/* Battery charge in percent, or -1 if unknown. */
int ct_hal_battery_percent(void);

#ifdef __cplusplus
}
#endif

#endif /* CT_HAL_H */
