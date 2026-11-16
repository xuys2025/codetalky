/*
 * Touch, touch keys and physical keys. See input.h.
 *
 * The CST816S reports the screen in the UI's own portrait coordinates (480 x 800);
 * the three keys printed below the screen come back as fixed points at y = 900
 * (vendor config.h: HOME x 80, NEXT x 240, PREV x 400).
 */
#include "input.h"

#include <string.h>

#include "app.h"
#include "board.h"
#include "ct_ui.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "input";

#define TOUCH_ADDR 0x15
#define SAMPLE_MS 10
#define POWER_OFF_HOLD_MS 3000
#define EDGE_QUEUE 16

static i2c_master_dev_handle_t s_touch;
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

/* Touch edges for LVGL, guarded by s_mux. */
static struct {
    bool live;               /* finger on the screen now */
    int16_t live_x, live_y;
    int16_t down_x[EDGE_QUEUE], down_y[EDGE_QUEUE];
    uint8_t down_head, downs; /* presses not yet given to LVGL */
    uint8_t ups;              /* releases not yet given to LVGL */
    bool lvgl_down;           /* what LVGL was last told */
    int16_t last_x, last_y;
} s_t;

static void post_key(ct_key_t key, bool down) {
    const app_event_t ev = {.type = APP_EV_KEY, .a = key, .b = down};
    app_post(&ev);
}

static bool touch_read(int *x, int *y) {
    uint8_t reg = 0x02;
    uint8_t buf[5];
    if (s_touch == NULL || i2c_master_transmit_receive(s_touch, &reg, 1, buf, sizeof(buf), 20) != ESP_OK) {
        return false;
    }
    if ((buf[0] & 0x0F) == 0) {
        return false;
    }
    *x = ((buf[1] & 0x0F) << 8) | buf[2];
    *y = ((buf[3] & 0x0F) << 8) | buf[4];
    return true;
}

static ct_key_t touch_key_at(int x) {
    return x < 160 ? CT_KEY_HOME : x < 320 ? CT_KEY_NEXT : CT_KEY_PREV;
}

static void touch_sample(void) {
    static bool was_down;
    static int key = -1; /* touch key held, or -1 */
    int x = 0, y = 0;
    const bool down = touch_read(&x, &y);

    const bool on_key = down && y >= 800;
    const int now_key = on_key ? (int)touch_key_at(x) : -1;
    if (now_key != key) {
        if (key >= 0) post_key((ct_key_t)key, false);
        if (now_key >= 0) post_key((ct_key_t)now_key, true);
        key = now_key;
    }
    const bool on_screen = down && !on_key;

    portENTER_CRITICAL(&s_mux);
    if (on_screen) {
        if (!was_down && s_t.downs < EDGE_QUEUE) {
            const uint8_t i = (uint8_t)((s_t.down_head + s_t.downs) % EDGE_QUEUE);
            s_t.down_x[i] = (int16_t)x;
            s_t.down_y[i] = (int16_t)y;
            s_t.downs++;
        }
        s_t.live = true;
        s_t.live_x = (int16_t)x;
        s_t.live_y = (int16_t)y;
    } else if (was_down) {
        s_t.live = false;
        if (s_t.ups < EDGE_QUEUE) s_t.ups++;
    }
    portEXIT_CRITICAL(&s_mux);
    was_down = on_screen;
}

/* LVGL asks: deliver one edge per read so taps shorter than a read period survive. */
static void pointer_read(lv_indev_t *indev, lv_indev_data_t *data) {
    (void)indev;
    portENTER_CRITICAL(&s_mux);
    if (s_t.lvgl_down) {
        if (s_t.ups > 0) {
            s_t.ups--;
            s_t.lvgl_down = false;
        } else if (s_t.live) {
            s_t.last_x = s_t.live_x;
            s_t.last_y = s_t.live_y;
        } else {
            s_t.lvgl_down = false; /* lost a release: don't leave LVGL pressed */
        }
    } else if (s_t.downs > 0) {
        s_t.last_x = s_t.down_x[s_t.down_head];
        s_t.last_y = s_t.down_y[s_t.down_head];
        s_t.down_head = (uint8_t)((s_t.down_head + 1) % EDGE_QUEUE);
        s_t.downs--;
        s_t.lvgl_down = true;
        /* A press with its release already queued and the finger gone: the next read
         * delivers the release. */
    }
    data->point.x = s_t.last_x;
    data->point.y = s_t.last_y;
    data->state = s_t.lvgl_down ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
    data->continue_reading = s_t.downs > 0 || (s_t.lvgl_down && s_t.ups > 0);
    portEXIT_CRITICAL(&s_mux);
}

typedef struct {
    ct_key_t key;
    bool down;     /* debounced state */
    uint8_t count; /* samples the raw state has disagreed with it */
} key_state_t;

static void key_update(key_state_t *k, bool raw) {
    if (raw == k->down) {
        k->count = 0;
        return;
    }
    if (++k->count >= 2) {
        k->down = raw;
        k->count = 0;
        post_key(k->key, raw);
    }
}

static void input_task(void *arg) {
    (void)arg;
    key_state_t boot = {.key = CT_KEY_BOOT}, power = {.key = CT_KEY_POWER};
    key_state_t vol_up = {.key = CT_KEY_VOL_UP}, vol_down = {.key = CT_KEY_VOL_DOWN};
    /* The power key is often still held from switching the device on: ignore it until released. */
    bool power_armed = gpio_get_level(POWER_KEY_PIN) != 0;
    int64_t power_down_at = 0;
    unsigned tick = 0;
    for (;;) {
        touch_sample();

        key_update(&boot, gpio_get_level(BOOT_KEY_PIN) == 0);
        const bool power_raw = gpio_get_level(POWER_KEY_PIN) == 0;
        if (!power_armed) {
            power_armed = !power_raw;
        } else {
            const bool was = power.down;
            key_update(&power, power_raw);
            if (power.down && !was) {
                power_down_at = esp_timer_get_time();
            } else if (power.down && esp_timer_get_time() - power_down_at > POWER_OFF_HOLD_MS * 1000LL) {
                board_vibrate(200);
                vTaskDelay(pdMS_TO_TICKS(300));
                board_power_off();
            }
        }
        if (tick % 2 == 0) {
            uint16_t xp;
            if (board_xp_inputs(&xp)) {
                key_update(&vol_down, (xp & (1u << XP_VOL_DOWN)) == 0);
                key_update(&vol_up, (xp & (1u << XP_VOL_UP)) == 0);
            }
        }
        if (tick % 500 == 0) {
            board_battery_poll();
        }
        tick++;
        vTaskDelay(pdMS_TO_TICKS(SAMPLE_MS));
    }
}

lv_indev_t *input_init(void) {
    i2c_master_bus_handle_t bus = board_i2c();
    if (i2c_master_probe(bus, TOUCH_ADDR, 200) == ESP_OK) {
        const i2c_device_config_t cfg = {
            .dev_addr_length = I2C_ADDR_BIT_LEN_7,
            .device_address = TOUCH_ADDR,
            .scl_speed_hz = 400000,
        };
        i2c_master_bus_add_device(bus, &cfg, &s_touch);
        ESP_LOGI(TAG, "touch controller found");
    } else {
        ESP_LOGE(TAG, "no touch controller at 0x%02x", TOUCH_ADDR);
    }
    const gpio_config_t irq = {.pin_bit_mask = 1ULL << TOUCH_PIN_INT, .mode = GPIO_MODE_INPUT,
                               .pull_up_en = GPIO_PULLUP_ENABLE};
    gpio_config(&irq);

    lv_indev_t *indev = lv_indev_create();
    lv_indev_set_type(indev, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(indev, pointer_read);
    xTaskCreatePinnedToCore(input_task, "input", 4096, NULL, 6, NULL, 1);
    return indev;
}
