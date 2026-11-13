#include "ct_proto.h"

#include <string.h>

#include "cJSON.h"
#include "ct_arena.h"
#include "ct_hal.h"
#include "ct_model.h"

#ifndef CT_DEVICE_NAME
#define CT_DEVICE_NAME "codetalky"
#endif

/* What the device keeps of a snapshot; the bridge already trims to these. */
#define MAX_TODOS 12
#define MAX_LOG 48
#define MAX_FILES 32
#define MAX_HUNKS 6
#define MAX_LINES 14
#define MAX_OPTIONS 6
#define MAX_REPORT 24

/* Longest strings kept, in bytes. */
#define LEN_SHORT 160 /* names, verbs, labels */
#define LEN_TARGET 400
#define LEN_TEXT 1500 /* what the agent said, report paragraphs */

static bool s_up;
static bool s_greeted; /* the bridge said hello on this connection */
static uint32_t s_seq = 1;

/* ---------- reading JSON ---------- */

static const cJSON *field(const cJSON *obj, const char *key) {
    return cJSON_GetObjectItemCaseSensitive(obj, key);
}

static const char *raw_string(const cJSON *obj, const char *key) {
    const cJSON *v = field(obj, key);
    return cJSON_IsString(v) ? v->valuestring : NULL;
}

static double number(const cJSON *obj, const char *key, double fallback) {
    const cJSON *v = field(obj, key);
    return cJSON_IsNumber(v) ? v->valuedouble : fallback;
}

static int int_of(const cJSON *obj, const char *key, int fallback) {
    const double d = number(obj, key, fallback);
    return d > 2147483647.0 || d < -2147483648.0 ? fallback : (int)d;
}

static int64_t time_of(const cJSON *obj, const char *key) {
    return (int64_t)number(obj, key, 0);
}

/* Copy an optional string into the arena; NULL if missing. */
static const char *opt_str(ct_arena_t *a, const cJSON *obj, const char *key, size_t max) {
    const char *s = raw_string(obj, key);
    return s != NULL ? ct_arena_str(a, s, max) : NULL;
}

/* Copy a string that the UI expects to exist; "" if missing. */
static const char *str(ct_arena_t *a, const cJSON *obj, const char *key, size_t max) {
    const char *s = opt_str(a, obj, key, max);
    return s != NULL ? s : "";
}

/* Number of elements to take from an array field, at most max. */
static int array_len(const cJSON *arr, int max) {
    if (!cJSON_IsArray(arr)) {
        return 0;
    }
    const int n = cJSON_GetArraySize(arr);
    return n < max ? n : max;
}

static const char *const *str_array(ct_arena_t *a, const cJSON *arr, int max, size_t len, int *count) {
    *count = 0;
    const int n = array_len(arr, max);
    if (n == 0) {
        return NULL;
    }
    const char **out = ct_arena_alloc(a, (size_t)n * sizeof(char *));
    if (out == NULL) {
        return NULL;
    }
    int i = 0;
    const cJSON *item;
    cJSON_ArrayForEach(item, arr) {
        if (i == n) {
            break;
        }
        out[i++] = ct_arena_str(a, cJSON_IsString(item) ? item->valuestring : "", len);
    }
    *count = i;
    return out;
}

static ct_state_t state_of(const char *s) {
    if (strcmp(s, "running") == 0) return CT_STATE_RUNNING;
    if (strcmp(s, "approve") == 0) return CT_STATE_WAIT_APPROVE;
    if (strcmp(s, "question") == 0) return CT_STATE_WAIT_ANSWER;
    if (strcmp(s, "done") == 0) return CT_STATE_DONE;
    if (strcmp(s, "error") == 0) return CT_STATE_ERROR;
    return CT_STATE_IDLE;
}

/* ---------- snapshot -> session ---------- */

static void parse_log(ct_arena_t *a, ct_session_t *s, const cJSON *arr) {
    const int n = array_len(arr, MAX_LOG);
    ct_log_t *log = n > 0 ? ct_arena_alloc(a, (size_t)n * sizeof(*log)) : NULL;
    if (log == NULL) {
        return;
    }
    int i = 0;
    const cJSON *e;
    cJSON_ArrayForEach(e, arr) {
        if (i == n) break;
        if (!cJSON_IsObject(e)) continue;
        ct_log_t *l = &log[i++];
        l->at = time_of(e, "at");
        l->verb = str(a, e, "verb", LEN_SHORT);
        l->target = str(a, e, "target", LEN_TARGET);
        l->res = opt_str(a, e, "res", LEN_SHORT);
        l->has_stat = cJSON_IsNumber(field(e, "add")) || cJSON_IsNumber(field(e, "del"));
        l->add = int_of(e, "add", 0);
        l->del = int_of(e, "del", 0);
        l->bad = cJSON_IsTrue(field(e, "bad"));
    }
    s->log = log;
    s->log_count = i;
}

static void parse_files(ct_arena_t *a, ct_session_t *s, const cJSON *arr) {
    const int n = array_len(arr, MAX_FILES);
    ct_file_t *files = n > 0 ? ct_arena_alloc(a, (size_t)n * sizeof(*files)) : NULL;
    if (files == NULL) {
        return;
    }
    int i = 0;
    const cJSON *e;
    cJSON_ArrayForEach(e, arr) {
        if (i == n) break;
        if (!cJSON_IsObject(e)) continue;
        ct_file_t *f = &files[i++];
        const char *st = raw_string(e, "st");
        f->st = st != NULL && st[0] != '\0' ? st[0] : 'M';
        f->path = str(a, e, "path", LEN_TARGET);
        f->add = int_of(e, "add", 0);
        f->del = int_of(e, "del", 0);
    }
    s->files = files;
    s->file_count = i;
}

static void parse_hunks(ct_arena_t *a, ct_session_t *s, const cJSON *obj) {
    s->hunk_total = int_of(obj, "total", 0);
    const cJSON *arr = field(obj, "list");
    const int n = array_len(arr, MAX_HUNKS);
    ct_hunk_t *hunks = n > 0 ? ct_arena_alloc(a, (size_t)n * sizeof(*hunks)) : NULL;
    if (hunks == NULL) {
        return;
    }
    int i = 0;
    const cJSON *e;
    cJSON_ArrayForEach(e, arr) {
        if (i == n) break;
        if (!cJSON_IsObject(e)) continue;
        ct_hunk_t *h = &hunks[i++];
        h->file = str(a, e, "file", LEN_TARGET);
        h->line = int_of(e, "line", 0);
        h->add = int_of(e, "add", 0);
        h->del = int_of(e, "del", 0);
        h->lines = str_array(a, field(e, "lines"), MAX_LINES, LEN_TARGET, &h->line_count);
    }
    s->hunks = hunks;
    s->hunk_count = i;
    if (s->hunk_total < i) {
        s->hunk_total = i;
    }
}

static void parse_ask(ct_arena_t *a, ct_session_t *s, const cJSON *obj) {
    const char *kind = raw_string(obj, "kind");
    const char *req = raw_string(obj, "req");
    if (kind == NULL || req == NULL || strlen(req) >= CT_REQ_MAX) {
        return;
    }
    ct_ask_t *ask = &s->ask;
    ask->req = ct_arena_str(a, req, CT_REQ_MAX - 1);
    if (strcmp(kind, "approve") == 0) {
        ask->kind = CT_ASK_APPROVE;
        ask->verb = str(a, obj, "verb", LEN_SHORT);
        ask->target = str(a, obj, "target", LEN_TARGET);
        ask->has_stat = cJSON_IsNumber(field(obj, "add")) || cJSON_IsNumber(field(obj, "del"));
        ask->add = int_of(obj, "add", 0);
        ask->del = int_of(obj, "del", 0);
        ask->line = int_of(obj, "line", 0);
        ask->lines = str_array(a, field(obj, "lines"), MAX_LINES, LEN_TARGET, &ask->line_count);
        ask->why = opt_str(a, obj, "why", LEN_TEXT);
        ask->until = time_of(obj, "until");
        ask->risky = cJSON_IsTrue(field(obj, "risky"));
    } else if (strcmp(kind, "question") == 0) {
        ask->kind = CT_ASK_QUESTION;
        ask->text = str(a, obj, "text", LEN_TEXT);
        ask->note = opt_str(a, obj, "note", LEN_TEXT);
        const cJSON *arr = field(obj, "options");
        const int n = array_len(arr, MAX_OPTIONS);
        ct_option_t *options = n > 0 ? ct_arena_alloc(a, (size_t)n * sizeof(*options)) : NULL;
        if (options == NULL) {
            return;
        }
        int i = 0;
        const cJSON *e;
        cJSON_ArrayForEach(e, arr) {
            if (i == n) break;
            if (!cJSON_IsObject(e)) continue;
            options[i].label = str(a, e, "label", LEN_SHORT);
            options[i].desc = opt_str(a, e, "desc", LEN_TARGET);
            i++;
        }
        ask->options = options;
        ask->option_count = i;
    }
}

static void parse_report(ct_arena_t *a, ct_session_t *s, const cJSON *arr) {
    const int n = array_len(arr, MAX_REPORT);
    ct_para_t *paras = n > 0 ? ct_arena_alloc(a, (size_t)n * sizeof(*paras)) : NULL;
    if (paras == NULL) {
        return;
    }
    int i = 0;
    const cJSON *e;
    cJSON_ArrayForEach(e, arr) {
        if (i == n) break;
        if (!cJSON_IsObject(e)) continue;
        paras[i].bullet = cJSON_IsTrue(field(e, "b"));
        paras[i].lead = opt_str(a, e, "lead", LEN_SHORT);
        paras[i].text = str(a, e, "text", LEN_TEXT);
        i++;
    }
    s->report = paras;
    s->report_count = i;
}

static ct_session_t *parse_session(const cJSON *j) {
    const char *id = raw_string(j, "id");
    const char *state = raw_string(j, "state");
    if (id == NULL || id[0] == '\0' || strlen(id) >= CT_ID_MAX || state == NULL ||
        raw_string(j, "name") == NULL) {
        return NULL;
    }
    ct_arena_t *a = ct_arena_new();
    if (a == NULL) {
        return NULL;
    }
    ct_session_t *s = ct_arena_alloc(a, sizeof(*s));
    if (s == NULL) {
        ct_arena_free(a);
        return NULL;
    }
    s->mem = a;
    strcpy(s->id, id);
    s->name = str(a, j, "name", LEN_SHORT);
    s->agent = str(a, j, "agent", LEN_SHORT);
    s->model = str(a, j, "model", LEN_SHORT);
    s->branch = opt_str(a, j, "branch", LEN_SHORT);
    s->state = state_of(state);
    s->since = time_of(j, "since");
    s->started = time_of(j, "started");
    s->reply = cJSON_IsTrue(field(j, "reply"));

    const cJSON *now = field(j, "now");
    if (cJSON_IsObject(now)) {
        s->now.verb = str(a, now, "verb", LEN_SHORT);
        s->now.target = str(a, now, "target", LEN_TARGET);
        s->now.has_stat = cJSON_IsNumber(field(now, "add")) || cJSON_IsNumber(field(now, "del"));
        s->now.add = int_of(now, "add", 0);
        s->now.del = int_of(now, "del", 0);
    }
    s->say = opt_str(a, j, "say", LEN_TEXT);

    const cJSON *n = field(j, "n");
    s->n.read = int_of(n, "read", 0);
    s->n.edit = int_of(n, "edit", 0);
    s->n.created = int_of(n, "new", 0);
    s->n.cmd = int_of(n, "cmd", 0);
    s->n.add = int_of(n, "add", 0);
    s->n.del = int_of(n, "del", 0);
    s->ctx = int_of(j, "ctx", -1);

    const cJSON *todos = field(j, "todos");
    if (cJSON_IsObject(todos)) {
        s->todos = str_array(a, field(todos, "items"), MAX_TODOS, LEN_SHORT, &s->todo_count);
        s->todo_done = int_of(todos, "done", 0);
        if (s->todo_done > s->todo_count) s->todo_done = s->todo_count;
        if (s->todo_done < 0) s->todo_done = 0;
    }

    parse_log(a, s, field(j, "log"));
    parse_files(a, s, field(j, "files"));
    parse_hunks(a, s, field(j, "hunks"));
    const cJSON *ask = field(j, "ask");
    if (cJSON_IsObject(ask)) {
        parse_ask(a, s, ask);
    }
    parse_report(a, s, field(j, "report"));
    s->err = opt_str(a, j, "err", LEN_TEXT);

    if (ct_arena_failed(a)) {
        ct_arena_free(a);
        return NULL;
    }
    return s;
}

/* ---------- incoming ---------- */

static ct_ack_t ack_of(const char *err) {
    if (err == NULL) return CT_ACK_BAD;
    if (strcmp(err, "gone") == 0) return CT_ACK_GONE;
    if (strcmp(err, "stale") == 0) return CT_ACK_STALE;
    if (strcmp(err, "unsupported") == 0) return CT_ACK_UNSUPPORTED;
    return CT_ACK_BAD;
}

static void on_hello(const cJSON *msg) {
    ct_model_set_time(time_of(msg, "time"), int_of(msg, "tz", 0));
    const cJSON *quick = field(msg, "quick");
    if (!cJSON_IsArray(quick)) {
        quick = NULL;
    }
    const char *texts[CT_MAX_QUICK];
    int count = 0;
    const cJSON *item;
    cJSON_ArrayForEach(item, quick) {
        if (count < CT_MAX_QUICK && cJSON_IsString(item)) {
            texts[count++] = item->valuestring;
        }
    }
    ct_model_set_quick(texts, count);
    /* Sessions not re-sent before "ready" have ended while we were away. */
    ct_model_mark_stale();
}

ct_event_t ct_proto_receive(const char *json, size_t len) {
    ct_event_t ev = {0};
    cJSON *msg = cJSON_ParseWithLength(json, len);
    if (msg == NULL) {
        return ev;
    }
    const char *t = raw_string(msg, "t");
    if (t == NULL) {
        /* ignore */
    } else if (strcmp(t, "hello") == 0) {
        if (int_of(msg, "proto", -1) != CT_PROTO_VERSION) {
            ev.type = CT_EV_BAD_PROTO;
        } else {
            on_hello(msg);
            s_greeted = true;
            ev.type = CT_EV_HELLO;
        }
    } else if (!s_greeted) {
        /* Nothing counts before the bridge's hello. */
    } else if (strcmp(t, "session") == 0) {
        ct_session_t *s = parse_session(field(msg, "s"));
        if (s != NULL) {
            ct_model_put(s);
            ev.type = CT_EV_CHANGED;
        }
    } else if (strcmp(t, "gone") == 0) {
        const char *id = raw_string(msg, "id");
        if (id != NULL) {
            ct_model_remove(id);
            ev.type = CT_EV_CHANGED;
        }
    } else if (strcmp(t, "ready") == 0) {
        ct_model_purge_stale();
        ev.type = CT_EV_READY;
    } else if (strcmp(t, "ack") == 0) {
        ev.type = CT_EV_ACK;
        ev.seq = (uint32_t)number(msg, "seq", 0);
        ev.ack = cJSON_IsTrue(field(msg, "ok")) ? CT_ACK_OK : ack_of(raw_string(msg, "err"));
    }
    cJSON_Delete(msg);
    return ev;
}

/* ---------- outgoing ---------- */

static bool send_json(cJSON *msg) {
    char *text = cJSON_PrintUnformatted(msg);
    cJSON_Delete(msg);
    if (text == NULL) {
        return false;
    }
    const bool ok = ct_hal_net_send(text);
    cJSON_free(text);
    return ok;
}

void ct_proto_link(bool up) {
    s_up = up;
    s_greeted = false;
    if (up) {
        cJSON *hello = cJSON_CreateObject();
        if (hello != NULL) {
            cJSON_AddStringToObject(hello, "t", "hello");
            cJSON_AddNumberToObject(hello, "proto", CT_PROTO_VERSION);
            cJSON_AddStringToObject(hello, "device", CT_DEVICE_NAME);
            send_json(hello);
        }
    }
}

bool ct_proto_link_up(void) {
    return s_up && s_greeted;
}

static cJSON *action(const char *type, const char *id) {
    if (!ct_proto_link_up() || id == NULL) {
        return NULL;
    }
    cJSON *msg = cJSON_CreateObject();
    if (msg != NULL) {
        cJSON_AddStringToObject(msg, "t", type);
        cJSON_AddStringToObject(msg, "id", id);
    }
    return msg;
}

static uint32_t send_action(cJSON *msg) {
    if (msg == NULL) {
        return 0;
    }
    const uint32_t seq = s_seq++;
    if (s_seq == 0) {
        s_seq = 1;
    }
    cJSON_AddNumberToObject(msg, "seq", seq);
    return send_json(msg) ? seq : 0;
}

uint32_t ct_proto_approve(const char *id, const char *req, bool allow) {
    cJSON *msg = action("approve", id);
    if (msg != NULL) {
        cJSON_AddStringToObject(msg, "req", req);
        cJSON_AddBoolToObject(msg, "allow", allow);
    }
    return send_action(msg);
}

uint32_t ct_proto_answer(const char *id, const char *req, int option) {
    cJSON *msg = action("answer", id);
    if (msg != NULL) {
        cJSON_AddStringToObject(msg, "req", req);
        cJSON_AddNumberToObject(msg, "option", option);
    }
    return send_action(msg);
}

uint32_t ct_proto_reply(const char *id, const char *text) {
    cJSON *msg = action("reply", id);
    if (msg != NULL) {
        cJSON_AddStringToObject(msg, "text", text);
    }
    return send_action(msg);
}

uint32_t ct_proto_seen(const char *id) {
    return send_action(action("seen", id));
}
