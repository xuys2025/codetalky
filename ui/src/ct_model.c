/* Session store for every connected computer, kept sorted for display. Filled by ct_proto.c. */
#include "ct_model.h"

#include <stdlib.h>
#include <string.h>

#include "ct_arena.h"
#include "lvgl.h"

static ct_session_t *s_sessions[CT_MAX_SESSIONS];
static int s_count;
static uint32_t s_rev = 1;

static struct {
    bool known; /* its bridge has said hello since it was last dropped */
    char host[CT_HOST_MAX];
    char quick[CT_MAX_QUICK][96];
    int quick_count;
} s_links[CT_MAX_LINKS];

static int64_t s_time_base; /* Unix seconds at s_tick_base */
static uint32_t s_tick_base;
static int s_tz_minutes;

static bool valid_link(int link) {
    return link >= 0 && link < CT_MAX_LINKS;
}

/* Copy at most size-1 bytes without cutting a UTF-8 character in half. */
static void copy_utf8(char *dst, size_t size, const char *src) {
    size_t n = strlen(src);
    if (n >= size) {
        n = size - 1;
        while (n > 0 && ((unsigned char)src[n] & 0xC0) == 0x80) {
            n--;
        }
    }
    memcpy(dst, src, n);
    dst[n] = '\0';
}

/* ---------- order ---------- */

static int rank(ct_state_t state) {
    switch (state) {
    case CT_STATE_WAIT_APPROVE:
    case CT_STATE_WAIT_ANSWER: return 0;
    case CT_STATE_ERROR: return 1;
    case CT_STATE_DONE: return 2;
    case CT_STATE_RUNNING: return 3;
    default: return 4;
    }
}

/* Waiting sessions: longest wait first. Everything else by name, so rows don't
 * shuffle on the screen while agents work. */
static int compare(const ct_session_t *a, const ct_session_t *b) {
    const int ra = rank(a->state);
    const int rb = rank(b->state);
    if (ra != rb) {
        return ra - rb;
    }
    if (ra == 0 && a->since != b->since) {
        return a->since < b->since ? -1 : 1;
    }
    const int by_name = strcmp(a->name, b->name);
    if (by_name != 0) {
        return by_name;
    }
    if (a->link != b->link) {
        return a->link - b->link;
    }
    return strcmp(a->id, b->id);
}

static void sort_sessions(void) {
    /* Insertion sort: at most 16 entries, usually already in order. */
    for (int i = 1; i < s_count; i++) {
        ct_session_t *s = s_sessions[i];
        int j = i - 1;
        while (j >= 0 && compare(s_sessions[j], s) > 0) {
            s_sessions[j + 1] = s_sessions[j];
            j--;
        }
        s_sessions[j + 1] = s;
    }
}

static int index_of(int link, const char *id) {
    for (int i = 0; i < s_count; i++) {
        if (s_sessions[i]->link == link && strcmp(s_sessions[i]->id, id) == 0) {
            return i;
        }
    }
    return -1;
}

/* ---------- queries ---------- */

int ct_model_count(void) {
    return s_count;
}

const ct_session_t *ct_model_at(int index) {
    return index >= 0 && index < s_count ? s_sessions[index] : NULL;
}

const ct_session_t *ct_model_find(int link, const char *id) {
    const int i = id != NULL ? index_of(link, id) : -1;
    return i >= 0 ? s_sessions[i] : NULL;
}

uint32_t ct_model_rev(void) {
    return s_rev;
}

/* ---------- updates ---------- */

void ct_session_free(ct_session_t *s) {
    if (s != NULL) {
        ct_arena_free((ct_arena_t *)s->mem); /* s itself lives in the arena */
    }
}

void ct_model_put(ct_session_t *s) {
    s->rev = ++s_rev;
    s->stale = false;
    const int i = index_of(s->link, s->id);
    if (i >= 0) {
        ct_session_free(s_sessions[i]);
        s_sessions[i] = s;
    } else if (s_count < CT_MAX_SESSIONS) {
        s_sessions[s_count++] = s;
    } else {
        LV_LOG_WARN("more than %d sessions, dropping %s", CT_MAX_SESSIONS, s->id);
        ct_session_free(s);
        return;
    }
    sort_sessions();
}

static void remove_at(int i) {
    ct_session_free(s_sessions[i]);
    memmove(&s_sessions[i], &s_sessions[i + 1], (size_t)(s_count - i - 1) * sizeof(s_sessions[0]));
    s_count--;
    s_rev++;
}

void ct_model_remove(int link, const char *id) {
    const int i = index_of(link, id);
    if (i >= 0) {
        remove_at(i);
    }
}

void ct_model_mark_stale(int link) {
    for (int i = 0; i < s_count; i++) {
        if (s_sessions[i]->link == link) {
            s_sessions[i]->stale = true;
        }
    }
}

void ct_model_purge_stale(int link) {
    for (int i = s_count - 1; i >= 0; i--) {
        if (s_sessions[i]->link == link && s_sessions[i]->stale) {
            remove_at(i);
        }
    }
}

void ct_model_drop_link(int link) {
    for (int i = s_count - 1; i >= 0; i--) {
        if (s_sessions[i]->link == link) {
            remove_at(i);
        }
    }
    if (valid_link(link) && s_links[link].known) {
        s_links[link].known = false;
        s_rev++;
    }
}

/* ---------- computers ---------- */

void ct_model_set_host(int link, const char *name) {
    if (!valid_link(link)) {
        return;
    }
    if (!s_links[link].known || strcmp(s_links[link].host, name) != 0) {
        s_rev++;
    }
    s_links[link].known = true;
    copy_utf8(s_links[link].host, sizeof(s_links[link].host), name);
}

const char *ct_model_host(int link) {
    return valid_link(link) && s_links[link].known ? s_links[link].host : "";
}

bool ct_model_many_hosts(void) {
    int known = 0;
    for (int i = 0; i < CT_MAX_LINKS; i++) {
        known += s_links[i].known ? 1 : 0;
    }
    return known > 1;
}

/* ---------- quick replies ---------- */

int ct_model_quick_count(int link) {
    return valid_link(link) ? s_links[link].quick_count : 0;
}

const char *ct_model_quick(int link, int index) {
    if (!valid_link(link) || index < 0 || index >= s_links[link].quick_count) {
        return NULL;
    }
    return s_links[link].quick[index];
}

void ct_model_set_quick(int link, const char *const *texts, int count) {
    if (!valid_link(link)) {
        return;
    }
    int n = 0;
    for (int i = 0; i < count && n < CT_MAX_QUICK; i++) {
        if (texts[i][0] != '\0') {
            copy_utf8(s_links[link].quick[n++], sizeof(s_links[link].quick[0]), texts[i]);
        }
    }
    s_links[link].quick_count = n;
    s_rev++;
}

/* ---------- clock ---------- */

void ct_model_set_time(int64_t unix_seconds, int tz_minutes) {
    s_time_base = unix_seconds;
    s_tick_base = lv_tick_get();
    s_tz_minutes = tz_minutes;
}

int64_t ct_model_now(void) {
    if (s_time_base == 0) {
        return 0;
    }
    return s_time_base + (int64_t)(lv_tick_elaps(s_tick_base) / 1000);
}

int ct_model_tz_minutes(void) {
    return s_tz_minutes;
}
