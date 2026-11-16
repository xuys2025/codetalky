/*
 * CodeTalky firmware entry: board up, then one UI task that owns LVGL and the
 * ct_ui_* calls. Touch/keys, the network and the panel refresh run in their own
 * tasks and talk to it through app_post().
 */
#include "app.h"
#include "board.h"
#include "ct_ui.h"
#include "epd.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "input.h"
#include "lvgl.h"
#include "net.h"
#include "nvs_flash.h"

static const char *TAG = "main";
static QueueHandle_t s_queue;

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

static void handle(app_event_t *ev) {
    switch (ev->type) {
    case APP_EV_KEY:
        ct_ui_on_key((ct_key_t)ev->a, ev->b != 0);
        break;
    case APP_EV_LINK:
        ct_ui_on_link(ev->a, ev->b != 0);
        break;
    case APP_EV_MSG:
        ct_ui_on_message(ev->a, ev->text, ev->len);
        free(ev->text);
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
    ESP_LOGI(TAG, "UI up; free internal %u KB, PSRAM %u KB",
             (unsigned)(heap_caps_get_free_size(MALLOC_CAP_INTERNAL) / 1024),
             (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024));

    for (;;) {
        uint32_t wait = lv_timer_handler();
        if (wait > 50) wait = 50;
        if (wait < 2) wait = 2;
        app_event_t ev;
        if (xQueueReceive(s_queue, &ev, pdMS_TO_TICKS(wait)) == pdTRUE) {
            handle(&ev);
            /* A burst (the session list after connecting) goes in before the next draw. */
            for (int i = 0; i < 32 && xQueueReceive(s_queue, &ev, 0) == pdTRUE; i++) {
                handle(&ev);
            }
        }
    }
}

void app_main(void) {
    /* Never erase NVS here: it holds the Wi-Fi the vendor firmware saved. */
    esp_err_t err = nvs_flash_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "NVS init failed: %s (settings will not persist)", esp_err_to_name(err));
    }
    board_init();
    s_queue = xQueueCreate(64, sizeof(app_event_t));
    xTaskCreatePinnedToCore(ui_task, "ui", 16 * 1024, NULL, 3, NULL, 1);
}
