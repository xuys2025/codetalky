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
#include <stddef.h>
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

/* Drop a link's connection (its computer failed a security check); reconnect later as usual. */
void ct_hal_net_close(int link);

/* Battery charge in percent, or -1 if unknown. */
int ct_hal_battery_percent(void);

/* Small persistent settings (NVS on the device): the device id and the key it paired
 * with each computer ("key:<hostId>", 64 hex digits). get returns false if the key is
 * not set. Names can be longer than NVS's 15 characters: the firmware has to map them. */
bool ct_hal_store_get(const char *key, char *buf, size_t size);
void ct_hal_store_set(const char *key, const char *value); /* NULL value erases the key */

/* Which firmware build this is (sent in hello as "fw"), or NULL if this platform can't
 * update itself over the network (the simulator). */
const char *ct_hal_firmware_version(void);

/* A paired computer offers new firmware (this only ever comes over an encrypted link):
 * download `path` over HTTP from the computer behind `link`, check it is `size` bytes
 * with SHA-256 `sha256` (64 hex digits), install it and restart. Returns at once;
 * false if the platform can't or is already updating. */
bool ct_hal_firmware_update(int link, const char *path, uint32_t size, const char *sha256, const char *version);

/* 32 random bits. Pairing and connection keys are made from these: they must come
 * from a cryptographic source (esp_random with the radio on; crypto.getRandomValues). */
uint32_t ct_hal_random(void);

#ifdef __cplusplus
}
#endif

#endif /* CT_HAL_H */
