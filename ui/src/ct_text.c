#include "ct_text.h"

#include <stdio.h>
#include <string.h>

#include "ct_model.h"

void ct_fmt_stat(char *buf, size_t size, int add, int del) {
    if (add != 0 && del != 0) {
        snprintf(buf, size, "+%d −%d", add, del);
    } else if (add != 0) {
        snprintf(buf, size, "+%d", add);
    } else if (del != 0) {
        snprintf(buf, size, "−%d", del);
    } else if (size > 0) {
        buf[0] = '\0';
    }
}

void ct_fmt_clock(char *buf, size_t size, int64_t unix_seconds) {
    if (unix_seconds <= 0) {
        snprintf(buf, size, "--:--");
        return;
    }
    int64_t local = unix_seconds + (int64_t)ct_model_tz_minutes() * 60;
    int64_t minutes = local / 60 % (24 * 60);
    if (minutes < 0) {
        minutes += 24 * 60;
    }
    snprintf(buf, size, "%02d:%02d", (int)(minutes / 60), (int)(minutes % 60));
}

void ct_fmt_span(char *buf, size_t size, int64_t seconds) {
    if (seconds < 0) {
        seconds = 0;
    }
    if (seconds < 60) {
        snprintf(buf, size, "%d 秒", (int)seconds);
    } else if (seconds < 3600) {
        snprintf(buf, size, "%d 分", (int)(seconds / 60));
    } else if (seconds < 86400) {
        const int h = (int)(seconds / 3600);
        const int m = (int)(seconds % 3600 / 60);
        if (m == 0) {
            snprintf(buf, size, "%d 小时", h);
        } else {
            snprintf(buf, size, "%d 小时 %d 分", h, m);
        }
    } else {
        snprintf(buf, size, "%d 天", (int)(seconds / 86400));
    }
}

const char *ct_basename(const char *path) {
    const char *slash = strrchr(path, '/');
    return slash != NULL ? slash + 1 : path;
}
