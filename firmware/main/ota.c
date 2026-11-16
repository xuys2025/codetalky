/*
 * Firmware updates over the network. See ota.h.
 */
#include "ota.h"

#include <stdio.h>
#include <string.h>

#include "app.h"
#include "ct_widgets.h"
#include "epd.h"
#include "esp_app_desc.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_pm.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"
#include "net.h"

static const char *TAG = "ota";

#define KEEP_AFTER_US (5LL * 60 * 1000 * 1000) /* a new build that runs this long is kept */
#define CHUNK 4096

static struct {
    bool pending;
    int link;
    char path[104];
    uint32_t size;
    char sha256[65];
    char version[33];
} s_req;

static bool s_unproven;
static esp_timer_handle_t s_keep_timer;

const char *ota_version(void) {
    /* Straight from the app description: esp_app_get_elf_sha256() stops at
     * CONFIG_APP_RETRIEVE_LEN_ELF_SHA (9) digits. */
    static char version[11];
    if (version[0] == '\0') {
        const uint8_t *sha = esp_app_get_description()->app_elf_sha256;
        for (int i = 0; i < 5; i++) {
            snprintf(version + i * 2, 3, "%02x", sha[i]);
        }
    }
    return version;
}

void ota_confirm(void) {
    if (!s_unproven) {
        return;
    }
    s_unproven = false;
    if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
        ESP_LOGI(TAG, "firmware %s kept", ota_version());
    }
    if (s_keep_timer != NULL) {
        esp_timer_stop(s_keep_timer);
    }
}

static void keep_after_a_while(void *arg) {
    (void)arg;
    ota_confirm();
}

void ota_boot(void) {
    esp_ota_img_states_t state;
    const esp_partition_t *running = esp_ota_get_running_partition();
    ESP_LOGI(TAG, "firmware %s in %s", ota_version(), running->label);
    if (esp_ota_get_state_partition(running, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY) {
        s_unproven = true;
        ESP_LOGW(TAG, "new firmware: kept once a computer is reached (or after 5 minutes)");
        const esp_timer_create_args_t args = {.callback = keep_after_a_while, .name = "ota_keep"};
        if (esp_timer_create(&args, &s_keep_timer) == ESP_OK) {
            esp_timer_start_once(s_keep_timer, KEEP_AFTER_US);
        }
    }
}

bool ota_request(int link, const char *path, uint32_t size, const char *sha256, const char *version) {
    if (s_req.pending) {
        return false;
    }
    s_req.link = link;
    snprintf(s_req.path, sizeof(s_req.path), "%s", path);
    s_req.size = size;
    snprintf(s_req.sha256, sizeof(s_req.sha256), "%s", sha256);
    snprintf(s_req.version, sizeof(s_req.version), "%s", version);
    s_req.pending = true;
    const app_event_t ev = {.type = APP_EV_UPDATE};
    if (!app_post(&ev)) {
        s_req.pending = false;
        return false;
    }
    return true;
}

static lv_obj_t *page(const char *title, const char *line) {
    lv_obj_t *screen = ct_screen_new();
    lv_obj_set_flex_align(screen, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_row(screen, 16, 0);
    ct_label(screen, B24, title);
    ct_label(screen, F20, line);
    epd_hint(CT_REFRESH_FAST);
    lv_screen_load(screen);
    lv_refr_now(NULL);
    return screen;
}

/* Download, check and install. On failure *why says what went wrong, for the user. */
static bool install(const char **why) {
    char url[160];
    if (!net_link_url(s_req.link, s_req.path, url, sizeof(url))) {
        *why = "没连着电脑";
        return false;
    }
    ESP_LOGI(TAG, "downloading %s (%lu bytes, firmware %s)", url, (unsigned long)s_req.size, s_req.version);
    const esp_http_client_config_t cfg = {.url = url, .timeout_ms = 15000, .buffer_size = CHUNK};
    esp_http_client_handle_t http = esp_http_client_init(&cfg);
    if (http == NULL || esp_http_client_open(http, 0) != ESP_OK) {
        if (http != NULL) esp_http_client_cleanup(http);
        *why = "下载失败";
        return false;
    }
    const int64_t length = esp_http_client_fetch_headers(http);
    const int status = esp_http_client_get_status_code(http);
    if (status != 200 || length != (int64_t)s_req.size) {
        ESP_LOGE(TAG, "HTTP %d, %lld bytes", status, (long long)length);
        esp_http_client_cleanup(http);
        *why = "下载失败";
        return false;
    }

    const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);
    esp_ota_handle_t ota = 0;
    if (target == NULL || s_req.size > target->size ||
        esp_ota_begin(target, OTA_WITH_SEQUENTIAL_WRITES, &ota) != ESP_OK) {
        esp_http_client_cleanup(http);
        *why = "放不下新固件";
        return false;
    }
    mbedtls_sha256_context sha;
    mbedtls_sha256_init(&sha);
    mbedtls_sha256_starts(&sha, 0);
    uint8_t *buf = malloc(CHUNK);
    uint32_t total = 0;
    bool ok = buf != NULL;
    while (ok && total < s_req.size) {
        const int n = esp_http_client_read(http, (char *)buf, CHUNK);
        if (n <= 0 || total + (uint32_t)n > s_req.size || esp_ota_write(ota, buf, n) != ESP_OK) {
            ok = false;
            *why = "下载中断";
            break;
        }
        mbedtls_sha256_update(&sha, buf, n);
        total += (uint32_t)n;
    }
    free(buf);
    esp_http_client_cleanup(http);
    uint8_t digest[32];
    mbedtls_sha256_finish(&sha, digest);
    mbedtls_sha256_free(&sha);
    if (ok) {
        char hex[65];
        for (int i = 0; i < 32; i++) {
            snprintf(hex + i * 2, 3, "%02x", digest[i]);
        }
        if (strcmp(hex, s_req.sha256) != 0) {
            ESP_LOGE(TAG, "hash mismatch: got %s", hex);
            ok = false;
            *why = "校验不对，已丢弃";
        }
    }
    if (!ok) {
        esp_ota_abort(ota);
        return false;
    }
    if (esp_ota_end(ota) != ESP_OK) { /* also checks the image itself */
        *why = "固件不完整";
        return false;
    }
    if (esp_ota_set_boot_partition(target) != ESP_OK) {
        *why = "切换不了启动分区";
        return false;
    }
    ESP_LOGI(TAG, "installed in %s", target->label);
    return true;
}

void ota_run(void) {
    if (!s_req.pending) {
        return;
    }
    lv_obj_t *before = lv_screen_active();
    lv_obj_t *shown = page("正在更新固件", "大约半分钟，别关机");

    /* Full speed and an awake radio while downloading. */
    esp_pm_lock_handle_t busy = NULL;
    esp_pm_lock_create(ESP_PM_CPU_FREQ_MAX, 0, "ota", &busy);
    if (busy != NULL) esp_pm_lock_acquire(busy);
    esp_wifi_set_ps(WIFI_PS_NONE);
    const int64_t t0 = esp_timer_get_time();
    const char *why = "";
    const bool ok = install(&why);
    esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
    if (busy != NULL) {
        esp_pm_lock_release(busy);
        esp_pm_lock_delete(busy);
    }

    if (ok) {
        ESP_LOGI(TAG, "update took %d ms; restarting", (int)((esp_timer_get_time() - t0) / 1000));
        page("固件更新好了", "正在重启");
        epd_wait_idle(4000);
        esp_restart();
    }
    ESP_LOGE(TAG, "update failed: %s", why);
    lv_obj_t *failed = page("固件更新失败", why);
    lv_obj_delete(shown);
    epd_wait_idle(4000);
    vTaskDelay(pdMS_TO_TICKS(2500));
    epd_hint(CT_REFRESH_FAST);
    lv_screen_load(before);
    lv_obj_delete(failed);
    s_req.pending = false;
}
