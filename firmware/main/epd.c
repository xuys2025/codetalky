/*
 * LVGL -> e-ink. See epd.h for the rule this follows.
 *
 * LVGL renders RGB565 into a full-screen buffer (direct mode, as in the simulator).
 * Each flushed area is turned into grey levels 0..3 (the simulator's thresholds:
 * 0 black, 1 dark grey, 2 light grey, 3 white) and merged into the target image.
 * The refresh task shows it in two passes, like the vendor firmware's reader:
 *
 * 1. Black and white. Every pixel that is not white is drawn black. (A 50%
 *    threshold made text too thin on the real panel; all-black is legible but
 *    jagged, 2026-11-16.)
 * 2. Grey overlay, once the screen has been still for OVERLAY_DELAY_MS: the grey
 *    waveform lightens the black edge pixels of glyphs to light or dark grey.
 *
 * The task keeps the level each pixel physically shows (s_phys) and refreshes only
 * what differs from the target. A partial refresh drives only the pixels that
 * change; every other pixel goes to the panel as white->white, which the waveform
 * leaves alone. (Its black->black "keep black" pulse would darken grey pixels back,
 * and on static black it built up charge that brought old screens back as ghosts.)
 *
 * Panel plane bits: 1 = white. The partial waveform is indexed by (old, new):
 * B->B keep-black pulse, B->W drive white, W->B drive black, W->W nothing. The grey
 * waveform by (0x26, 0x24): (1,0) lightens a lot = light grey, (1,1) less = dark
 * grey, (0,0) nothing.
 */
#include "epd.h"

#include <string.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_pm.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "ssd1677.h"

static const char *TAG = "epd";

#define W EPD_UI_W
#define H EPD_UI_H
#define OVERLAY_DELAY_MS 450

typedef struct {
    int x1, y1, x2, y2; /* inclusive; x2 < 0 means empty */
} rect_t;

static uint16_t *s_fb;    /* LVGL draws here (PSRAM) */
static uint8_t *s_target; /* grey level per UI pixel, what LVGL wants shown */
static uint8_t *s_phys;   /* grey level per UI pixel, what the panel physically shows */
/* Panel planes (landscape, 1 bit per pixel): */
static uint8_t *s_plane; /* black-and-white image of the target */
static uint8_t *s_ram_a; /* scratch: what goes to the controller's two RAM planes */
static uint8_t *s_ram_b;
static SemaphoreHandle_t s_lock;
static TaskHandle_t s_task;
static esp_pm_lock_handle_t s_busy; /* full CPU speed while converting a frame */
static EventGroupHandle_t s_state;
#define EPD_IDLE BIT0 /* nothing pending, no grey pass owed */

/* Guarded by s_lock: */
static rect_t s_dirty = {0, 0, -1, -1};
static ct_refresh_t s_pending = CT_REFRESH_PARTIAL;
static bool s_have_frame;
static bool s_clean;  /* wipe the panel black and white before the pending full refresh */
static bool s_off; /* epd_finish() ran: the panel is asleep, draw nothing more */

/* Only the UI task touches these. The first frame is a clean full refresh. */
static ct_refresh_t s_hint = CT_REFRESH_FULL;
static bool s_clean_hint;

static const char *const MODE_NAMES[] = {"partial", "fast", "full"};

void epd_hint(ct_refresh_t mode) {
    if (mode > s_hint) {
        s_hint = mode;
    }
}

void epd_hint_clean(void) {
    s_clean_hint = true;
    s_hint = CT_REFRESH_FULL;
}

static void rect_add(rect_t *r, int x1, int y1, int x2, int y2) {
    if (r->x2 < 0) {
        *r = (rect_t){x1, y1, x2, y2};
        return;
    }
    if (x1 < r->x1) r->x1 = x1;
    if (y1 < r->y1) r->y1 = y1;
    if (x2 > r->x2) r->x2 = x2;
    if (y2 > r->y2) r->y2 = y2;
}

static inline bool is_grey(uint8_t level) {
    return level == 1 || level == 2;
}

/* The black-and-white pass draws every pixel that is not white black. */
static inline uint8_t bw_of(uint8_t level) {
    return level == 3 ? 3 : 0;
}

/* RGB565 -> the level the pixel is shown at: 0 black, 1 dark grey, 2 light grey,
 * 3 white. Luminance weights as in sim.js. The UI is black and white; grey only
 * appears on glyph edges, and on the real panel text read better leaning towards
 * its ink (2026-11-16): an edge pixel at least half covered is ink, a fainter one
 * the grey next to the ink. For black text that is dark grey; for white text on
 * the UI's tinted black (CT_INK_BG, blue > red marks it) the mirror image, light
 * grey, so white text is as bold as black text. */
#define LUM_MAX (31 * 247 + 63 * 239 + 31 * 90)
#define LUM_INK (LUM_MAX / 2)              /* at least half ink */
#define LUM_EDGE (LUM_MAX - LUM_MAX / 6)   /* at least a sixth ink */

static inline uint8_t level_of(uint16_t c) {
    const int r = (c >> 11) & 0x1f, g = (c >> 5) & 0x3f, b = c & 0x1f;
    const int lum = r * 247 + g * 239 + b * 90;
    if (b > r) { /* white ink */
        return lum >= LUM_MAX - LUM_INK ? 3 : lum >= LUM_MAX - LUM_EDGE ? 2 : 0;
    }
    return lum >= LUM_EDGE ? 3 : lum >= LUM_INK ? 1 : 0;
}

/* UI (x, y), portrait -> panel byte and bit, landscape: px = y, py = 479 - x. */
static inline int panel_byte(int x, int y) {
    return (SSD1677_H - 1 - x) * SSD1677_STRIDE + (y >> 3);
}

static inline uint8_t panel_bit(int y) {
    return (uint8_t)(0x80 >> (y & 7));
}

static inline void put_bit(uint8_t *plane, int byte, uint8_t bit, bool on) {
    if (on) {
        plane[byte] |= bit;
    } else {
        plane[byte] &= (uint8_t)~bit;
    }
}

static void flush_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map) {
    (void)px_map; /* direct mode: the pixels are in s_fb */
    const int x1 = area->x1 < 0 ? 0 : area->x1;
    const int y1 = area->y1 < 0 ? 0 : area->y1;
    const int x2 = area->x2 >= W ? W - 1 : area->x2;
    const int y2 = area->y2 >= H ? H - 1 : area->y2;
    const bool last = lv_display_flush_is_last(disp);

    xSemaphoreTake(s_lock, portMAX_DELAY);
    for (int y = y1; y <= y2; y++) {
        const uint16_t *src = s_fb + y * W;
        uint8_t *dst = s_target + y * W;
        for (int x = x1; x <= x2; x++) {
            dst[x] = level_of(src[x]);
        }
    }
    if (x1 <= x2 && y1 <= y2) {
        rect_add(&s_dirty, x1, y1, x2, y2);
    }
    if (last) {
        if (s_hint > s_pending) {
            s_pending = s_hint;
        }
        s_have_frame = true;
        s_clean |= s_clean_hint;
        /* Under the lock, so the task cannot mark itself idle with this frame pending. */
        xEventGroupClearBits(s_state, EPD_IDLE);
    }
    xSemaphoreGive(s_lock);

    if (last) {
        s_hint = CT_REFRESH_PARTIAL;
        s_clean_hint = false;
        xTaskNotifyGive(s_task);
    }
    lv_display_flush_ready(disp);
}

typedef struct {
    int changed;    /* UI pixels whose level changes */
    bool grey_owed; /* some pixel should be grey but is not yet */
} frame_t;

/* Partial refresh of rect r: work out the planes and the new physical levels.
 * Fills s_ram_a (new, 0x24) and s_ram_b (old, 0x26). Called with s_lock held. */
static frame_t prepare_partial(const rect_t *r) {
    frame_t f = {0};
    /* Only pixels that change colour are driven; all others go to the panel as
     * white->white, which the waveform leaves alone. The vendor's partial waveform
     * gives every black->black pixel a short black pulse, one way only: static black
     * (the status bar, text that stays) took it on every refresh, charge built up in
     * the panel and pulled old screens back a few seconds after a full wipe
     * (2026-11-16). */
    memset(s_ram_a, 0xFF, SSD1677_PLANE_BYTES);
    memset(s_ram_b, 0xFF, SSD1677_PLANE_BYTES);
    for (int y = r->y1; y <= r->y2; y++) {
        const uint8_t bit = panel_bit(y);
        for (int x = r->x1; x <= r->x2; x++) {
            const int i = y * W + x;
            const uint8_t t = s_target[i];
            const uint8_t p = s_phys[i];
            const int byte = panel_byte(x, y);
            put_bit(s_plane, byte, bit, bw_of(t) == 3);
            if (t == p) {
                continue;
            }
            f.changed++;
            const bool new_white = bw_of(t) == 3;
            /* A grey pixel sits between black and white: drive it as if it were the
             * opposite of where it goes (black and other greys start from black). */
            const bool old_white = is_grey(p) ? !new_white : bw_of(p) == 3;
            if (old_white != new_white) {
                put_bit(s_ram_b, byte, bit, old_white);
                put_bit(s_ram_a, byte, bit, new_white);
            }
            s_phys[i] = bw_of(t);
            if (is_grey(t)) {
                f.grey_owed = true;
            }
        }
    }
    return f;
}

/* Full-screen refresh: every pixel is driven to black or white. Called with s_lock held. */
static frame_t prepare_full(void) {
    frame_t f = {0};
    for (int y = 0; y < H; y++) {
        const uint8_t bit = panel_bit(y);
        for (int x = 0; x < W; x++) {
            const int i = y * W + x;
            const uint8_t t = s_target[i];
            put_bit(s_plane, panel_byte(x, y), bit, bw_of(t) == 3);
            if (t != s_phys[i]) {
                f.changed++;
            }
            s_phys[i] = bw_of(t);
            if (is_grey(t)) {
                f.grey_owed = true;
            }
        }
    }
    return f;
}

static bool planes_differ(const uint8_t *a, const uint8_t *b) {
    return memcmp(a, b, SSD1677_PLANE_BYTES) != 0;
}

/* Black-and-white pass for the pending frame. Returns true if grey is owed. */
static bool show_frame(unsigned *partials) {
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (!s_have_frame || s_off) {
        xSemaphoreGive(s_lock);
        return false;
    }
    rect_t r = s_dirty;
    ct_refresh_t mode = s_pending;
    s_dirty = (rect_t){0, 0, -1, -1};
    s_pending = CT_REFRESH_PARTIAL;
    s_have_frame = false;
    const bool clean = s_clean && mode == CT_REFRESH_FULL;
    s_clean = false;
    frame_t f = {0};
    esp_pm_lock_acquire(s_busy);
    if (mode != CT_REFRESH_PARTIAL) {
        f = prepare_full();
    } else if (r.x2 >= 0) {
        f = prepare_partial(&r);
    }
    esp_pm_lock_release(s_busy);
    xSemaphoreGive(s_lock);

    const bool drive = mode == CT_REFRESH_FULL || (mode == CT_REFRESH_FAST && f.changed > 0) ||
                       (mode == CT_REFRESH_PARTIAL && planes_differ(s_ram_a, s_ram_b));
    if (!drive) {
        return f.grey_owed;
    }

    const int64_t t0 = esp_timer_get_time();
    int busy_ms = 0;
    esp_err_t err;
    if (mode != CT_REFRESH_PARTIAL) {
        ESP_LOGI(TAG, "%s refresh starting", MODE_NAMES[mode]);
    }
    if (mode == CT_REFRESH_PARTIAL) {
        err = ssd1677_load(s_ram_a, s_ram_b);
        if (err == ESP_OK) err = ssd1677_refresh(SSD1677_PARTIAL, &busy_ms);
        (*partials)++;
    } else {
        /* The panel's own full waveform runs properly only from a freshly reset
         * controller. Once one of ours had been loaded, it ran for 286 ms instead of
         * 1021 and merely faded the old image: the "switched off" page never
         * appeared (2026-11-16). The reset clears the controller's RAM, so it goes
         * before the planes are loaded. */
        err = mode == CT_REFRESH_FULL ? ssd1677_init() : ESP_OK;
        /* A wipe first: one full refresh left faint ghosts of the screen before
         * (2026-11-16); all black, then all white, clears them. */
        for (int pass = 0; clean && err == ESP_OK && pass < 2; pass++) {
            memset(s_ram_a, pass == 0 ? 0x00 : 0xFF, SSD1677_PLANE_BYTES);
            err = ssd1677_load(s_ram_a, s_ram_a);
            if (err == ESP_OK) err = ssd1677_refresh(SSD1677_FULL, &busy_ms);
            if (err == ESP_OK) err = ssd1677_init();
            ESP_LOGI(TAG, "wipe to %s: busy %d ms", pass == 0 ? "black" : "white", busy_ms);
        }
        if (err == ESP_OK) err = ssd1677_load(s_plane, s_plane);
        if (err == ESP_OK) {
            err = ssd1677_refresh(mode == CT_REFRESH_FULL ? SSD1677_FULL : SSD1677_FULL_FAST, &busy_ms);
        }
        *partials = 0;
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "%s refresh failed: %s; re-initialising the panel", MODE_NAMES[mode], esp_err_to_name(err));
        vTaskDelay(pdMS_TO_TICKS(1000));
        ssd1677_init();
        /* Unknown what the panel shows now: redo the whole screen with a full refresh. */
        xSemaphoreTake(s_lock, portMAX_DELAY);
        s_pending = CT_REFRESH_FULL;
        s_have_frame = true;
        xSemaphoreGive(s_lock);
        xTaskNotifyGive(s_task);
        return false;
    }
    if (mode == CT_REFRESH_PARTIAL) {
        ESP_LOGI(TAG, "partial: ui %dx%d at (%d,%d), %d px changed, busy %d ms, total %d ms, %u partials",
                 r.x2 - r.x1 + 1, r.y2 - r.y1 + 1, r.x1, r.y1, f.changed, busy_ms,
                 (int)((esp_timer_get_time() - t0) / 1000), *partials);
    } else {
        ESP_LOGI(TAG, "%s: %d px changed, busy %d ms, total %d ms", MODE_NAMES[mode], f.changed, busy_ms,
                 (int)((esp_timer_get_time() - t0) / 1000));
    }
    return f.grey_owed;
}

/* Grey pass: lighten the black base of every pixel that should be grey. Returns
 * true if it did not run and the grey is still owed. */
static bool overlay(void) {
    int light = 0, dark = 0;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (s_off) {
        xSemaphoreGive(s_lock);
        return false;
    }
    if (s_have_frame) {
        /* A new frame came in: its black-and-white pass goes first, then this. */
        xSemaphoreGive(s_lock);
        return true;
    }
    esp_pm_lock_acquire(s_busy);
    memset(s_ram_a, 0, SSD1677_PLANE_BYTES); /* 0x24: dark grey */
    memset(s_ram_b, 0, SSD1677_PLANE_BYTES); /* 0x26: light or dark grey */
    for (int y = 0; y < H; y++) {
        const uint8_t bit = panel_bit(y);
        for (int x = 0; x < W; x++) {
            const int i = y * W + x;
            const uint8_t t = s_target[i];
            if (!is_grey(t) || s_phys[i] != 0) {
                continue;
            }
            const int byte = panel_byte(x, y);
            s_ram_b[byte] |= bit;
            if (t == 1) {
                s_ram_a[byte] |= bit;
                dark++;
            } else {
                light++;
            }
            s_phys[i] = t;
        }
    }
    esp_pm_lock_release(s_busy);
    xSemaphoreGive(s_lock);
    if (light + dark == 0) {
        return false;
    }
    const int64_t t0 = esp_timer_get_time();
    int busy_ms = 0;
    esp_err_t err = ssd1677_load(s_ram_a, s_ram_b);
    if (err == ESP_OK) err = ssd1677_refresh(SSD1677_GREY, &busy_ms);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "grey pass failed: %s", esp_err_to_name(err));
        return false;
    }
    ESP_LOGI(TAG, "grey: %d light + %d dark px, busy %d ms, total %d ms", light, dark, busy_ms,
             (int)((esp_timer_get_time() - t0) / 1000));
    return false;
}

static void refresh_task(void *arg) {
    (void)arg;
    unsigned partials = 0;
    bool grey_owed = false;
    for (;;) {
        if (!grey_owed) {
            /* Idle only if no frame came in while the last refresh ran (flush_cb
             * clears the bit under the same lock). Setting it regardless let
             * epd_wait_idle() return with the "switched off" page still queued, and
             * the power went while it was being drawn (2026-11-16). */
            xSemaphoreTake(s_lock, portMAX_DELAY);
            if (!s_have_frame) {
                xEventGroupSetBits(s_state, EPD_IDLE);
            }
            xSemaphoreGive(s_lock);
        }
        const TickType_t wait = grey_owed ? pdMS_TO_TICKS(OVERLAY_DELAY_MS) : portMAX_DELAY;
        if (ulTaskNotifyTake(pdTRUE, wait) > 0) {
            grey_owed |= show_frame(&partials);
        } else if (grey_owed) {
            /* The screen has been still for a moment. */
            grey_owed = overlay();
        }
    }
}

bool epd_wait_idle(uint32_t timeout_ms) {
    return (xEventGroupWaitBits(s_state, EPD_IDLE, pdFALSE, pdTRUE, pdMS_TO_TICKS(timeout_ms)) & EPD_IDLE) != 0;
}

bool epd_finish(uint32_t timeout_ms) {
    const bool idle = epd_wait_idle(timeout_ms);
    /* Keep the refresh task away from the panel from here on. */
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_off = true;
    xSemaphoreGive(s_lock);
    if (idle) {
        ssd1677_sleep();
    }
    return idle;
}

lv_display_t *epd_init(void) {
    const size_t fb_bytes = (size_t)W * H * sizeof(uint16_t);
    s_fb = heap_caps_malloc(fb_bytes, MALLOC_CAP_SPIRAM);
    s_target = heap_caps_calloc(1, (size_t)W * H, MALLOC_CAP_SPIRAM);
    s_phys = heap_caps_calloc(1, (size_t)W * H, MALLOC_CAP_SPIRAM);
    s_plane = heap_caps_malloc(SSD1677_PLANE_BYTES, MALLOC_CAP_SPIRAM);
    s_ram_a = heap_caps_malloc(SSD1677_PLANE_BYTES, MALLOC_CAP_SPIRAM);
    s_ram_b = heap_caps_malloc(SSD1677_PLANE_BYTES, MALLOC_CAP_SPIRAM);
    s_lock = xSemaphoreCreateMutex();
    esp_pm_lock_create(ESP_PM_CPU_FREQ_MAX, 0, "epd", &s_busy);
    s_state = xEventGroupCreate();
    if (s_fb == NULL || s_target == NULL || s_phys == NULL || s_plane == NULL ||
        s_ram_a == NULL || s_ram_b == NULL || s_lock == NULL) {
        ESP_LOGE(TAG, "out of memory");
        abort();
    }
    memset(s_plane, 0xFF, SSD1677_PLANE_BYTES);
    ESP_ERROR_CHECK(ssd1677_init());

    xTaskCreatePinnedToCore(refresh_task, "epd", 4096, NULL, 4, &s_task, 0);

    lv_display_t *disp = lv_display_create(W, H);
    lv_display_set_color_format(disp, LV_COLOR_FORMAT_RGB565);
    lv_display_set_flush_cb(disp, flush_cb);
    lv_display_set_buffers(disp, s_fb, NULL, fb_bytes, LV_DISPLAY_RENDER_MODE_DIRECT);
    return disp;
}
