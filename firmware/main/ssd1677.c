/*
 * SSD1677 driver for the Metalio E-Ink 4 panel.
 *
 * Init sequence, RAM addressing and waveforms follow the vendor firmware
 * (main/boards/metalio-e-ink-4/display/esp_lcd_panel_ssd1677.c, Apache-2.0).
 * Differences: both RAM planes are always written explicitly before a refresh
 * (no "RAM ping-pong"), every refresh waits for BUSY in the calling task, and the
 * time each refresh takes is measured.
 */
#include "ssd1677.h"

#include <string.h>

#include "board.h"
#include "driver/spi_master.h"
#include "epd_luts.h"
#include "esp_check.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "ssd1677";

#define CMD_DRIVER_OUTPUT 0x01
#define CMD_GATE_VOLTAGE 0x03
#define CMD_SOURCE_VOLTAGE 0x04
#define CMD_BOOSTER 0x0C
#define CMD_DEEP_SLEEP 0x10
#define CMD_DATA_ENTRY 0x11
#define CMD_SWRESET 0x12
#define CMD_TEMP_SENSOR 0x18
#define CMD_ACTIVATE 0x20
#define CMD_UPDATE_CTRL1 0x21
#define CMD_UPDATE_CTRL2 0x22
#define CMD_WRITE_BW 0x24
#define CMD_WRITE_RED 0x26
#define CMD_VCOM 0x2C
#define CMD_WRITE_LUT 0x32
#define CMD_BORDER 0x3C
#define CMD_END_OPTION 0x3F
#define CMD_RAM_X 0x44
#define CMD_RAM_Y 0x45
#define CMD_RAM_X_COUNTER 0x4E
#define CMD_RAM_Y_COUNTER 0x4F

/* 0x22 sequences. With a waveform loaded by the MCU: */
#define UPDATE_FULL_MCU 0xC7    /* clock, analog, display mode 1, off */
#define UPDATE_PARTIAL_MCU 0xCF /* same in display mode 2 (compare old/new planes) */
#define UPDATE_GREY_MCU 0xCC    /* clock, analog, display mode 2, keep them on */
/* Loading the panel's own waveform for the measured temperature: */
#define UPDATE_FULL_OTP 0xF7

#define BUSY_TIMEOUT_MS 10000

typedef enum { LUT_NONE, LUT_FAST, LUT_PARTIAL, LUT_GREY } lut_t;

static esp_lcd_panel_io_handle_t s_io;
static uint8_t *s_dma; /* one plane, internal DMA-capable RAM */
static lut_t s_lut = LUT_NONE;

static esp_err_t cmd(uint8_t c, const void *data, size_t len) {
    return esp_lcd_panel_io_tx_param(s_io, c, data, len);
}

static esp_err_t cmd1(uint8_t c, uint8_t v) {
    return cmd(c, &v, 1);
}

static esp_err_t wait_busy(int *ms) {
    const int64_t t0 = esp_timer_get_time();
    while (gpio_get_level(EPD_PIN_BUSY)) {
        if (esp_timer_get_time() - t0 > (int64_t)BUSY_TIMEOUT_MS * 1000) {
            ESP_LOGE(TAG, "BUSY stuck");
            return ESP_ERR_TIMEOUT;
        }
        vTaskDelay(1);
    }
    if (ms != NULL) {
        *ms = (int)((esp_timer_get_time() - t0) / 1000);
    }
    return ESP_OK;
}

/* Whole panel, X increasing, Y decreasing (as the vendor driver sets it up). */
static esp_err_t ram_window(void) {
    const uint16_t x1 = SSD1677_W - 1;
    const uint16_t y1 = SSD1677_H - 1;
    ESP_RETURN_ON_ERROR(cmd1(CMD_DATA_ENTRY, 0x01), TAG, "entry");
    ESP_RETURN_ON_ERROR(cmd(CMD_RAM_X, (uint8_t[]){0, 0, x1 & 0xFF, x1 >> 8}, 4), TAG, "ram x");
    ESP_RETURN_ON_ERROR(cmd(CMD_RAM_Y, (uint8_t[]){y1 & 0xFF, y1 >> 8, 0, 0}, 4), TAG, "ram y");
    ESP_RETURN_ON_ERROR(cmd(CMD_RAM_X_COUNTER, (uint8_t[]){0, 0}, 2), TAG, "x counter");
    ESP_RETURN_ON_ERROR(cmd(CMD_RAM_Y_COUNTER, (uint8_t[]){y1 & 0xFF, y1 >> 8}, 2), TAG, "y counter");
    return ESP_OK;
}

static esp_err_t write_plane(uint8_t c, const uint8_t *plane) {
    /* ram_window() is a parameter write, which waits for the previous plane's DMA to
     * finish, so the bounce buffer is free again before it is refilled. */
    ESP_RETURN_ON_ERROR(ram_window(), TAG, "window");
    memcpy(s_dma, plane, SSD1677_PLANE_BYTES);
    return esp_lcd_panel_io_tx_color(s_io, c, s_dma, SSD1677_PLANE_BYTES);
}

esp_err_t ssd1677_load(const uint8_t *new_plane, const uint8_t *old_plane) {
    if (old_plane != NULL) {
        ESP_RETURN_ON_ERROR(write_plane(CMD_WRITE_RED, old_plane), TAG, "old plane");
    }
    if (new_plane != NULL) {
        ESP_RETURN_ON_ERROR(write_plane(CMD_WRITE_BW, new_plane), TAG, "new plane");
    }
    return ESP_OK;
}

static esp_err_t load_lut(const uint8_t *lut, lut_t which) {
    if (s_lut == which) {
        return ESP_OK;
    }
    ESP_RETURN_ON_ERROR(cmd1(CMD_VCOM, lut[109]), TAG, "vcom");
    ESP_RETURN_ON_ERROR(cmd1(CMD_GATE_VOLTAGE, lut[105]), TAG, "gate");
    ESP_RETURN_ON_ERROR(cmd(CMD_SOURCE_VOLTAGE, &lut[106], 3), TAG, "source");
    ESP_RETURN_ON_ERROR(cmd(CMD_WRITE_LUT, lut, EPD_LUT_WAVE_BYTES), TAG, "lut");
    ESP_RETURN_ON_ERROR(wait_busy(NULL), TAG, "lut busy");
    s_lut = which;
    return ESP_OK;
}

esp_err_t ssd1677_refresh(ssd1677_mode_t mode, int *ms) {
    uint8_t seq;
    switch (mode) {
    case SSD1677_PARTIAL:
        /* Border floats during partial refreshes so the frame does not flicker. */
        ESP_RETURN_ON_ERROR(cmd1(CMD_BORDER, 0x80), TAG, "border");
        ESP_RETURN_ON_ERROR(load_lut(kLutPartial, LUT_PARTIAL), TAG, "partial lut");
        seq = UPDATE_PARTIAL_MCU;
        break;
    case SSD1677_FULL_FAST:
        ESP_RETURN_ON_ERROR(load_lut(kLutFast, LUT_FAST), TAG, "fast lut");
        seq = UPDATE_FULL_MCU;
        break;
    case SSD1677_FULL:
        seq = UPDATE_FULL_OTP;
        break;
    case SSD1677_GREY:
        ESP_RETURN_ON_ERROR(load_lut(kLutGrey, LUT_GREY), TAG, "grey lut");
        ESP_RETURN_ON_ERROR(cmd1(CMD_UPDATE_CTRL1, 0x00), TAG, "ctrl1");
        seq = UPDATE_GREY_MCU;
        break;
    default:
        return ESP_ERR_INVALID_ARG;
    }
    ESP_RETURN_ON_ERROR(cmd1(CMD_UPDATE_CTRL2, seq), TAG, "ctrl2");
    ESP_RETURN_ON_ERROR(cmd(CMD_ACTIVATE, NULL, 0), TAG, "activate");
    esp_err_t err = wait_busy(ms);
    if (mode == SSD1677_FULL) {
        s_lut = LUT_NONE; /* the panel loaded its own waveform over ours */
    }
    if (mode == SSD1677_FULL || mode == SSD1677_FULL_FAST) {
        cmd1(CMD_END_OPTION, 0x01);
    }
    return err;
}

esp_err_t ssd1677_sleep(void) {
    return cmd1(CMD_DEEP_SLEEP, 0x01);
}

static esp_err_t panel_reset_and_setup(void) {
    gpio_set_level(EPD_PIN_RST, 0);
    vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(EPD_PIN_RST, 1);
    vTaskDelay(pdMS_TO_TICKS(10));
    ESP_RETURN_ON_ERROR(wait_busy(NULL), TAG, "reset busy");

    ESP_RETURN_ON_ERROR(cmd(CMD_SWRESET, NULL, 0), TAG, "swreset");
    vTaskDelay(pdMS_TO_TICKS(10));
    ESP_RETURN_ON_ERROR(wait_busy(NULL), TAG, "swreset busy");
    s_lut = LUT_NONE;
    ESP_RETURN_ON_ERROR(cmd1(CMD_TEMP_SENSOR, 0x80), TAG, "temp sensor");
    ESP_RETURN_ON_ERROR(cmd(CMD_BOOSTER, (uint8_t[]){0xAE, 0xC7, 0xC3, 0xC0, 0x80}, 5), TAG, "booster");
    ESP_RETURN_ON_ERROR(cmd(CMD_DRIVER_OUTPUT, (uint8_t[]){(SSD1677_H - 1) & 0xFF, (SSD1677_H - 1) >> 8, 0x02}, 3),
                        TAG, "driver output");
    ESP_RETURN_ON_ERROR(cmd1(CMD_BORDER, 0x01), TAG, "border");
    ESP_RETURN_ON_ERROR(load_lut(kLutFast, LUT_FAST), TAG, "lut");
    return ram_window();
}

esp_err_t ssd1677_init(void) {
    if (s_io == NULL) {
        const spi_bus_config_t bus = {
            .mosi_io_num = EPD_PIN_MOSI,
            .miso_io_num = -1,
            .sclk_io_num = EPD_PIN_SCLK,
            .quadwp_io_num = -1,
            .quadhd_io_num = -1,
            .max_transfer_sz = 32 * 1024,
        };
        ESP_RETURN_ON_ERROR(spi_bus_initialize(EPD_SPI_HOST, &bus, SPI_DMA_CH_AUTO), TAG, "spi bus");
        const esp_lcd_panel_io_spi_config_t io_cfg = {
            .cs_gpio_num = EPD_PIN_CS,
            .dc_gpio_num = EPD_PIN_DC,
            .spi_mode = 0,
            .pclk_hz = EPD_SPI_HZ,
            .trans_queue_depth = 10,
            .lcd_cmd_bits = 8,
            .lcd_param_bits = 8,
        };
        ESP_RETURN_ON_ERROR(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)EPD_SPI_HOST, &io_cfg, &s_io), TAG,
                            "panel io");
        s_dma = heap_caps_malloc(SSD1677_PLANE_BYTES, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
        ESP_RETURN_ON_FALSE(s_dma != NULL, ESP_ERR_NO_MEM, TAG, "dma buffer");

        /* RST push-pull and idle high: open drain leaves the panel in reset. */
        const gpio_config_t rst = {.pin_bit_mask = 1ULL << EPD_PIN_RST, .mode = GPIO_MODE_OUTPUT};
        gpio_config(&rst);
        gpio_set_level(EPD_PIN_RST, 1);
        const gpio_config_t busy = {
            .pin_bit_mask = 1ULL << EPD_PIN_BUSY,
            .mode = GPIO_MODE_INPUT,
            .pull_down_en = GPIO_PULLDOWN_ENABLE,
        };
        gpio_config(&busy);
    }
    ESP_RETURN_ON_ERROR(panel_reset_and_setup(), TAG, "setup");
    ESP_LOGI(TAG, "panel ready");
    return ESP_OK;
}
