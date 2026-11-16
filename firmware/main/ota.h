/*
 * Firmware updates over the network (see bridge/src/firmware.ts for the other side).
 *
 * A paired computer sends {"t":"update"} over its encrypted link: a download path
 * on that computer, the size and the SHA-256. The image is downloaded over plain
 * HTTP into the other OTA partition, checked against the hash, and booted. The new
 * build must then reach a computer (or run for 5 minutes) to be kept; if it restarts
 * before that, the bootloader goes back to the previous one.
 */
#ifndef OTA_H
#define OTA_H

#include <stdbool.h>
#include <stdint.h>

/* At boot: note whether this build still has to prove itself. */
void ota_boot(void);

/* A computer is reachable: this build works well enough to keep. */
void ota_confirm(void);

/* This build: the first 10 hex digits of its ELF's SHA-256 (what the bridge reads from an image). */
const char *ota_version(void);

/* From ct_hal_firmware_update (UI task): queue the update. False if one is under way. */
bool ota_request(int link, const char *path, uint32_t size, const char *sha256, const char *version);

/* UI task: carry out a queued update (draws its own pages; restarts on success). */
void ota_run(void);

#endif /* OTA_H */
