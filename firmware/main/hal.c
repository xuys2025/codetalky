/*
 * ct_hal.h on the device.
 */
#include <stdio.h>
#include <string.h>

#include "board.h"
#include "ct_hal.h"
#include "epd.h"
#include "esp_log.h"
#include "esp_random.h"
#include "net.h"
#include "nvs.h"
#include "ota.h"

static const char *TAG = "hal";
static const char *NVS_NS = "codetalky";

void ct_hal_refresh_hint(ct_refresh_t mode) {
    epd_hint(mode);
}

void ct_hal_vibrate(uint16_t ms) {
    board_vibrate(ms);
}

bool ct_hal_net_send(int link, const char *json) {
    return net_send(link, json);
}

void ct_hal_net_close(int link) {
    net_close(link);
}

int ct_hal_battery_percent(void) {
    return board_battery_percent();
}

const char *ct_hal_firmware_version(void) {
    return ota_version();
}

bool ct_hal_firmware_update(int link, const char *path, uint32_t size, const char *sha256, const char *version) {
    return ota_request(link, path, size, sha256, version);
}

uint32_t ct_hal_random(void) {
    /* Cryptographically strong while the radio is on, which it is whenever a link exists. */
    return esp_random();
}

/* NVS keys are at most 15 characters: longer names ("key:<hostId>") become a hash. */
static void nvs_key(const char *name, char out[16]) {
    if (strlen(name) <= 15) {
        snprintf(out, 16, "%s", name);
        return;
    }
    uint64_t h = 0xcbf29ce484222325ULL; /* FNV-1a */
    for (const unsigned char *p = (const unsigned char *)name; *p; p++) {
        h = (h ^ *p) * 0x100000001b3ULL;
    }
    snprintf(out, 16, "h%014llx", (unsigned long long)(h & 0x00FFFFFFFFFFFFFFULL));
}

bool ct_hal_store_get(const char *key, char *buf, size_t size) {
    char k[16];
    nvs_key(key, k);
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READONLY, &h) != ESP_OK) {
        return false;
    }
    size_t len = size;
    const esp_err_t err = nvs_get_str(h, k, buf, &len);
    nvs_close(h);
    return err == ESP_OK;
}

void ct_hal_store_set(const char *key, const char *value) {
    char k[16];
    nvs_key(key, k);
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGE(TAG, "cannot open storage");
        return;
    }
    esp_err_t err = value != NULL ? nvs_set_str(h, k, value) : nvs_erase_key(h, k);
    if (err == ESP_OK || err == ESP_ERR_NVS_NOT_FOUND) {
        err = nvs_commit(h);
    }
    nvs_close(h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "storing %s failed: %s", key, esp_err_to_name(err));
    }
}
