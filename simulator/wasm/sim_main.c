/*
 * Simulator platform layer: LVGL display + input + HAL, compiled to WebAssembly.
 * JavaScript drives it through the sim_* exports and receives changed areas
 * through Module.onFlush / Module.onVibrate. Frames to the bridge go out through
 * Module.onNetSend; frames from it come in through sim_net_rx.
 */
#include <emscripten.h>
#include <stdbool.h>
#include <stdint.h>

#include "ct_hal.h"
#include "ct_proto.h"
#include "ct_ui.h"
#include "lvgl.h"

#define SIM_W 480
#define SIM_H 800

static uint16_t s_fb[SIM_W * SIM_H];
static lv_display_t *s_disp;
static lv_indev_t *s_pointer;
static int32_t s_ptr_x, s_ptr_y;
static bool s_ptr_down;
static ct_refresh_t s_refresh_mode = CT_REFRESH_PARTIAL;

EM_JS(void, js_on_flush, (int x1, int y1, int x2, int y2, int last, int mode), {
    if (Module.onFlush) Module.onFlush(x1, y1, x2, y2, last, mode);
});

EM_JS(void, js_on_vibrate, (int ms), {
    if (Module.onVibrate) Module.onVibrate(ms);
});

/* Returns 1 if the page took the frame (that link's WebSocket is open). */
EM_JS(int, js_net_send, (int link, const char *json), {
    return Module.onNetSend ? (Module.onNetSend(link, UTF8ToString(json)) ? 1 : 0) : 0;
});

void ct_hal_refresh_hint(ct_refresh_t mode) {
    /* The strongest request made during a frame wins. */
    if (mode > s_refresh_mode) {
        s_refresh_mode = mode;
    }
}

void ct_hal_vibrate(uint16_t ms) {
    js_on_vibrate(ms);
}

bool ct_hal_net_send(int link, const char *json) {
    return js_net_send(link, json) != 0;
}

EM_JS(void, js_net_close, (int link), {
    if (Module.onNetClose) Module.onNetClose(link);
});

void ct_hal_net_close(int link) {
    js_net_close(link);
}

/* Settings live wherever the page puts them (localStorage in the browser). */
EM_JS(int, js_store_get, (const char *key, char *buf, int size), {
    const value = Module.storeGet ? Module.storeGet(UTF8ToString(key)) : null;
    if (value === null || value === undefined) return 0;
    stringToUTF8(String(value), buf, size);
    return 1;
});

EM_JS(void, js_store_set, (const char *key, const char *value), {
    if (Module.storeSet) Module.storeSet(UTF8ToString(key), value ? UTF8ToString(value) : null);
});

/* Module.random lets the headless snapshots be repeatable. */
EM_JS(uint32_t, js_random, (void), {
    if (Module.random) return Module.random() >>> 0;
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0];
});

bool ct_hal_store_get(const char *key, char *buf, size_t size) {
    return js_store_get(key, buf, (int)size) != 0;
}

void ct_hal_store_set(const char *key, const char *value) {
    js_store_set(key, value);
}

uint32_t ct_hal_random(void) {
    return js_random();
}

/* The simulator is rebuilt, not updated over the network. */
const char *ct_hal_firmware_version(void) {
    return NULL;
}

bool ct_hal_firmware_update(int link, const char *path, uint32_t size, const char *sha256, const char *version) {
    (void)link;
    (void)path;
    (void)size;
    (void)sha256;
    (void)version;
    return false;
}

/* No microphone yet: the voice screen shows its sample words. */
bool ct_hal_mic_start(void) {
    return false;
}

void ct_hal_mic_stop(void) {}

int ct_hal_battery_percent(void) {
    return 82;
}

static void flush_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map) {
    (void)px_map; /* direct mode: pixels are already in s_fb */
    const bool last = lv_display_flush_is_last(disp);
    js_on_flush(area->x1, area->y1, area->x2, area->y2, last, (int)s_refresh_mode);
    if (last) {
        s_refresh_mode = CT_REFRESH_PARTIAL;
    }
    lv_display_flush_ready(disp);
}

static void pointer_cb(lv_indev_t *indev, lv_indev_data_t *data) {
    (void)indev;
    data->point.x = s_ptr_x;
    data->point.y = s_ptr_y;
    data->state = s_ptr_down ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
}

EMSCRIPTEN_KEEPALIVE
int sim_init(void) {
    if (s_disp != NULL) {
        return 0;
    }
    lv_init();

    s_disp = lv_display_create(SIM_W, SIM_H);
    lv_display_set_color_format(s_disp, LV_COLOR_FORMAT_RGB565);
    lv_display_set_flush_cb(s_disp, flush_cb);
    lv_display_set_buffers(s_disp, s_fb, NULL, sizeof(s_fb), LV_DISPLAY_RENDER_MODE_DIRECT);

    s_pointer = lv_indev_create();
    lv_indev_set_type(s_pointer, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(s_pointer, pointer_cb);

    /* The first frame is a clean full refresh, as after power-on. */
    s_refresh_mode = CT_REFRESH_FULL;
    ct_ui_init();
    return 0;
}

/* Advance LVGL by elapsed_ms. The caller owns the clock, so tests are deterministic. */
EMSCRIPTEN_KEEPALIVE
void sim_tick(uint32_t elapsed_ms) {
    lv_tick_inc(elapsed_ms);
    lv_timer_handler();
}

EMSCRIPTEN_KEEPALIVE
void sim_pointer(int x, int y, int down) {
    s_ptr_x = x;
    s_ptr_y = y;
    s_ptr_down = down != 0;
}

EMSCRIPTEN_KEEPALIVE
void sim_key(int key, int down) {
    if (key >= 0 && key < CT_KEY_COUNT) {
        ct_ui_on_key((ct_key_t)key, down != 0);
    }
}

/* The pairing code the device shows for a link ("" if none), for tools that play the user. */
EMSCRIPTEN_KEEPALIVE
const char *sim_pair_code(int link) {
    return ct_proto_pairing(link) ? ct_proto_pair_code(link) : "";
}

/* The page's WebSocket to one computer's bridge opened (1) or closed (0). */
EMSCRIPTEN_KEEPALIVE
void sim_net_link(int link, int up) {
    ct_ui_on_link(link, up != 0);
}

/* One text frame from a bridge, UTF-8, len bytes (no terminator needed). */
EMSCRIPTEN_KEEPALIVE
void sim_net_rx(int link, const char *json, int len) {
    if (json != NULL && len > 0) {
        ct_ui_on_message(link, json, (size_t)len);
    }
}

/* RGB565, SIM_W x SIM_H, row-major. */
EMSCRIPTEN_KEEPALIVE
uint8_t *sim_framebuffer(void) {
    return (uint8_t *)s_fb;
}

EMSCRIPTEN_KEEPALIVE
int sim_width(void) {
    return SIM_W;
}

EMSCRIPTEN_KEEPALIVE
int sim_height(void) {
    return SIM_H;
}

int main(void) {
    return 0;
}
