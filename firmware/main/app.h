/*
 * Events for the UI task. LVGL and the ct_ui_* entry points run on that one task;
 * other tasks (touch, keys, network) hand things over through app_post().
 */
#ifndef APP_H
#define APP_H

#include <stdbool.h>
#include <stddef.h>

typedef enum {
    APP_EV_KEY,  /* a = ct_key_t, b = 1 down / 0 up */
    APP_EV_LINK, /* a = link, b = 1 up / 0 down */
    APP_EV_MSG,  /* a = link, text/len = one frame (malloc'd; the UI task frees it) */
    APP_EV_POWER_OFF, /* a = 0 the user held the power key, 1 the battery is empty */
    APP_EV_UPDATE,    /* new firmware was offered: ota_run() */
    APP_EV_AUDIO,     /* text/len = microphone samples, 16-bit (malloc'd; the UI task frees it) */
} app_ev_type_t;

typedef struct {
    app_ev_type_t type;
    int a;
    int b;
    char *text;
    size_t len;
} app_event_t;

/* Returns false (and frees ev->text) if the queue is full. */
bool app_post(const app_event_t *ev);

#endif /* APP_H */
