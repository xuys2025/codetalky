#include "ct_proto.h"

#include <stdio.h>
#include <string.h>

#include <stdlib.h>

#include "cJSON.h"
#include "ct_arena.h"
#include "ct_hal.h"
#include "ct_model.h"
#include "ct_secure.h"

#ifndef CT_DEVICE_NAME
#define CT_DEVICE_NAME "codetalky"
#endif

/* 1 (the default, and what the real device uses: it only ever connects over the
 * network): every computer must be paired and talk encrypted. 0: a computer may also
 * greet in plain text; only the simulator builds with this, because its bridge
 * trusts connections from its own machine. */
#ifndef CT_REQUIRE_SECURE
#define CT_REQUIRE_SECURE 1
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

/* What a link knows about its computer's security; wiped when the link goes down. */
typedef struct {
    uint8_t nonce[CT_NONCE_BYTES];    /* this connection's challenge */
    uint8_t bridge_pub[CT_KEY_BYTES]; /* the computer's side of a pairing exchange */
    uint8_t commit[CT_KEY_BYTES];
    uint8_t secret[CT_KEY_BYTES]; /* ours */
    uint8_t pub[CT_KEY_BYTES];
    uint8_t r[CT_NONCE_BYTES];
    bool asked;                        /* we asked to pair and wait for the computer's reveal */
    uint8_t new_key[CT_KEY_BYTES];     /* the pairing key, kept once the computer confirms it */
    bool have_new_key;
    uint8_t send_key[CT_KEY_BYTES];
    uint8_t recv_key[CT_KEY_BYTES];
    uint64_t sent, got;
    bool keyed;     /* frames from the computer are encrypted from now on */
    bool confirmed; /* it sent one we could open: ours are encrypted too */
} sec_t;

static struct {
    bool up;
    bool greeted;     /* its bridge said hello on this connection */
    ct_pair_stage_t pair; /* where pairing with this computer stands */
    char host_id[80]; /* from the bridge's auth request */
    char host[CT_HOST_MAX];
    char code[8];
    sec_t sec;
} s_links[CT_MAX_LINKS];
static uint32_t s_seq = 1;

/* ---------- identity and pairing ---------- */

#define STORE_DEVICE_ID "device-id"

/* "key:<hostId>": the key this device and that computer paired with. */
static void key_name(char *buf, size_t size, const char *host_id) {
    snprintf(buf, size, "key:%s", host_id);
}

static void forget_secrets(int link) {
    ct_wipe(&s_links[link].sec, sizeof(s_links[link].sec));
}

/* This device's id: made once, kept in storage. */
static const char *device_id(void) {
    static char id[24];
    if (id[0] == '\0' && !ct_hal_store_get(STORE_DEVICE_ID, id, sizeof(id))) {
        snprintf(id, sizeof(id), "%08lx%08lx", (unsigned long)ct_hal_random(), (unsigned long)ct_hal_random());
        ct_hal_store_set(STORE_DEVICE_ID, id);
    }
    return id;
}

static bool send_json(int link, cJSON *msg);
static const cJSON *field(const cJSON *obj, const char *key);
static const char *raw_string(const cJSON *obj, const char *key);

static void add_hex(cJSON *msg, const char *name, const uint8_t *bytes, size_t n) {
    char hex[2 * CT_KEY_BYTES + 1];
    ct_hex(hex, bytes, n);
    cJSON_AddStringToObject(msg, name, hex);
}

/* Our side of the pairing exchange the computer offered in its auth. The code comes
 * once the user starts pairing there and the computer reveals its value. */
static void ask_to_pair(int link) {
    sec_t *sec = &s_links[link].sec;
    ct_keypair(sec->secret, sec->pub);
    ct_random(sec->r, sizeof(sec->r));
    sec->asked = true;
    s_links[link].pair = CT_PAIR_WAITING;
    s_links[link].code[0] = '\0';
    cJSON *msg = cJSON_CreateObject();
    if (msg != NULL) {
        cJSON_AddStringToObject(msg, "t", "pair");
        add_hex(msg, "pub", sec->pub, CT_KEY_BYTES);
        add_hex(msg, "r", sec->r, CT_NONCE_BYTES);
        send_json(link, msg);
    }
}

/* The computer wants proof (plain, so anyone could have sent it): prove we hold our
 * key for it if we have one, else pair. A refusal of our key never erases it here:
 * the user decides (ct_proto_pair_reset). */
static ct_event_type_t on_auth(int link, const cJSON *msg) {
    sec_t *sec = &s_links[link].sec;
    uint8_t nonce[CT_NONCE_BYTES], pub[CT_KEY_BYTES], commit[CT_KEY_BYTES];
    if (!ct_unhex(nonce, sizeof(nonce), raw_string(msg, "nonce")) || !ct_unhex(pub, sizeof(pub), raw_string(msg, "pub")) ||
        !ct_unhex(commit, sizeof(commit), raw_string(msg, "commit"))) {
        return CT_EV_NONE;
    }
    forget_secrets(link); /* a new challenge: whatever was under way is over */
    memcpy(sec->nonce, nonce, sizeof(nonce));
    memcpy(sec->bridge_pub, pub, sizeof(pub));
    memcpy(sec->commit, commit, sizeof(commit));

    const char *host_id = raw_string(msg, "hostId");
    const char *host = raw_string(msg, "host");
    snprintf(s_links[link].host_id, sizeof(s_links[link].host_id), "%s", host_id != NULL ? host_id : "");
    snprintf(s_links[link].host, sizeof(s_links[link].host), "%s", host != NULL ? host : "电脑");
    char name[96], hex[2 * CT_KEY_BYTES + 1];
    uint8_t key[CT_KEY_BYTES];
    key_name(name, sizeof(name), s_links[link].host_id);
    const bool have_key = ct_hal_store_get(name, hex, sizeof(hex)) && ct_unhex(key, sizeof(key), hex);
    ct_wipe(hex, sizeof(hex));
    if (have_key && cJSON_IsTrue(field(msg, "bad"))) {
        /* That computer doesn't accept our key: unpaired there, or someone posing as it. */
        ct_wipe(key, sizeof(key));
        s_links[link].pair = CT_PAIR_REFUSED;
        return CT_EV_PAIRING;
    }
    if (have_key) {
        uint8_t mine[CT_NONCE_BYTES], proof[CT_KEY_BYTES];
        ct_random(mine, sizeof(mine));
        ct_proof(proof, key, device_id(), s_links[link].host_id, sec->nonce, mine);
        ct_link_keys(sec->send_key, sec->recv_key, key, sec->nonce, mine);
        ct_wipe(key, sizeof(key));
        cJSON *reply = cJSON_CreateObject();
        if (reply != NULL) {
            cJSON_AddStringToObject(reply, "t", "auth");
            add_hex(reply, "nonce", mine, sizeof(mine));
            add_hex(reply, "proof", proof, sizeof(proof));
            send_json(link, reply);
        }
        sec->keyed = true; /* its answer comes encrypted */
        s_links[link].pair = CT_PAIR_NONE;
        return CT_EV_NONE;
    }
    ask_to_pair(link);
    return CT_EV_PAIRING; /* waiting for the user to start pairing on the computer */
}

/* The computer revealed what it committed to: now both sides can work out the code. */
static ct_event_type_t on_pairing(int link, const cJSON *msg) {
    sec_t *sec = &s_links[link].sec;
    uint8_t r[CT_NONCE_BYTES], expected[CT_KEY_BYTES], shared[CT_KEY_BYTES];
    if (!sec->asked || !ct_unhex(r, sizeof(r), raw_string(msg, "r"))) {
        return CT_EV_NONE;
    }
    ct_commit(expected, r);
    if (memcmp(expected, sec->commit, sizeof(expected)) != 0 || !ct_shared(shared, sec->secret, sec->bridge_pub)) {
        return CT_EV_NONE; /* not what it committed to: no code to show */
    }
    sec->asked = false;
    ct_pair_code(s_links[link].code, sec->pub, sec->bridge_pub, sec->r, r);
    ct_pair_key(sec->new_key, shared, sec->pub, sec->bridge_pub, sec->r, r);
    sec->have_new_key = true;
    ct_link_keys(sec->send_key, sec->recv_key, sec->new_key, sec->nonce, sec->r);
    sec->keyed = true;
    ct_wipe(shared, sizeof(shared));
    ct_wipe(sec->secret, sizeof(sec->secret));
    s_links[link].pair = CT_PAIR_CODE;
    return CT_EV_PAIRING;
}

/* The first frame we could open: whoever sent it holds the key. For a new key that
 * proves nothing about who they are (whoever we exchanged with has it), so the user
 * confirms on the device that the computer said it paired before it is kept. */
static ct_event_type_t on_confirmed(int link) {
    sec_t *sec = &s_links[link].sec;
    sec->confirmed = true;
    if (!sec->have_new_key) {
        return CT_EV_NONE;
    }
    s_links[link].pair = CT_PAIR_CONFIRM;
    return CT_EV_PAIRING;
}

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

static const ct_para_t *parse_paras(ct_arena_t *a, const cJSON *arr, int *count);

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
    } else if (strcmp(kind, "plan") == 0) {
        ask->kind = CT_ASK_PLAN;
        ask->plan = parse_paras(a, field(obj, "plan"), &ask->plan_count);
        ask->until = time_of(obj, "until");
    } else if (strcmp(kind, "question") == 0) {
        ask->kind = CT_ASK_QUESTION;
        ask->text = str(a, obj, "text", LEN_TEXT);
        ask->note = opt_str(a, obj, "note", LEN_TEXT);
        ask->multi = cJSON_IsTrue(field(obj, "multi"));
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

/* Paragraphs of a report or a plan. */
static const ct_para_t *parse_paras(ct_arena_t *a, const cJSON *arr, int *count) {
    *count = 0;
    const int n = array_len(arr, MAX_REPORT);
    ct_para_t *paras = n > 0 ? ct_arena_alloc(a, (size_t)n * sizeof(*paras)) : NULL;
    if (paras == NULL) {
        return NULL;
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
    *count = i;
    return paras;
}

static void parse_report(ct_arena_t *a, ct_session_t *s, const cJSON *arr) {
    s->report = parse_paras(a, arr, &s->report_count);
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
    s->there = cJSON_IsTrue(field(j, "there"));

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

static bool valid_link(int link) {
    return link >= 0 && link < CT_MAX_LINKS;
}

static void on_hello(int link, const cJSON *msg) {
    ct_model_set_time(time_of(msg, "time"), int_of(msg, "tz", 0));
    const char *host = raw_string(msg, "host");
    ct_model_set_host(link, host != NULL && host[0] != '\0' ? host : "电脑");
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
    ct_model_set_quick(link, texts, count);
    /* Sessions not re-sent before "ready" have ended while we were away. */
    ct_model_mark_stale(link);
}

static bool is_hex(const char *s, size_t len) {
    if (s == NULL || strlen(s) != len) return false;
    for (size_t i = 0; i < len; i++) {
        const char c = s[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    }
    return true;
}

/* New firmware from this computer: hand it to the platform if it looks sane. */
static void on_update(int link, const cJSON *msg) {
    const char *path = raw_string(msg, "path");
    const char *sha = raw_string(msg, "sha256");
    const char *version = raw_string(msg, "version");
    const double size = number(msg, "size", 0);
    if (path == NULL || strncmp(path, "/firmware/", 10) != 0 || strlen(path) > 100 || strstr(path, "..") != NULL ||
        !is_hex(sha, 64) || size < 1024 || size > 8 * 1024 * 1024) {
        return;
    }
    ct_hal_firmware_update(link, path, (uint32_t)size, sha, version != NULL ? version : "");
}

/* One frame's JSON. sealed: it came encrypted. */
static ct_event_t handle(int link, const char *json, size_t len, bool sealed) {
    ct_event_t ev = {0};
    cJSON *msg = cJSON_ParseWithLength(json, len);
    if (msg == NULL) {
        return ev;
    }
    const char *t = raw_string(msg, "t");
    const sec_t *sec = &s_links[link].sec;
    /* Plain text counts only before the link is encrypted, and then only a challenge
     * (a new one, or a refused proof), the computer's reveal, or (if allowed) a greeting. */
    const bool plain_ok = !sec->keyed || !sec->confirmed;
    if (t == NULL || (!sealed && !plain_ok)) {
        /* ignore */
    } else if (!sealed && sec->keyed && strcmp(t, "auth") != 0) {
        /* waiting for the encrypted answer: only a new challenge may come plain */
    } else if (!sealed && CT_REQUIRE_SECURE && strcmp(t, "auth") != 0 && strcmp(t, "pairing") != 0) {
        /* this device only talks encrypted */
    } else if (strcmp(t, "auth") == 0) {
        if (!sealed) ev.type = on_auth(link, msg);
    } else if (strcmp(t, "pairing") == 0) {
        if (!sealed) ev.type = on_pairing(link, msg);
    } else if (strcmp(t, "paired") == 0) {
        /* on_confirmed() has asked the user to confirm it on the device */
    } else if (strcmp(t, "hello") == 0) {
        if (int_of(msg, "proto", -1) != CT_PROTO_VERSION) {
            ev.type = CT_EV_BAD_PROTO;
        } else {
            on_hello(link, msg);
            s_links[link].greeted = true;
            ev.type = CT_EV_HELLO;
        }
    } else if (!s_links[link].greeted) {
        /* Nothing counts before the bridge's hello. */
    } else if (strcmp(t, "session") == 0) {
        ct_session_t *s = parse_session(field(msg, "s"));
        if (s != NULL) {
            s->link = (uint8_t)link;
            ct_model_put(s);
            ev.type = CT_EV_CHANGED;
        }
    } else if (strcmp(t, "gone") == 0) {
        const char *id = raw_string(msg, "id");
        if (id != NULL) {
            ct_model_remove(link, id);
            ev.type = CT_EV_CHANGED;
        }
    } else if (strcmp(t, "ready") == 0) {
        ct_model_purge_stale(link);
        ev.type = CT_EV_READY;
    } else if (strcmp(t, "update") == 0) {
        /* The hash in this message is what makes the plain download safe: encrypted only. */
        if (sealed) on_update(link, msg);
    } else if (strcmp(t, "ack") == 0) {
        ev.type = CT_EV_ACK;
        ev.seq = (uint32_t)number(msg, "seq", 0);
        ev.ack = cJSON_IsTrue(field(msg, "ok")) ? CT_ACK_OK : ack_of(raw_string(msg, "err"));
    }
    cJSON_Delete(msg);
    return ev;
}

ct_event_t ct_proto_receive(int link, const char *frame, size_t len) {
    ct_event_t ev = {0};
    if (!valid_link(link) || len == 0) {
        return ev;
    }
    sec_t *sec = &s_links[link].sec;
    if (frame[0] != 'E') {
        return handle(link, frame, len, false);
    }
    size_t text_len = 0;
    char *text = sec->keyed ? ct_open(sec->recv_key, sec->got, frame + 1, len - 1, &text_len) : NULL;
    if (text == NULL) {
        /* Not genuine, or out of order: nothing more from this connection can be trusted. */
        ct_hal_net_close(link);
        return ev;
    }
    sec->got++;
    const bool first = !sec->confirmed;
    ct_event_type_t paired = first ? on_confirmed(link) : CT_EV_NONE;
    ev = handle(link, text, text_len, true);
    ct_wipe(text, text_len);
    free(text);
    if (paired != CT_EV_NONE && ev.type == CT_EV_NONE) {
        ev.type = paired; /* "paired" itself carries nothing else */
    }
    return ev;
}

/* ---------- outgoing ---------- */

static bool send_json(int link, cJSON *msg) {
    char *text = cJSON_PrintUnformatted(msg);
    cJSON_Delete(msg);
    if (text == NULL) {
        return false;
    }
    sec_t *sec = &s_links[link].sec;
    bool ok;
    if (sec->confirmed) {
        char *frame = ct_seal(sec->send_key, sec->sent, text, strlen(text));
        ok = frame != NULL && ct_hal_net_send(link, frame);
        if (ok) sec->sent++;
        free(frame);
    } else {
        ok = ct_hal_net_send(link, text);
    }
    cJSON_free(text);
    return ok;
}

static void say_hello(int link) {
    cJSON *hello = cJSON_CreateObject();
    if (hello != NULL) {
        cJSON_AddStringToObject(hello, "t", "hello");
        cJSON_AddNumberToObject(hello, "proto", CT_PROTO_VERSION);
        cJSON_AddStringToObject(hello, "device", CT_DEVICE_NAME);
        cJSON_AddStringToObject(hello, "deviceId", device_id());
        const char *fw = ct_hal_firmware_version();
        if (fw != NULL) {
            cJSON_AddStringToObject(hello, "fw", fw);
        }
        send_json(link, hello);
    }
}

void ct_proto_link(int link, bool up) {
    if (!valid_link(link)) {
        return;
    }
    s_links[link].up = up;
    s_links[link].greeted = false;
    s_links[link].pair = CT_PAIR_NONE;
    forget_secrets(link);
    if (up) {
        say_hello(link);
    }
}

ct_pair_stage_t ct_proto_pair_stage(int link) {
    return valid_link(link) && s_links[link].up ? s_links[link].pair : CT_PAIR_NONE;
}

bool ct_proto_pairing(int link) {
    return ct_proto_pair_stage(link) != CT_PAIR_NONE;
}

const char *ct_proto_pair_code(int link) {
    return ct_proto_pair_stage(link) == CT_PAIR_CODE ? s_links[link].code : "";
}

const char *ct_proto_pair_host(int link) {
    return valid_link(link) ? s_links[link].host : "";
}

void ct_proto_pair_again(int link) {
    /* A new hello gets a new challenge and a new exchange, hence a new code; the old
     * code stays on screen until then. */
    const ct_pair_stage_t stage = ct_proto_pair_stage(link);
    if (stage == CT_PAIR_WAITING || stage == CT_PAIR_CODE) {
        forget_secrets(link);
        say_hello(link);
    }
}

void ct_proto_pair_confirm(int link, bool yes) {
    if (ct_proto_pair_stage(link) != CT_PAIR_CONFIRM) {
        return;
    }
    sec_t *sec = &s_links[link].sec;
    s_links[link].pair = CT_PAIR_NONE;
    if (!yes || !sec->have_new_key) {
        /* The computer never said so: whoever sent "paired" is not the user's computer. */
        forget_secrets(link);
        ct_hal_net_close(link);
        return;
    }
    char name[96], hex[2 * CT_KEY_BYTES + 1];
    key_name(name, sizeof(name), s_links[link].host_id);
    ct_hex(hex, sec->new_key, CT_KEY_BYTES);
    ct_hal_store_set(name, hex);
    ct_wipe(hex, sizeof(hex));
    ct_wipe(sec->new_key, sizeof(sec->new_key));
    sec->have_new_key = false;
    /* Tell the computer (encrypted with the new key): it starts sending sessions. */
    cJSON *msg = cJSON_CreateObject();
    if (msg != NULL) {
        cJSON_AddStringToObject(msg, "t", "paired");
        send_json(link, msg);
    }
}

void ct_proto_pair_reset(int link) {
    if (ct_proto_pair_stage(link) != CT_PAIR_REFUSED) {
        return;
    }
    char name[96];
    key_name(name, sizeof(name), s_links[link].host_id);
    ct_hal_store_set(name, NULL);
    ask_to_pair(link); /* with the challenge that came with the refusal */
}

bool ct_proto_link_up(int link) {
    return valid_link(link) && s_links[link].up && s_links[link].greeted;
}

static cJSON *action(int link, const char *type, const char *id) {
    if (!ct_proto_link_up(link) || id == NULL) {
        return NULL;
    }
    cJSON *msg = cJSON_CreateObject();
    if (msg != NULL) {
        cJSON_AddStringToObject(msg, "t", type);
        cJSON_AddStringToObject(msg, "id", id);
    }
    return msg;
}

static uint32_t send_action(int link, cJSON *msg) {
    if (msg == NULL) {
        return 0;
    }
    const uint32_t seq = s_seq++;
    if (s_seq == 0) {
        s_seq = 1;
    }
    cJSON_AddNumberToObject(msg, "seq", seq);
    return send_json(link, msg) ? seq : 0;
}

uint32_t ct_proto_approve(int link, const char *id, const char *req, bool allow) {
    cJSON *msg = action(link, "approve", id);
    if (msg != NULL) {
        cJSON_AddStringToObject(msg, "req", req);
        cJSON_AddBoolToObject(msg, "allow", allow);
    }
    return send_action(link, msg);
}

uint32_t ct_proto_answer(int link, const char *id, const char *req, int option) {
    cJSON *msg = action(link, "answer", id);
    if (msg != NULL) {
        cJSON_AddStringToObject(msg, "req", req);
        cJSON_AddNumberToObject(msg, "option", option);
    }
    return send_action(link, msg);
}

uint32_t ct_proto_send_back(int link, const char *id, const char *req, const char *text) {
    cJSON *msg = action(link, "approve", id);
    if (msg != NULL) {
        cJSON_AddStringToObject(msg, "req", req);
        cJSON_AddBoolToObject(msg, "allow", false);
        if (text != NULL && text[0] != '\0') {
            cJSON_AddStringToObject(msg, "text", text);
        }
    }
    return send_action(link, msg);
}

uint32_t ct_proto_answer_many(int link, const char *id, const char *req, const int *options, int count) {
    cJSON *msg = action(link, "answer", id);
    if (msg != NULL) {
        cJSON_AddStringToObject(msg, "req", req);
        cJSON *list = cJSON_AddArrayToObject(msg, "options");
        for (int i = 0; list != NULL && i < count; i++) {
            cJSON_AddItemToArray(list, cJSON_CreateNumber(options[i]));
        }
    }
    return send_action(link, msg);
}

uint32_t ct_proto_answer_text(int link, const char *id, const char *req, const char *text) {
    cJSON *msg = action(link, "answer", id);
    if (msg != NULL) {
        cJSON_AddStringToObject(msg, "req", req);
        cJSON_AddStringToObject(msg, "text", text);
    }
    return send_action(link, msg);
}

uint32_t ct_proto_reply(int link, const char *id, const char *text) {
    cJSON *msg = action(link, "reply", id);
    if (msg != NULL) {
        cJSON_AddStringToObject(msg, "text", text);
    }
    return send_action(link, msg);
}

uint32_t ct_proto_seen(int link, const char *id) {
    return send_action(link, action(link, "seen", id));
}
