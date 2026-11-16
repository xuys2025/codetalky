/*
 * The microphone. See audio.h.
 */
#include "audio.h"

#include <math.h>
#include <string.h>

#include "driver/i2s_std.h"
#include "driver/uart.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_pm.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "audio";

#define BT_UART UART_NUM_2
#define BT_TX GPIO_NUM_48
#define BT_RX GPIO_NUM_47
#define I2S_BCLK GPIO_NUM_6
#define I2S_WS GPIO_NUM_43
#define I2S_DIN GPIO_NUM_17

static i2s_chan_handle_t s_rx;
static audio_sink_t s_sink;
static TaskHandle_t s_task;
static volatile bool s_want; /* capture wanted */
static esp_pm_lock_handle_t s_busy;

/* Lines the audio chip sends back, for the log. */
static void log_replies(int wait_ms) {
    char line[96];
    size_t n = 0;
    uint8_t c;
    const TickType_t until = xTaskGetTickCount() + pdMS_TO_TICKS(wait_ms);
    while (xTaskGetTickCount() < until) {
        if (uart_read_bytes(BT_UART, &c, 1, pdMS_TO_TICKS(50)) != 1) {
            continue;
        }
        if (c == '\r' || c == '\n') {
            if (n > 0) {
                line[n] = '\0';
                ESP_LOGI(TAG, "chip: %s", line);
                n = 0;
            }
        } else if (n < sizeof(line) - 1) {
            line[n++] = (c >= 0x20 && c < 0x7f) ? (char)c : '.';
        }
    }
}

static void at(const char *cmd) {
    ESP_LOGI(TAG, "to chip: %s", cmd);
    uart_write_bytes(BT_UART, cmd, strlen(cmd));
    uart_write_bytes(BT_UART, "\r\n", 2);
}

/* Mode 1, as the vendor firmware sets it at start-up. */
static void chip_setup(void) {
    log_replies(300);
    at("AT+RX=2");
    log_replies(700);
    at("AT+MODE=1");
    log_replies(1500);
}

static void capture_task(void *arg) {
    (void)arg;
    chip_setup();
    const size_t frame_bytes = AUDIO_CHUNK_SAMPLES * 2 * sizeof(int32_t);
    int32_t *frames = heap_caps_malloc(frame_bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
    int16_t *pcm = heap_caps_malloc(AUDIO_CHUNK_SAMPLES * sizeof(int16_t), MALLOC_CAP_INTERNAL);
    if (frames == NULL || pcm == NULL) {
        ESP_LOGE(TAG, "out of memory");
        vTaskDelete(NULL);
        return;
    }
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        if (!s_want) {
            continue;
        }
        esp_pm_lock_acquire(s_busy);
        if (i2s_channel_enable(s_rx) != ESP_OK) {
            ESP_LOGE(TAG, "I2S enable failed");
            esp_pm_lock_release(s_busy);
            continue;
        }
        ESP_LOGI(TAG, "capturing");
        unsigned chunks = 0, timeouts = 0;
        double sum = 0;
        int peak = 0;
        while (s_want) {
            size_t got = 0;
            const esp_err_t err = i2s_channel_read(s_rx, frames, frame_bytes, &got, pdMS_TO_TICKS(200));
            if (err != ESP_OK || got < frame_bytes) {
                if (++timeouts == 1 || timeouts % 10 == 0) {
                    ESP_LOGW(TAG, "no audio from the chip (%s, %u bytes)", esp_err_to_name(err), (unsigned)got);
                }
                continue;
            }
            /* The top 16 bits of the left slot. (The vendor shifts by 12 only: 16 times
             * louder, and speech close up then clips; measured 2026-11-16, quiet room
             * about 6, speech 1300 to 4500 RMS, peaks to 17500 of 32767.) */
            for (int i = 0; i < AUDIO_CHUNK_SAMPLES; i++) {
                const int32_t l = frames[2 * i] >> 16;
                pcm[i] = (int16_t)(l > INT16_MAX ? INT16_MAX : l < -INT16_MAX ? -INT16_MAX : l);
                sum += (double)l * l;
                const int a = l < 0 ? -l : l;
                if (a > peak) peak = a;
            }
            chunks++;
            if (s_sink != NULL) {
                s_sink(pcm, AUDIO_CHUNK_SAMPLES);
            }
        }
        i2s_channel_disable(s_rx);
        esp_pm_lock_release(s_busy);
        ESP_LOGI(TAG, "stopped after %u ms: level %d RMS, peak %d", chunks * 1000 * AUDIO_CHUNK_SAMPLES / AUDIO_RATE,
                 chunks > 0 ? (int)sqrt(sum / ((double)chunks * AUDIO_CHUNK_SAMPLES)) : 0, peak);
    }
}

void audio_init(audio_sink_t sink) {
    s_sink = sink;
    const uart_config_t uart = {
        .baud_rate = 115200,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    if (uart_driver_install(BT_UART, 1024, 0, 0, NULL, 0) != ESP_OK || uart_param_config(BT_UART, &uart) != ESP_OK ||
        uart_set_pin(BT_UART, BT_TX, BT_RX, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK) {
        ESP_LOGE(TAG, "audio chip UART failed");
        return;
    }

    /* The chip is the master: it drives BCLK and WS. */
    i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_SLAVE);
    chan.dma_desc_num = 6;
    chan.dma_frame_num = 240;
    if (i2s_new_channel(&chan, NULL, &s_rx) != ESP_OK) {
        ESP_LOGE(TAG, "I2S channel failed");
        return;
    }
    i2s_std_config_t std = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(AUDIO_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = I2S_BCLK,
            .ws = I2S_WS,
            .dout = I2S_GPIO_UNUSED,
            .din = I2S_DIN,
        },
    };
    /* As the vendor's codec: left aligned, 32-bit WS. */
    std.slot_cfg.ws_width = I2S_DATA_BIT_WIDTH_32BIT;
    std.slot_cfg.left_align = true;
    if (i2s_channel_init_std_mode(s_rx, &std) != ESP_OK) {
        ESP_LOGE(TAG, "I2S setup failed");
        return;
    }
    esp_pm_lock_create(ESP_PM_CPU_FREQ_MAX, 0, "audio", &s_busy);
    xTaskCreatePinnedToCore(capture_task, "audio", 4096, NULL, 5, &s_task, 1);
}

bool audio_start(void) {
    if (s_task == NULL) {
        return false;
    }
    s_want = true;
    xTaskNotifyGive(s_task);
    return true;
}

void audio_stop(void) {
    s_want = false;
}
