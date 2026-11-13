#include "ct_text.h"

#include <stdbool.h>
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

/* ---------- line breaking ---------- */

typedef struct {
    uint32_t cp;   /* code point */
    int run;       /* which run it came from */
    uint32_t at;   /* byte offset in that run */
    uint8_t len;   /* bytes */
    int32_t width; /* pixels */
    bool brk;      /* a line break goes before this character */
    bool drop;     /* a space swallowed by that break */
} glyph_t;

static uint32_t utf8_next(const char *s, uint32_t *i) {
    const uint8_t c = (uint8_t)s[*i];
    uint32_t cp;
    int extra;
    if (c < 0x80) {
        cp = c;
        extra = 0;
    } else if ((c & 0xE0) == 0xC0) {
        cp = c & 0x1F;
        extra = 1;
    } else if ((c & 0xF0) == 0xE0) {
        cp = c & 0x0F;
        extra = 2;
    } else if ((c & 0xF8) == 0xF0) {
        cp = c & 0x07;
        extra = 3;
    } else {
        (*i)++;
        return 0xFFFD;
    }
    (*i)++;
    for (int k = 0; k < extra; k++) {
        const uint8_t next = (uint8_t)s[*i];
        if ((next & 0xC0) != 0x80) {
            return 0xFFFD;
        }
        cp = (cp << 6) | (next & 0x3F);
        (*i)++;
    }
    return cp;
}

/* Characters that are words by themselves: a line may break before or after them. */
static bool is_cjk(uint32_t cp) {
    return (cp >= 0x2E80 && cp <= 0x9FFF) || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFF00 && cp <= 0xFFEF) ||
           (cp >= 0x2010 && cp <= 0x206F) || (cp >= 0x3000 && cp <= 0x303F);
}

static bool in_set(const uint32_t *set, size_t count, uint32_t cp) {
    for (size_t i = 0; i < count; i++) {
        if (set[i] == cp) {
            return true;
        }
    }
    return false;
}

/* Must not start a line: ，。、；：！？）」』】》〉”’…·ー％．〕— and their ASCII cousins. */
static bool no_start(uint32_t cp) {
    static const uint32_t set[] = {
        0xFF0C, 0x3002, 0x3001, 0xFF1B, 0xFF1A, 0xFF01, 0xFF1F, 0xFF09, 0x300D, 0x300F, 0x3011, 0x300B,
        0x3009, 0x201D, 0x2019, 0x2026, 0x00B7, 0x30FC, 0xFF05, 0xFF0E, 0x3015, 0x2014, ',',    '.',
        ';',    ':',    '!',    '?',    ')',    ']',    '}',    '%',
    };
    return in_set(set, sizeof(set) / sizeof(set[0]), cp);
}

/* Must not end a line: （「『【《〈“‘〔 and ([{. */
static bool no_end(uint32_t cp) {
    static const uint32_t set[] = {0xFF08, 0x300C, 0x300E, 0x3010, 0x300A, 0x3008, 0x201C, 0x2018, 0x3014, '(', '[', '{'};
    return in_set(set, sizeof(set) / sizeof(set[0]), cp);
}

/* May a line break go between a and b? */
static bool can_break(uint32_t a, uint32_t b) {
    if (a == ' ' || b == ' ') {
        return true;
    }
    if (no_start(b) || no_end(a)) {
        return false;
    }
    return is_cjk(a) || is_cjk(b);
}

static void copy_through(ct_run_t *runs, int count) {
    for (int r = 0; r < count; r++) {
        snprintf(runs[r].out, runs[r].out_size, "%s", runs[r].text);
    }
}

void ct_wrap(ct_run_t *runs, int count, int32_t width) {
    size_t total = 0;
    for (int r = 0; r < count; r++) {
        total += strlen(runs[r].text);
    }
    glyph_t *g = total > 0 ? lv_malloc(total * sizeof(glyph_t)) : NULL;
    if (g == NULL) {
        copy_through(runs, count);
        return;
    }
    int n = 0;
    for (int r = 0; r < count; r++) {
        const char *t = runs[r].text;
        uint32_t i = 0;
        while (t[i] != '\0') {
            const uint32_t at = i;
            const uint32_t cp = utf8_next(t, &i);
            uint32_t peek = i;
            const uint32_t next = t[i] != '\0' ? utf8_next(t, &peek) : 0;
            g[n] = (glyph_t){
                .cp = cp,
                .run = r,
                .at = at,
                .len = (uint8_t)(i - at),
                .width = cp == '\n' ? 0 : (int32_t)lv_font_get_glyph_width(runs[r].font, cp, next),
            };
            n++;
        }
    }

    /* Greedy fill. start: the first glyph on the current line. */
    int start = 0;
    int32_t used = 0;
    for (int i = 0; i < n; i++) {
        if (g[i].cp == '\n') {
            start = i + 1;
            used = 0;
            continue;
        }
        if (used + g[i].width > width && i > start) {
            /* The latest place at or before i where the line may end. */
            int b = i;
            while (b > start && !can_break(g[b - 1].cp, g[b].cp)) {
                b--;
            }
            if (b == start) {
                b = i; /* nowhere allowed: a word longer than the line, cut it here */
            }
            g[b].brk = true;
            g[b].drop = g[b].cp == ' ';
            start = b;
            used = 0;
            for (int k = b; k < i; k++) {
                used += g[k].drop ? 0 : g[k].width;
            }
        }
        used += g[i].drop ? 0 : g[i].width;
    }

    /* Write each run out with its breaks. */
    int k = 0;
    for (int r = 0; r < count; r++) {
        ct_run_t *run = &runs[r];
        size_t o = 0;
        for (; k < n && g[k].run == r; k++) {
            if (o + g[k].len + 2 > run->out_size) {
                break;
            }
            if (g[k].brk) {
                run->out[o++] = '\n';
            }
            if (!g[k].drop) {
                memcpy(run->out + o, run->text + g[k].at, g[k].len);
                o += g[k].len;
            }
        }
        while (k < n && g[k].run == r) {
            k++;
        }
        if (run->out_size > 0) {
            run->out[o] = '\0';
        }
    }
    lv_free(g);
}
