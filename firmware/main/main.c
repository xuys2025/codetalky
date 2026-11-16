/*
 * CodeTalky firmware entry: board up, then one UI task that owns LVGL and the
 * ct_ui_* calls. Touch/keys, the network and the panel refresh run in their own
 * tasks and talk to it through app_post().
 */
#include "app.h"
#include "board.h"
#include "charger.h"
#include "ct_ui.h"
#include "epd.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_pm.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "input.h"
#include "lvgl.h"
#include "net.h"
#include "nvs_flash.h"
#include "ota.h"

static const char *TAG = "main";
static QueueHandle_t s_queue;
static esp_pm_lock_handle_t s_busy; /* full CPU speed while the UI works */

bool app_post(const app_event_t *ev) {
    if (s_queue != NULL && xQueueSend(s_queue, ev, pdMS_TO_TICKS(100)) == pdTRUE) {
        return true;
    }
    ESP_LOGW(TAG, "UI queue full, dropped event %d", ev->type);
    free(ev->text);
    return false;
}

static uint32_t tick_ms(void) {
    return (uint32_t)(esp_timer_get_time() / 1000);
}

/* A last page, since e-ink keeps showing whatever was on it, then power off. */
static void power_off(bool battery_empty) {
    ESP_LOGW(TAG, "%s", battery_empty ? "battery empty: switching off" : "switching off");
    const int64_t t0 = esp_timer_get_time();
    epd_hint_clean();
    ct_ui_show_off(battery_empty);
    lv_refr_now(NULL);
    ESP_LOGI(TAG, "last page rendered in %d ms", (int)((esp_timer_get_time() - t0) / 1000));
    if (epd_finish(9000)) {
        ESP_LOGI(TAG, "last page drawn in %d ms", (int)((esp_timer_get_time() - t0) / 1000));
    } else {
        ESP_LOGW(TAG, "panel still busy; switching off anyway");
    }
    vTaskDelay(pdMS_TO_TICKS(300)); /* lets the log above reach the computer */
    if (battery_empty) {
        charger_battery_off();
    }
    board_power_off();
}

static void handle(app_event_t *ev) {
    switch (ev->type) {
    case APP_EV_KEY:
        ct_ui_on_key((ct_key_t)ev->a, ev->b != 0);
        break;
    case APP_EV_LINK:
        if (ev->b != 0) {
            ota_confirm(); /* a new build that reaches a computer is kept */
        }
        ct_ui_on_link(ev->a, ev->b != 0);
        break;
    case APP_EV_MSG:
        ct_ui_on_message(ev->a, ev->text, ev->len);
        free(ev->text);
        break;
    case APP_EV_POWER_OFF:
        power_off(ev->a == 1);
        break;
    case APP_EV_UPDATE:
        ota_run();
        break;
    }
}

static void ui_task(void *arg) {
    (void)arg;
    lv_init();
    lv_tick_set_cb(tick_ms);
    epd_init();
    input_init();
    ct_ui_init();
    net_init();
    ESP_LOGI(TAG, "UI up, firmware %s; free internal %u KB, PSRAM %u KB", ota_version(),
             (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024),
             (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024));

    for (;;) {
        esp_pm_lock_acquire(s_busy);
        uint32_t wait = lv_timer_handler();
        esp_pm_lock_release(s_busy);
        if (wait > 50) wait = 50;
        if (wait < 2) wait = 2;
        app_event_t ev;
        if (xQueueReceive(s_queue, &ev, pdMS_TO_TICKS(wait)) == pdTRUE) {
            esp_pm_lock_acquire(s_busy);
            handle(&ev);
            /* A burst (the session list after connecting) goes in before the next draw. */
            for (int i = 0; i < 32 && xQueueReceive(s_queue, &ev, 0) == pdTRUE; i++) {
                handle(&ev);
            }
            esp_pm_lock_release(s_busy);
        }
    }
}

void app_main(void) {
    /* Never erase NVS here: it holds the Wi-Fi the vendor firmware saved. */
    esp_err_t err = nvs_flash_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "NVS init failed: %s (settings will not persist)", esp_err_to_name(err));
    }
    /* Idle at 80 MHz (APB stays at 80, so USB, SPI and I2C are unaffected); no light
     * sleep yet: it needs touch and keys to wake the chip, still to do. */
    const esp_pm_config_t pm = {.max_freq_mhz = 240, .min_freq_mhz = 80, .light_sleep_enable = false};
    err = esp_pm_configure(&pm);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "power management: %s", esp_err_to_name(err));
    }
    esp_pm_lock_create(ESP_PM_CPU_FREQ_MAX, 0, "ui", &s_busy);
    ota_boot();
    board_init();
    s_queue = xQueueCreate(64, sizeof(app_event_t));
    xTaskCreatePinnedToCore(ui_task, "ui", 16 * 1024, NULL, 3, NULL, 1);
}
