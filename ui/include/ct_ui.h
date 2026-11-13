/*
 * CodeTalky UI entry points. Platform code (simulator or firmware) creates the
 * LVGL display and input devices, then calls these.
 */
#ifndef CT_UI_H
#define CT_UI_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Physical keys and the three touch keys below the screen. */
typedef enum {
    CT_KEY_BOOT = 0, /* push-to-talk */
    CT_KEY_POWER,
    CT_KEY_VOL_UP,
    CT_KEY_VOL_DOWN,
    CT_KEY_HOME,
    CT_KEY_PREV,
    CT_KEY_NEXT,
    CT_KEY_COUNT
} ct_key_t;

/* Build the UI on the active LVGL display. Call once after lv_init(). */
void ct_ui_init(void);

/* A key went down or up. */
void ct_ui_on_key(ct_key_t key, bool down);

/* The connection to the bridge came up or went down. */
void ct_ui_on_link(bool up);

/* One text frame from the bridge. Call from the UI thread, not from inside LVGL. */
void ct_ui_on_message(const char *json, size_t len);

#ifdef __cplusplus
}
#endif

#endif /* CT_UI_H */
