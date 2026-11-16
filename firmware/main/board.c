/*
 * Board bring-up: power rails, I2C, port expander (TCA9555), motor, fuel gauge.
 * Sequence and values follow the vendor firmware (metalio_io_expander.cc,
 * metalio_touch.c, metalio_vibe.cc, bq27220_gauge.cc).
 */
#include "board.h"

#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "board";

#define TCA9555_ADDR 0x20
#define BQ27220_ADDR 0x55
#define BQ27220_REG_VOLTAGE 0x08
#define I2C_HZ 400000
#define I2C_TIMEOUT_MS 50

/* The fuel gauge reading the vendor firmware treats as empty and full. */
#define BATTERY_EMPTY_MV 3300
#define BATTERY_FULL_MV 4330

static i2c_master_bus_handle_t s_bus;
static i2c_master_dev_handle_t s_xp;
static i2c_master_dev_handle_t s_gauge;
static uint16_t s_xp_out = 0xFFFF;
static esp_timer_handle_t s_motor_timer;
static volatile int s_battery = -1;
static int s_battery_mv_avg;

/* A device left mid-transfer by a reset can hold SDA low: clock it free, then STOP. */
static void i2c_recover_pins(void) {
    const gpio_config_t conf = {
        .pin_bit_mask = (1ULL << I2C_PIN_SDA) | (1ULL << I2C_PIN_SCL),
        .mode = GPIO_MODE_INPUT_OUTPUT_OD,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&conf);
    gpio_set_level(I2C_PIN_SDA, 1);
    gpio_set_level(I2C_PIN_SCL, 1);
    esp_rom_delay_us(10);
    for (int i = 0; i < 9 && gpio_get_level(I2C_PIN_SDA) == 0; i++) {
        gpio_set_level(I2C_PIN_SCL, 0);
        esp_rom_delay_us(5);
        gpio_set_level(I2C_PIN_SCL, 1);
        esp_rom_delay_us(5);
    }
    gpio_set_level(I2C_PIN_SDA, 0);
    esp_rom_delay_us(5);
    gpio_set_level(I2C_PIN_SCL, 1);
    esp_rom_delay_us(5);
    gpio_set_level(I2C_PIN_SDA, 1);
    esp_rom_delay_us(5);
}

static esp_err_t add_device(uint16_t addr, i2c_master_dev_handle_t *dev) {
    const i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = addr,
        .scl_speed_hz = I2C_HZ,
    };
    return i2c_master_bus_add_device(s_bus, &cfg, dev);
}

static esp_err_t xp_write16(uint8_t reg, uint16_t value) {
    const uint8_t buf[3] = {reg, (uint8_t)(value & 0xFF), (uint8_t)(value >> 8)};
    return i2c_master_transmit(s_xp, buf, sizeof(buf), I2C_TIMEOUT_MS);
}

static esp_err_t xp_read16(uint8_t reg, uint16_t *value) {
    uint8_t buf[2];
    esp_err_t err = i2c_master_transmit_receive(s_xp, &reg, 1, buf, 2, I2C_TIMEOUT_MS);
    if (err == ESP_OK) {
        *value = (uint16_t)(buf[0] | (buf[1] << 8));
    }
    return err;
}

static esp_err_t xp_set(int pin, bool high) {
    if (high) {
        s_xp_out |= (uint16_t)(1u << pin);
    } else {
        s_xp_out &= (uint16_t)~(1u << pin);
    }
    return xp_write16(0x02, s_xp_out);
}

bool board_xp_inputs(uint16_t *levels) {
    return s_xp != NULL && xp_read16(0x00, levels) == ESP_OK;
}

static esp_err_t xp_init(void) {
    /* Power-up glitches can leave the bus stuck: probe with a short timeout, reset, retry. */
    esp_err_t err = ESP_FAIL;
    for (int i = 0; i < 10; i++) {
        if (i > 0) {
            vTaskDelay(pdMS_TO_TICKS(30 * i));
            i2c_master_bus_reset(s_bus);
        }
        err = i2c_master_probe(s_bus, TCA9555_ADDR, 100);
        if (err == ESP_OK) {
            break;
        }
    }
    ESP_RETURN_ON_ERROR(err, TAG, "TCA9555 not answering");
    ESP_RETURN_ON_ERROR(add_device(TCA9555_ADDR, &s_xp), TAG, "TCA9555 add");

    const uint16_t outputs = (1u << XP_USB_MUX) | (1u << XP_PA_SWITCH) | (1u << XP_PA) | (1u << XP_SCREEN_PWR) |
                             (1u << XP_MAIN_PWR) | (1u << XP_TOUCH_RST) | (1u << XP_PWR_PULSE);
    /* Keep whatever the rails are at, then set every output before it becomes one, so
     * the main rail and the panel never see a low pulse. */
    uint16_t current = 0xFFFF;
    xp_read16(0x02, &current);
    s_xp_out = current;
    s_xp_out |= (1u << XP_MAIN_PWR) | (1u << XP_SCREEN_PWR) | (1u << XP_USB_MUX) | (1u << XP_PWR_PULSE) |
                (1u << XP_TOUCH_RST);
    s_xp_out &= (uint16_t)~((1u << XP_PA) | (1u << XP_PA_SWITCH));
    ESP_RETURN_ON_ERROR(xp_write16(0x02, s_xp_out), TAG, "TCA9555 outputs");
    ESP_RETURN_ON_ERROR(xp_write16(0x06, (uint16_t)~outputs), TAG, "TCA9555 directions");

    /* Touch controller reset: low >= 5 ms, then >= 100 ms before it answers. */
    xp_set(XP_TOUCH_RST, false);
    vTaskDelay(pdMS_TO_TICKS(10));
    xp_set(XP_TOUCH_RST, true);
    vTaskDelay(pdMS_TO_TICKS(120));
    ESP_LOGI(TAG, "rails on, USB to debug port, touch reset done");
    return ESP_OK;
}

static void motor_off(void *arg) {
    (void)arg;
    gpio_set_level(MOTOR_PIN, 0);
}

void board_vibrate(uint16_t ms) {
    if (s_motor_timer == NULL || ms == 0) {
        return;
    }
    gpio_set_level(MOTOR_PIN, 1);
    esp_timer_stop(s_motor_timer);
    esp_timer_start_once(s_motor_timer, (uint64_t)ms * 1000);
}

static void motor_init(void) {
    const gpio_config_t conf = {
        .pin_bit_mask = 1ULL << MOTOR_PIN,
        .mode = GPIO_MODE_OUTPUT,
    };
    gpio_config(&conf);
    gpio_set_level(MOTOR_PIN, 0);
    const esp_timer_create_args_t args = {
        .callback = motor_off,
        .name = "motor",
    };
    esp_timer_create(&args, &s_motor_timer);
}

static bool gauge_millivolts(int *mv) {
    if (s_gauge == NULL) {
        return false;
    }
    uint8_t reg = BQ27220_REG_VOLTAGE;
    uint8_t buf[2];
    if (i2c_master_transmit_receive(s_gauge, &reg, 1, buf, 2, I2C_TIMEOUT_MS) != ESP_OK) {
        return false;
    }
    *mv = buf[0] | (buf[1] << 8);
    return *mv > 2000 && *mv < 5000;
}

void board_battery_poll(void) {
    int mv;
    if (!gauge_millivolts(&mv)) {
        return;
    }
    /* Smooth over about a minute of readings: load (the panel, Wi-Fi) makes it jump. */
    s_battery_mv_avg = s_battery_mv_avg == 0 ? mv * 16 : s_battery_mv_avg - s_battery_mv_avg / 16 + mv;
    const int avg = s_battery_mv_avg / 16;
    int pct = (avg - BATTERY_EMPTY_MV) * 100 / (BATTERY_FULL_MV - BATTERY_EMPTY_MV);
    s_battery = pct < 0 ? 0 : pct > 100 ? 100 : pct;
}

int board_battery_percent(void) {
    return s_battery;
}

i2c_master_bus_handle_t board_i2c(void) {
    return s_bus;
}

void board_power_off(void) {
    ESP_LOGW(TAG, "power off");
    for (;;) {
        xp_set(XP_PWR_PULSE, true);
        vTaskDelay(pdMS_TO_TICKS(100));
        xp_set(XP_PWR_PULSE, false);
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

void board_init(void) {
    i2c_recover_pins();
    const i2c_master_bus_config_t bus_cfg = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = I2C_PIN_SDA,
        .scl_io_num = I2C_PIN_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = 1,
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&bus_cfg, &s_bus));
    if (xp_init() != ESP_OK) {
        ESP_LOGE(TAG, "no port expander: no volume keys, touch may not work");
    }
    motor_init();

    const gpio_config_t keys = {
        .pin_bit_mask = (1ULL << BOOT_KEY_PIN) | (1ULL << POWER_KEY_PIN),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&keys);

    if (i2c_master_probe(s_bus, BQ27220_ADDR, 50) == ESP_OK && add_device(BQ27220_ADDR, &s_gauge) == ESP_OK) {
        board_battery_poll();
        ESP_LOGI(TAG, "fuel gauge: %d%%", s_battery);
    } else {
        ESP_LOGW(TAG, "no fuel gauge");
    }
}
