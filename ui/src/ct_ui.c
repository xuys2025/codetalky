/*
 * CodeTalky screens and navigation.
 *
 * Every action can be done by touch; the hardware keys are shortcuts:
 * volume up/down and the PREV/NEXT touch keys turn pages, HOME returns to the
 * session list, BOOT is push-to-talk.
 *
 * Screens are rebuilt from the model (what the bridge last sent): with a fast
 * refresh when you move between screens, and with a partial refresh when the
 * data on the current screen changes. Sessions are looked up by id every time;
 * nothing keeps a pointer into a session across updates.
 */
#include "ct_ui.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "ct_hal.h"
#include "ct_model.h"
#include "ct_proto.h"
#include "ct_text.h"
#include "ct_widgets.h"

#define LIST_ROWS 6
#define ACTIVITY_ROWS 12
#define FILE_ROWS 4
#define APPROVE_LINES 9
#define POLL_MS 200
#define MIN_REDRAW_MS 600  /* e-ink: don't redraw more often than this */
#define ACK_TIMEOUT_MS 2000
#define FAST_EVERY 12      /* after this many partial refreshes, a fast one clears ghosting */
#define LONG_PRESS_MS 600

typedef enum {
    SCR_NONE,
    SCR_LIST,
    SCR_DETAIL,
    SCR_APPROVE,
    SCR_QUESTION,
    SCR_DONE,
    SCR_REPLY,
    SCR_VOICE,
    SCR_ENTRY, /* one activity entry in full */
    SCR_DIFF,  /* the whole change a permission request would make */
    SCR_PAIR,  /* a computer wants this device to pair */
} screen_id_t;

/* Pairing: the screen shows the code of one computer that asked. A code is good for
 * five minutes on the computer; a fresh one is requested a little before that. */
#define PAIR_REFRESH_MS (280 * 1000)
static int s_pair_link = -1;
static uint32_t s_pair_since;
static bool s_pair_later[CT_MAX_LINKS]; /* "以后再说": don't pop the screen up again */

static screen_id_t s_screen = SCR_NONE;
static screen_id_t s_reply_from = SCR_LIST;
/* A session is found by the computer (link) it is on and its id there. */
typedef struct {
    int link;
    char id[CT_ID_MAX];
} sel_t;

static sel_t s_sel; /* the session on screen */
static char s_req[CT_REQ_MAX]; /* the request shown on the approve or question screen */
static sel_t s_rows[LIST_ROWS];
static int s_tab;  /* detail tab: 0 overview, 1 activity, 2 changes */
static int s_page; /* page within the current list */
static const char *s_banner; /* one line at the bottom of the list, until you leave it */

/* Connections to computers. A computer that has been gone this long is forgotten,
 * so a short Wi-Fi drop doesn't empty and refill the list. */
#define LINK_GRACE_MS (5 * 60 * 1000)
static struct {
    bool seen;      /* the platform has told us about this link */
    bool up;        /* connected */
    bool synced;    /* and its bridge has sent every session */
    bool bad_proto; /* its bridge is a different version */
    uint32_t down_at;
} s_links[CT_MAX_LINKS];
static bool s_resynced; /* everything was just re-sent: the next redraw replaces the whole page */

/* An action waiting for its ack. */
static struct {
    uint32_t seq;
    int link;
    uint32_t sent_at;
} s_pending;

/* What the current screen was drawn from. When it changes, the screen is redrawn. */
typedef struct {
    uint32_t rev;
    int64_t minute;
    uint32_t links; /* up and synced bits of every link */
} draw_key_t;
static draw_key_t s_drawn;
static uint32_t s_drawn_at;
static int s_partials;
static ct_refresh_t s_next_refresh = CT_REFRESH_FAST;

/* Pending requests already announced with a buzz. */
static uint32_t s_announced[CT_MAX_SESSIONS];
static int s_announced_count;
static uint32_t s_announced_rev;

/* Placeholder until speech recognition exists (phase 3). */
static const char *s_heard = "把刚才失败的两个测试修好，然后重新跑一遍。";

static void show_list(void);
static void show_detail(void);
static void show_approve(void);
static void show_question(void);
static void show_done(void);
static void show_reply(void);
static void show_voice(void);
static void show_entry(void);
static void show_diff(void);
static void show_pair(void);

/* The activity entry on the entry screen. Entries have no id and the log shifts as
 * new ones arrive, so it is found again by its time, verb and target. */
static struct {
    int64_t at;
    char verb[24];
    char target[96];
    int from_page; /* activity page to go back to */
} s_entry;

static int s_done_pages = 1; /* pages of the report on the done screen */

/* ---------- state ---------- */

static const ct_session_t *current(void) {
    return ct_model_find(s_sel.link, s_sel.id);
}

static void select_session(sel_t *sel, const ct_session_t *s) {
    sel->link = s->link;
    snprintf(sel->id, sizeof(sel->id), "%s", s->id);
}

/* How many computers are known, connected, and fully synced. */
static int links_seen(void) {
    int n = 0;
    for (int i = 0; i < CT_MAX_LINKS; i++) n += s_links[i].seen ? 1 : 0;
    return n;
}

static int links_up(void) {
    int n = 0;
    for (int i = 0; i < CT_MAX_LINKS; i++) n += s_links[i].up ? 1 : 0;
    return n;
}

static bool any_synced(void) {
    for (int i = 0; i < CT_MAX_LINKS; i++) {
        if (s_links[i].up && s_links[i].synced) return true;
    }
    return false;
}

/* A computer waiting for this device to pair, or -1. */
static int pairing_link(void) {
    for (int i = 0; i < CT_MAX_LINKS; i++) {
        if (ct_proto_pairing(i)) return i;
    }
    return -1;
}

static bool any_bad_proto(void) {
    for (int i = 0; i < CT_MAX_LINKS; i++) {
        if (s_links[i].bad_proto) return true;
    }
    return false;
}

/* "笔记本", or "笔记本（离线）" while its computer is unreachable. */
static const char *host_label(int link, char *buf, size_t size) {
    snprintf(buf, size, "%s%s", ct_model_host(link), ct_proto_link_up(link) ? "" : "（离线）");
    return buf;
}

/* "台式机 · " when the device knows several computers, so every line says which one. */
static const char *host_prefix(const ct_session_t *s, char *buf, size_t size) {
    if (ct_model_many_hosts()) {
        char host[CT_HOST_MAX + 16];
        snprintf(buf, size, "%s · ", host_label(s->link, host, sizeof(host)));
    } else if (size > 0) {
        buf[0] = '\0';
    }
    return buf;
}

static bool is_waiting(ct_state_t state) {
    return state == CT_STATE_WAIT_APPROVE || state == CT_STATE_WAIT_ANSWER;
}

static bool wants_approval(const ct_session_t *s) {
    return s->state == CT_STATE_WAIT_APPROVE && s->ask.kind == CT_ASK_APPROVE;
}

static bool wants_answer(const ct_session_t *s) {
    return s->state == CT_STATE_WAIT_ANSWER && s->ask.kind == CT_ASK_QUESTION;
}

static const char *req_of(const ct_session_t *s) {
    return s->ask.req != NULL ? s->ask.req : "";
}

static draw_key_t key_now(void) {
    draw_key_t k = {0};
    k.minute = ct_model_now() / 60;
    for (int i = 0; i < CT_MAX_LINKS; i++) {
        k.links |= (s_links[i].up ? 1u : 0u) << (3 * i);
        k.links |= (s_links[i].synced ? 2u : 0u) << (3 * i);
        k.links |= (ct_proto_pairing(i) ? 4u : 0u) << (3 * i);
    }
    if (s_screen == SCR_LIST) {
        k.rev = ct_model_rev();
    } else {
        const ct_session_t *s = current();
        k.rev = s != NULL ? s->rev : 0;
    }
    return k;
}

static bool key_eq(draw_key_t a, draw_key_t b) {
    return a.rev == b.rev && a.minute == b.minute && a.links == b.links;
}

static bool input_pressed(void) {
    for (lv_indev_t *i = lv_indev_get_next(NULL); i != NULL; i = lv_indev_get_next(i)) {
        if (lv_indev_get_state(i) == LV_INDEV_STATE_PRESSED) {
            return true;
        }
    }
    return false;
}

/* ---------- words ---------- */

static const char *state_text(ct_state_t state) {
    switch (state) {
    case CT_STATE_RUNNING: return "运行中";
    case CT_STATE_WAIT_APPROVE: return "等批准";
    case CT_STATE_WAIT_ANSWER: return "等回答";
    case CT_STATE_DONE: return "完成";
    case CT_STATE_ERROR: return "出错";
    default: return "空闲";
    }
}

static void fmt_counts(char *buf, size_t size, const ct_session_t *s) {
    snprintf(buf, size, "读 %d · 改 %d", s->n.read, s->n.edit + s->n.created);
}

static void fmt_summary(char *buf, size_t size, const ct_session_t *s) {
    snprintf(buf, size, "读 %d · 改 %d · 新 %d · 命令 %d", s->n.read, s->n.edit, s->n.created, s->n.cmd);
}

/* prefix + how long ago, or "刚刚" under a minute. */
static void fmt_ago(char *buf, size_t size, const char *prefix, int64_t since) {
    const int64_t seconds = ct_model_now() - since;
    if (seconds < 60) {
        snprintf(buf, size, "刚刚");
        return;
    }
    char span[24];
    ct_fmt_span(span, sizeof(span), seconds);
    snprintf(buf, size, "%s%s", prefix, span);
}

static void fmt_task(char *buf, size_t size, const ct_session_t *s) {
    const int current_task = s->todo_done < s->todo_count ? s->todo_done + 1 : s->todo_count;
    snprintf(buf, size, "任务 %d/%d", current_task, s->todo_count);
}

static void fmt_took(char *buf, size_t size, const ct_session_t *s) {
    char span[24];
    ct_fmt_span(span, sizeof(span), s->since - s->started);
    snprintf(buf, size, "用时 %s", span);
}

/* Right side of a list row. */
static void fmt_when(char *buf, size_t size, const ct_session_t *s) {
    char a[32], b[24];
    switch (s->state) {
    case CT_STATE_WAIT_APPROVE:
    case CT_STATE_WAIT_ANSWER: fmt_ago(buf, size, "等了 ", s->since); break;
    case CT_STATE_RUNNING:
        ct_fmt_span(a, sizeof(a), ct_model_now() - s->started);
        if (s->todo_count > 0) {
            fmt_task(b, sizeof(b), s);
            snprintf(buf, size, "%s · %s", a, b);
        } else {
            snprintf(buf, size, "%s", a);
        }
        break;
    case CT_STATE_DONE: fmt_took(buf, size, s); break;
    case CT_STATE_ERROR: fmt_ago(buf, size, "停了 ", s->since); break;
    default: fmt_ago(buf, size, "空闲 ", s->since); break;
    }
}

/* Right side of the line under a session's title. */
static void fmt_meta_right(char *buf, size_t size, const ct_session_t *s) {
    char a[32], b[32];
    switch (s->state) {
    case CT_STATE_RUNNING:
        ct_fmt_span(a, sizeof(a), ct_model_now() - s->started);
        if (s->ctx >= 0) {
            snprintf(buf, size, "%s · 上下文 %d%%", a, s->ctx);
        } else {
            snprintf(buf, size, "%s", a);
        }
        break;
    case CT_STATE_WAIT_APPROVE:
    case CT_STATE_WAIT_ANSWER:
        fmt_ago(b, sizeof(b), "等了 ", s->since);
        if (s->todo_count > 0) {
            fmt_task(a, sizeof(a), s);
            snprintf(buf, size, "%s · %s", a, b);
        } else {
            snprintf(buf, size, "%s", b);
        }
        break;
    default: fmt_when(buf, size, s); break;
    }
}

static const char *ack_text(ct_ack_t ack) {
    switch (ack) {
    case CT_ACK_OK: return NULL;
    case CT_ACK_GONE: return "会话已经结束，没有生效";
    case CT_ACK_STALE: return "请求已经变了，这次没生效";
    case CT_ACK_UNSUPPORTED: return "这个会话不能从设备操作";
    case CT_ACK_TIMEOUT: return "电脑没回应，不确定是否生效";
    case CT_ACK_OFFLINE: return "连接断了，不确定是否生效";
    default: return "电脑没接受这次操作";
    }
}

/* ---------- screen plumbing ---------- */

static void present(lv_obj_t *screen, screen_id_t id) {
    lv_obj_t *old = lv_screen_active();
    if (id != SCR_LIST) {
        s_banner = NULL;
    }
    s_screen = id;
    if (s_next_refresh == CT_REFRESH_PARTIAL) {
        s_partials++;
    } else {
        s_partials = 0;
    }
    ct_hal_refresh_hint(s_next_refresh);
    s_next_refresh = CT_REFRESH_FAST;
    lv_screen_load(screen);
    if (old != NULL && old != screen) {
        lv_obj_delete_async(old);
    }
    s_drawn = key_now();
    s_drawn_at = lv_tick_get();
}

static void status_bar(lv_obj_t *screen) {
    char clock[8], right[32];
    ct_fmt_clock(clock, sizeof(clock), ct_model_now());
    const int battery = ct_hal_battery_percent();
    if (battery >= 0) {
        snprintf(right, sizeof(right), "%s · %d%%", clock, battery);
    } else {
        snprintf(right, sizeof(right), "%s", clock);
    }
    char left[48];
    const int seen = links_seen();
    const int up = links_up();
    if (up == 0) {
        snprintf(left, sizeof(left), "codetalky · 未连接");
    } else if (seen > 1 && up < seen) {
        snprintf(left, sizeof(left), "codetalky · %d/%d 台在线", up, seen);
    } else if (seen > 1) {
        snprintf(left, sizeof(left), "codetalky · %d 台电脑", seen);
    } else {
        snprintf(left, sizeof(left), "codetalky");
    }
    ct_status_bar(screen, left, right);
}

static void state_chip(lv_obj_t *parent, ct_state_t state) {
    /* Only sessions waiting for the user are shown white-on-black. */
    ct_chip(parent, state_text(state), is_waiting(state), state == CT_STATE_RUNNING);
}

static void header(lv_obj_t *screen, const ct_session_t *s, lv_event_cb_t on_back) {
    status_bar(screen);
    lv_obj_t *nav = ct_nav(screen, s->name, on_back);
    state_chip(nav, s->state);
}

static void agent_meta(lv_obj_t *screen, const ct_session_t *s, const char *right) {
    char buf[128], host[CT_HOST_MAX + 24];
    snprintf(buf, sizeof(buf), "%s%s · %s", host_prefix(s, host, sizeof(host)), s->agent, s->model);
    ct_meta(screen, buf, right);
}

/* A paragraph cut to max_lines, ending in dots. */
static lv_obj_t *short_paragraph(lv_obj_t *parent, const lv_font_t *font, const char *text, int max_lines) {
    lv_obj_t *label = ct_paragraph(parent, font, text);
    const int32_t line = lv_font_get_line_height(font) + 3;
    lv_obj_update_layout(label);
    if (lv_obj_get_height(label) > line * max_lines) {
        lv_label_set_long_mode(label, LV_LABEL_LONG_MODE_DOTS);
        lv_obj_set_height(label, line * max_lines - 3);
    }
    return label;
}

static void open_session(const ct_session_t *s) {
    if (wants_approval(s)) {
        show_approve();
    } else if (wants_answer(s)) {
        show_question();
    } else if (s->state == CT_STATE_DONE) {
        show_done();
    } else {
        show_detail();
    }
}

static void session_gone(void) {
    s_next_refresh = CT_REFRESH_FAST;
    s_banner = "这个会话已经结束";
    show_list();
}

/* ---------- actions ---------- */

static void finish_action(ct_ack_t ack) {
    s_pending.seq = 0;
    s_next_refresh = CT_REFRESH_FAST;
    s_banner = ack_text(ack);
    show_list();
}

/* After a tap the screen stays put until the bridge answers (usually within tens of
 * milliseconds), then goes to the list in one refresh showing the new state. */
static void await_ack(uint32_t seq) {
    if (seq == 0) {
        finish_action(ct_proto_link_up(s_sel.link) ? CT_ACK_BAD : CT_ACK_OFFLINE);
        return;
    }
    s_pending.seq = seq;
    s_pending.link = s_sel.link;
    s_pending.sent_at = lv_tick_get();
}

static void on_back_list(lv_event_t *e) { (void)e; show_list(); }
static void on_back_reply(lv_event_t *e) { (void)e; show_reply(); }

static void on_back_from_reply(lv_event_t *e) {
    (void)e;
    switch (s_reply_from) {
    case SCR_DONE: show_done(); break;
    case SCR_DETAIL: show_detail(); break;
    case SCR_QUESTION: show_question(); break;
    default: show_list(); break;
    }
}

static void on_open_reply(lv_event_t *e) {
    (void)e;
    s_reply_from = s_screen;
    show_reply();
}

/* ---------- session list ---------- */

static void on_row(lv_event_t *e) {
    const int slot = (int)(intptr_t)lv_event_get_user_data(e);
    const ct_session_t *s = ct_model_find(s_rows[slot].link, s_rows[slot].id);
    if (s == NULL) {
        return;
    }
    select_session(&s_sel, s);
    s_tab = 0;
    s_page = 0;
    open_session(s);
}

/* The second line of a row: what the session is doing or wants. */
static void row_doing(lv_obj_t *row, const ct_session_t *s) {
    if (wants_approval(s)) {
        ct_verb(row, s->ask.verb);
        ct_label_fill(row, M20, s->ask.target);
    } else if (wants_answer(s)) {
        ct_verb(row, "问");
        ct_label_fill(row, F20, s->ask.text);
    } else if ((s->state == CT_STATE_DONE || s->state == CT_STATE_IDLE) && s->report_count > 0) {
        ct_label_fill(row, F20, s->report[0].text);
    } else if (s->state == CT_STATE_ERROR && s->err != NULL) {
        ct_label_fill(row, F20, s->err);
    } else if (s->state == CT_STATE_RUNNING && s->now.verb != NULL) {
        ct_verb(row, s->now.verb);
        ct_label_fill(row, M20, s->now.target);
    } else {
        ct_label_fill(row, F20, s->say != NULL ? s->say : "等你的下一步");
    }
}

static void session_row(lv_obj_t *parent, const ct_session_t *s, int slot) {
    select_session(&s_rows[slot], s);
    lv_obj_t *row = ct_col(parent, CT_PAD, 3);
    lv_obj_set_height(row, 104);
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);
    ct_border(row, 2, LV_BORDER_SIDE_BOTTOM);

    char buf[96], stat[32];
    lv_obj_t *r1 = ct_row(row, 28, 0, 10);
    ct_label(r1, MB20, s->name);
    if (ct_model_many_hosts()) {
        /* Which computer matters more than which agent: the model name says that too. */
        char host[CT_HOST_MAX + 16];
        snprintf(buf, sizeof(buf), "%s · %s", host_label(s->link, host, sizeof(host)), s->model);
    } else {
        snprintf(buf, sizeof(buf), "%s · %s", s->agent, s->model);
    }
    ct_label_fill(r1, M18, buf);
    state_chip(r1, s->state);

    lv_obj_t *r2 = ct_row(row, 28, 0, 8);
    row_doing(r2, s);
    ct_label(r2, MB24, "›");

    lv_obj_t *r3 = ct_row(row, 24, 0, 8);
    fmt_counts(buf, sizeof(buf), s);
    ct_fmt_stat(stat, sizeof(stat), s->n.add, s->n.del);
    if (stat[0] != '\0') {
        const size_t len = strlen(buf);
        snprintf(buf + len, sizeof(buf) - len, " · %s", stat);
    }
    ct_label_fill(r3, M18, buf);
    fmt_when(buf, sizeof(buf), s);
    ct_label(r3, M18, buf);

    ct_tappable(row, on_row, (void *)(intptr_t)slot);
}

static int list_pages(void) {
    const int pages = (ct_model_count() + LIST_ROWS - 1) / LIST_ROWS;
    return pages > 0 ? pages : 1;
}

static void on_list_prev(lv_event_t *e) {
    (void)e;
    if (s_page > 0) {
        s_page--;
        show_list();
    }
}

static void on_list_next(lv_event_t *e) {
    (void)e;
    if (s_page + 1 < list_pages()) {
        s_page++;
        show_list();
    }
}

static void empty_state(lv_obj_t *content, const char *title, const char *hint) {
    lv_obj_t *box = ct_col(content, CT_PAD, 12);
    lv_obj_set_style_pad_top(box, 150, 0);
    lv_obj_t *t = ct_paragraph(box, B24, title);
    lv_obj_set_style_text_align(t, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_t *h = ct_paragraph(box, F20, hint);
    lv_obj_set_style_text_align(h, LV_TEXT_ALIGN_CENTER, 0);
}

static void show_list(void) {
    const int count = ct_model_count();
    if (s_screen != SCR_LIST) {
        s_page = 0;
    }
    if (s_page >= list_pages()) {
        s_page = list_pages() - 1;
    }
    int waiting = 0;
    for (int i = 0; i < count; i++) {
        waiting += is_waiting(ct_model_at(i)->state) ? 1 : 0;
    }

    lv_obj_t *screen = ct_screen_new();
    status_bar(screen);
    char buf[48];
    snprintf(buf, sizeof(buf), "会话 %d", count);
    lv_obj_t *nav = ct_nav(screen, buf, NULL);
    if (waiting > 0) {
        snprintf(buf, sizeof(buf), "%d 个等你", waiting);
        ct_chip(nav, buf, true, false);
    }

    lv_obj_t *content = ct_content(screen, 0);
    if (count == 0) {
        if (any_bad_proto() && links_up() == 0) {
            empty_state(content, "版本对不上", "电脑上的 codetalky 和设备不是同一个版本，更新到同一版本后再连。");
        } else if (links_up() == 0) {
            empty_state(content, "没连上电脑", "确认电脑上的 codetalky 在运行，并且和设备在同一个 Wi-Fi 下。正在自动重连。");
        } else if (!any_synced() && pairing_link() >= 0) {
            const int link = pairing_link();
            char hint[160];
            snprintf(hint, sizeof(hint), "在“%s”上运行 codetalky pair %s", ct_proto_pair_host(link), ct_proto_pair_code(link));
            empty_state(content, "还没和电脑配对", hint);
        } else if (!any_synced()) {
            empty_state(content, "正在同步", "电脑正在发来会话列表。");
        } else if (links_seen() > 1) {
            empty_state(content, "电脑上都没有会话", "在任意一台电脑上用 codetalky claude 或 codetalky codex 启动一个，这里就会出现。");
        } else {
            empty_state(content, "电脑上没有会话", "在电脑上用 codetalky claude 或 codetalky codex 启动一个，这里就会出现。");
        }
    }
    const int first = s_page * LIST_ROWS;
    for (int i = first; i < count && i < first + LIST_ROWS; i++) {
        session_row(content, ct_model_at(i), i - first);
    }

    lv_obj_t *bar = ct_bottom_bar(screen, 76);
    if (count > 0) {
        snprintf(buf, sizeof(buf), "%d/%d", s_page + 1, list_pages());
        ct_pager(bar, buf, on_list_prev, on_list_next);
    }
    ct_spacer(bar);
    if (s_banner != NULL) {
        lv_obj_t *note = ct_box(bar);
        lv_obj_set_size(note, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
        lv_obj_set_style_pad_hor(note, 8, 0);
        lv_obj_set_style_pad_ver(note, 4, 0);
        ct_invert(note);
        ct_label(note, F18, s_banner);
    } else if (count > 0) {
        ct_label(bar, F18, "点一行看详情");
    }
    present(screen, SCR_LIST);
}

/* ---------- session detail ---------- */

static const char *const kTabs[] = {"概览", "活动", "改动"};

static int detail_pages(const ct_session_t *s) {
    int pages = 1;
    if (s_tab == 1) {
        pages = (s->log_count + ACTIVITY_ROWS - 1) / ACTIVITY_ROWS;
    } else if (s_tab == 2) {
        pages = s->hunk_count;
    }
    return pages > 0 ? pages : 1;
}

static void on_tab(lv_event_t *e) {
    s_tab = (int)(intptr_t)lv_event_get_user_data(e);
    s_page = 0;
    show_detail();
}

static void on_show_activity(lv_event_t *e) {
    (void)e;
    s_tab = 1;
    s_page = 0;
    show_detail();
}

static void on_detail_prev(lv_event_t *e) {
    (void)e;
    if (s_page > 0) {
        s_page--;
        show_detail();
    }
}

static void on_detail_next(lv_event_t *e) {
    (void)e;
    const ct_session_t *s = current();
    if (s != NULL && s_page + 1 < detail_pages(s)) {
        s_page++;
        show_detail();
    }
}

static void on_go_session(lv_event_t *e) {
    (void)e;
    const ct_session_t *s = current();
    if (s != NULL) {
        open_session(s);
    }
}

static void on_entry(lv_event_t *e) {
    const ct_session_t *s = current();
    const int index = (int)(intptr_t)lv_event_get_user_data(e);
    if (s == NULL || index < 0 || index >= s->log_count) {
        return;
    }
    const ct_log_t *a = &s->log[index];
    s_entry.at = a->at;
    snprintf(s_entry.verb, sizeof(s_entry.verb), "%s", a->verb);
    snprintf(s_entry.target, sizeof(s_entry.target), "%s", a->target);
    s_entry.from_page = s_page;
    show_entry();
}

/* A log row. index >= 0 makes it tappable, opening that entry. */
static void activity_row(lv_obj_t *parent, const ct_log_t *a, int height, int index) {
    const bool tappable = index >= 0;
    lv_obj_t *row = ct_row(parent, height, tappable ? CT_PAD : 0, 8);
    char buf[32];
    ct_fmt_clock(buf, sizeof(buf), a->at);
    lv_obj_t *time = ct_label(row, M18, buf);
    lv_obj_set_width(time, 56);
    lv_obj_t *verb = ct_label(row, MB20, a->verb);
    lv_obj_set_width(verb, 62);
    ct_label_fill(row, M20, a->target);
    if (a->has_stat) {
        ct_fmt_stat(buf, sizeof(buf), a->add, a->del);
    } else {
        snprintf(buf, sizeof(buf), "%s", a->res != NULL ? a->res : "");
    }
    if (a->bad) {
        ct_chip(row, buf, true, false);
    } else if (buf[0] != '\0') {
        ct_label(row, MB20, buf);
    }
    if (tappable) {
        ct_border(row, 1, LV_BORDER_SIDE_BOTTOM);
        ct_label(row, MB24, "›");
        ct_tappable(row, on_entry, (void *)(intptr_t)index);
    }
}

/* Verb, target and line counts of what the session is on. */
static void doing_row(lv_obj_t *parent, const char *verb, const char *target, bool has_stat, int add, int del) {
    lv_obj_t *row = ct_row(parent, 40, 0, 8);
    ct_verb(row, verb);
    ct_label_fill(row, MB20, target);
    if (has_stat) {
        char stat[32];
        ct_fmt_stat(stat, sizeof(stat), add, del);
        ct_label(row, MB20, stat);
    }
    ct_label(row, MB24, "›");
    ct_tappable(row, on_show_activity, NULL);
}

static void detail_overview(lv_obj_t *screen, const ct_session_t *s) {
    char buf[128], right[48], host[CT_HOST_MAX + 24];
    host_prefix(s, host, sizeof(host));
    if (s->branch != NULL) {
        snprintf(buf, sizeof(buf), "%s%s · %s", host, s->model, s->branch);
    } else {
        snprintf(buf, sizeof(buf), "%s%s", host, s->model);
    }
    fmt_meta_right(right, sizeof(right), s);
    ct_meta(screen, buf, right);

    lv_obj_t *content = ct_content(screen, CT_PAD);
    lv_obj_set_style_pad_row(content, 6, 0);
    lv_obj_set_style_pad_top(content, 10, 0);

    if (s->state == CT_STATE_ERROR && s->err != NULL) {
        ct_section(content, "出错了");
        short_paragraph(content, B20, s->err, 2);
    }

    if (wants_approval(s)) {
        ct_section(content, "等你批准");
        doing_row(content, s->ask.verb, s->ask.target, s->ask.has_stat, s->ask.add, s->ask.del);
    } else if (wants_answer(s)) {
        ct_section(content, "等你回答");
        short_paragraph(content, B20, s->ask.text, 2);
    } else if (s->now.verb != NULL) {
        ct_section(content, s->state == CT_STATE_RUNNING ? "正在做" : "最后在做");
        doing_row(content, s->now.verb, s->now.target, s->now.has_stat, s->now.add, s->now.del);
    }

    if (s->say != NULL) {
        ct_section(content, "它说");
        short_paragraph(content, F20, s->say, 3);
    }

    ct_section(content, "做了这些");
    lv_obj_t *sum = ct_row(content, 26, 0, 8);
    fmt_summary(buf, sizeof(buf), s);
    ct_label_fill(sum, M20, buf);
    ct_fmt_stat(buf, sizeof(buf), s->n.add, s->n.del);
    if (buf[0] != '\0') {
        ct_label(sum, MB20, buf);
    }

    if (s->todo_count > 0) {
        snprintf(buf, sizeof(buf), "任务 %d/%d", s->todo_done, s->todo_count);
        ct_section(content, buf);
        lv_obj_t *todos = ct_col(content, 0, 1);
        for (int i = 0; i < s->todo_count && i < 6; i++) {
            const bool doing = i == s->todo_done && s->state != CT_STATE_DONE;
            const char *mark = i < s->todo_done ? "[x]" : (doing ? "[>]" : "[ ]");
            snprintf(buf, sizeof(buf), "%s %s", mark, s->todos[i]);
            lv_obj_t *item = ct_label(todos, doing ? MB20 : M20, buf);
            lv_label_set_long_mode(item, LV_LABEL_LONG_MODE_DOTS);
            lv_obj_set_width(item, LV_PCT(100));
        }
    }

    if (s->log_count > 0) {
        ct_section(content, "刚才");
        lv_obj_t *recent = ct_col(content, 0, 2);
        const int shown = s->todo_count > 4 ? 2 : 3;
        for (int i = 0; i < shown && i < s->log_count; i++) {
            activity_row(recent, &s->log[i], 28, -1);
        }
    }
}

static void detail_activity(lv_obj_t *screen, const ct_session_t *s) {
    lv_obj_t *content = ct_content(screen, 0);
    if (s->log_count == 0) {
        empty_state(content, "还没有活动", "它开始干活后，每一步都会列在这里。");
        return;
    }
    const int first = s_page * ACTIVITY_ROWS;
    for (int i = first; i < s->log_count && i < first + ACTIVITY_ROWS; i++) {
        activity_row(content, &s->log[i], 48, i);
    }
}

/* Index of the first hunk in a file, or -1. Hunks name files by path, the log by basename. */
static int first_hunk_of(const ct_session_t *s, const char *path) {
    for (int i = 0; i < s->hunk_count; i++) {
        if (strcmp(s->hunks[i].file, path) == 0 || strcmp(ct_basename(s->hunks[i].file), path) == 0) {
            return i;
        }
    }
    return -1;
}

/* Tapping a file in the changes tab shows its first hunk. */
static void on_file(lv_event_t *e) {
    const ct_session_t *s = current();
    const int index = (int)(intptr_t)lv_event_get_user_data(e);
    if (s == NULL || index < 0 || index >= s->file_count) {
        return;
    }
    const int hunk = first_hunk_of(s, s->files[index].path);
    if (hunk >= 0 && hunk != s_page) {
        s_page = hunk;
        show_detail();
    }
}

static void detail_changes(lv_obj_t *screen, const ct_session_t *s) {
    lv_obj_t *content = ct_content(screen, 0);
    if (s->file_count == 0 && s->hunk_count == 0) {
        empty_state(content, "还没有改动", "改了文件以后，这里会列出每个文件和改动的片段。");
        return;
    }
    const ct_hunk_t *h = s->hunk_count > 0 ? &s->hunks[s_page < s->hunk_count ? s_page : 0] : NULL;
    char buf[96];
    const int rows = s->file_count < FILE_ROWS ? s->file_count : FILE_ROWS;
    for (int i = 0; i < rows; i++) {
        const ct_file_t *f = &s->files[i];
        lv_obj_t *row = ct_row(content, 48, CT_PAD, 8);
        ct_border(row, i == rows - 1 ? 3 : 1, LV_BORDER_SIDE_BOTTOM);
        if (h != NULL && strcmp(h->file, f->path) == 0) {
            ct_invert(row);
        }
        const char status[2] = {f->st, '\0'};
        ct_label(row, MB20, status);
        ct_label_fill(row, M20, f->path);
        ct_fmt_stat(buf, sizeof(buf), f->add, f->del);
        ct_label(row, MB20, buf);
        ct_tappable(row, on_file, (void *)(intptr_t)i);
    }
    if (s->file_count > rows) {
        lv_obj_t *more = ct_row(content, 32, CT_PAD, 8);
        ct_border(more, 3, LV_BORDER_SIDE_BOTTOM);
        snprintf(buf, sizeof(buf), "还有 %d 个文件", s->file_count - rows);
        ct_label(more, F18, buf);
    }
    if (h == NULL) {
        return;
    }
    lv_obj_t *hunk = ct_col(content, CT_PAD, 6);
    lv_obj_set_style_pad_top(hunk, 10, 0);
    lv_obj_t *title = ct_row(hunk, 24, 0, 8);
    if (h->line > 0) {
        snprintf(buf, sizeof(buf), "%s · 第 %d 行", ct_basename(h->file), h->line);
    } else {
        snprintf(buf, sizeof(buf), "%s", ct_basename(h->file));
    }
    ct_label_fill(title, B20, buf);
    char stat[32];
    ct_fmt_stat(stat, sizeof(stat), h->add, h->del);
    snprintf(buf, sizeof(buf), "这一处 %s", stat);
    ct_label(title, M18, buf);
    lv_obj_t *box = ct_diff_box(hunk);
    for (int i = 0; i < h->line_count; i++) {
        ct_diff_add(box, h->lines[i][0], h->lines[i][0] != '\0' ? h->lines[i] + 1 : "");
    }
}

static void show_detail(void) {
    const ct_session_t *s = current();
    if (s == NULL) {
        session_gone();
        return;
    }
    lv_obj_t *screen = ct_screen_new();
    header(screen, s, on_back_list);
    ct_tabs(screen, kTabs, 3, s_tab, on_tab);
    if (s_page >= detail_pages(s)) {
        s_page = detail_pages(s) - 1;
    }

    char buf[32];
    if (s_tab == 0) {
        detail_overview(screen, s);
    } else if (s_tab == 1) {
        detail_activity(screen, s);
    } else {
        detail_changes(screen, s);
    }
    if (s_tab == 2) {
        snprintf(buf, sizeof(buf), "%d/%d 处", s->hunk_count > 0 ? s_page + 1 : 0, s->hunk_count);
    } else {
        snprintf(buf, sizeof(buf), "%d/%d", s_page + 1, detail_pages(s));
    }

    lv_obj_t *bar = ct_bottom_bar(screen, 76);
    ct_pager(bar, buf, on_detail_prev, on_detail_next);
    ct_spacer(bar);
    if (wants_approval(s)) {
        ct_button(bar, "去批准", B20, 112, 56, true, on_go_session, NULL);
    } else if (wants_answer(s)) {
        ct_button(bar, "去回答", B20, 112, 56, true, on_go_session, NULL);
    } else if (s->state == CT_STATE_DONE) {
        ct_button(bar, "看汇报", B20, 112, 56, true, on_go_session, NULL);
    } else if (s->reply) {
        ct_button(bar, "发指令", B20, 112, 56, true, on_open_reply, NULL);
    } else {
        ct_label(bar, F18, "只能查看");
    }
    present(screen, SCR_DETAIL);
}

/* ---------- one activity entry ---------- */

static const ct_log_t *find_entry(const ct_session_t *s) {
    for (int i = 0; i < s->log_count; i++) {
        const ct_log_t *a = &s->log[i];
        if (a->at == s_entry.at && strcmp(a->verb, s_entry.verb) == 0 &&
            strncmp(a->target, s_entry.target, sizeof(s_entry.target) - 1) == 0) {
            return a;
        }
    }
    return NULL;
}

/* The log keeps only a file's name; the file list has its path. */
static const char *full_path(const ct_session_t *s, const char *name) {
    for (int i = 0; i < s->file_count; i++) {
        if (strcmp(ct_basename(s->files[i].path), name) == 0) {
            return s->files[i].path;
        }
    }
    return name;
}

static void on_back_entry(lv_event_t *e) {
    (void)e;
    s_tab = 1;
    s_page = s_entry.from_page;
    show_detail();
}

static void on_entry_changes(lv_event_t *e) {
    (void)e;
    const ct_session_t *s = current();
    if (s == NULL) {
        return;
    }
    const int hunk = first_hunk_of(s, s_entry.target);
    s_tab = 2;
    s_page = hunk > 0 ? hunk : 0;
    show_detail();
}

static void show_entry(void) {
    const ct_session_t *s = current();
    if (s == NULL) {
        session_gone();
        return;
    }
    const ct_log_t *a = find_entry(s);
    if (a == NULL) {
        /* It scrolled out of the log the bridge keeps. */
        on_back_entry(NULL);
        return;
    }
    lv_obj_t *screen = ct_screen_new();
    header(screen, s, on_back_entry);
    char clock[8], buf[96], result[48];
    ct_fmt_clock(clock, sizeof(clock), a->at);
    snprintf(buf, sizeof(buf), "%s · %s", clock, a->verb);
    if (a->has_stat) {
        ct_fmt_stat(result, sizeof(result), a->add, a->del);
    } else {
        snprintf(result, sizeof(result), "%s", a->res != NULL ? a->res : "");
    }
    ct_meta(screen, buf, result[0] != '\0' ? result : NULL);

    lv_obj_t *content = ct_content(screen, CT_PAD);
    lv_obj_set_style_pad_row(content, 8, 0);
    lv_obj_set_style_pad_top(content, 10, 0);

    const bool said = strcmp(a->verb, "说") == 0;
    const bool you = strcmp(a->verb, "你") == 0 || strcmp(a->verb, "答") == 0;
    const int hunk = first_hunk_of(s, a->target);
    if (said || you) {
        ct_section(content, said ? "它说" : (strcmp(a->verb, "答") == 0 ? "你选了" : "你说"));
        ct_paragraph(content, F20, a->target);
    } else {
        const bool file = strcmp(a->verb, "Read") == 0 || strcmp(a->verb, "Edit") == 0 || strcmp(a->verb, "Write") == 0;
        ct_section(content, file ? "文件" : "内容");
        ct_paragraph(content, M20, file ? full_path(s, a->target) : a->target);
    }
    if (result[0] != '\0') {
        ct_section(content, "结果");
        lv_obj_t *row = ct_row(content, 32, 0, 8);
        if (a->bad) {
            ct_chip(row, result, true, false);
            ct_label(row, F20, "没成功");
        } else {
            ct_label(row, MB20, result);
        }
    }
    if (hunk >= 0) {
        const ct_hunk_t *h = &s->hunks[hunk];
        snprintf(buf, sizeof(buf), h->line > 0 ? "改动 · 第 %d 行" : "改动", h->line);
        ct_section(content, buf);
        lv_obj_t *box = ct_diff_box(content);
        for (int i = 0; i < h->line_count; i++) {
            ct_diff_add(box, h->lines[i][0], h->lines[i][0] != '\0' ? h->lines[i] + 1 : "");
        }
    }

    lv_obj_t *bar = ct_bottom_bar(screen, 76);
    ct_spacer(bar);
    if (hunk >= 0) {
        ct_button(bar, "看这个文件的改动", B20, 200, 56, false, on_entry_changes, NULL);
    }
    present(screen, SCR_ENTRY);
}

/* ---------- approve ---------- */

static void decide(bool allow) {
    await_ack(ct_proto_approve(s_sel.link, s_sel.id, s_req, allow));
}

static void on_approve(lv_event_t *e) {
    (void)e;
    decide(true);
}

static void on_approve_long(lv_event_t *e) {
    (void)e;
    ct_hal_vibrate(80);
    decide(true);
}

static void on_approve_short(lv_event_t *e) {
    (void)e;
    ct_hal_vibrate(15); /* a tap is not enough here; the hint says to hold */
}

static void on_deny(lv_event_t *e) {
    (void)e;
    decide(false);
}

static void on_full_diff(lv_event_t *e) {
    (void)e;
    show_diff();
}

/* The deadline or risk hint, then 拒绝 and 批准 (a long press for risky requests). */
static void approve_bar(lv_obj_t *screen, const ct_ask_t *ask) {
    lv_obj_t *hint = ct_row(screen, 32, CT_PAD, 0);
    if (ask->risky) {
        ct_label(hint, F18, "有风险的操作，要长按“批准”才生效");
    } else if (ask->until > 0) {
        char clock[8], buf[64];
        ct_fmt_clock(clock, sizeof(clock), ask->until);
        snprintf(buf, sizeof(buf), "%s 前没批准，就要回电脑确认", clock);
        ct_label(hint, F18, buf);
    }
    lv_obj_t *bar = ct_bottom_bar(screen, 88);
    lv_obj_set_style_pad_column(bar, 12, 0);
    lv_obj_t *deny = ct_button(bar, "拒绝", B24, 100, 64, false, on_deny, NULL);
    lv_obj_set_flex_grow(deny, 1);
    if (ask->risky) {
        lv_obj_t *ok = ct_button(bar, "长按批准", B24, 100, 64, true, NULL, NULL);
        lv_obj_add_event_cb(ok, on_approve_long, LV_EVENT_LONG_PRESSED, NULL);
        lv_obj_add_event_cb(ok, on_approve_short, LV_EVENT_SHORT_CLICKED, NULL);
        lv_obj_set_flex_grow(ok, 1);
    } else {
        lv_obj_t *ok = ct_button(bar, "批准", B24, 100, 64, true, on_approve, NULL);
        lv_obj_set_flex_grow(ok, 1);
    }
}

static const char *approve_title(const char *verb) {
    if (strcmp(verb, "Edit") == 0) return "想改这个文件";
    if (strcmp(verb, "Write") == 0) return "想新建这个文件";
    if (strcmp(verb, "Bash") == 0) return "想运行这条命令";
    return "想做这一步";
}

static void show_approve(void) {
    const ct_session_t *s = current();
    if (s == NULL) {
        session_gone();
        return;
    }
    if (!wants_approval(s)) {
        show_detail();
        return;
    }
    const ct_ask_t *ask = &s->ask;
    snprintf(s_req, sizeof(s_req), "%s", req_of(s));

    lv_obj_t *screen = ct_screen_new();
    header(screen, s, on_back_list);
    char buf[96];
    fmt_ago(buf, sizeof(buf), "等了 ", s->since);
    agent_meta(screen, s, buf);

    lv_obj_t *content = ct_content(screen, CT_PAD);
    lv_obj_set_style_pad_row(content, 6, 0);
    lv_obj_set_style_pad_top(content, 10, 0);

    ct_section(content, approve_title(ask->verb));
    if (ask->line_count == 0) {
        /* A command, or a tool call with nothing to diff: show it whole. */
        lv_obj_t *cmd = ct_col(content, 12, 0);
        lv_obj_set_style_pad_ver(cmd, 10, 0);
        ct_border(cmd, 2, LV_BORDER_SIDE_FULL);
        if (strcmp(ask->verb, "Bash") != 0) {
            ct_label(cmd, MB20, ask->verb);
        }
        short_paragraph(cmd, MB20, ask->target, 5);
    } else {
        lv_obj_t *file = ct_row(content, 28, 0, 8);
        ct_verb(file, ask->verb);
        ct_label_fill(file, MB20, ask->target);
        if (ask->has_stat) {
            ct_fmt_stat(buf, sizeof(buf), ask->add, ask->del);
            ct_label(file, MB20, buf);
        }
        lv_obj_t *box = ct_diff_box(content);
        for (int i = 0; i < ask->line_count && i < APPROVE_LINES; i++) {
            const char *line = ask->lines[i];
            ct_diff_add(box, line[0], line[0] != '\0' ? line + 1 : "");
        }
        lv_obj_t *more = ct_row(content, 48, 12, 8);
        ct_border(more, 2, LV_BORDER_SIDE_FULL);
        snprintf(buf, sizeof(buf), ask->line > 0 ? "看完整改动 · 第 %d 行" : "看完整改动", ask->line);
        ct_label_fill(more, B20, buf);
        ct_label(more, MB24, "›");
        ct_tappable(more, on_full_diff, NULL);
    }

    if (ask->why != NULL) {
        ct_section(content, "它的理由");
        short_paragraph(content, F20, ask->why, 3);
    }

    ct_section(content, "这一轮");
    lv_obj_t *sum = ct_row(content, 26, 0, 8);
    fmt_counts(buf, sizeof(buf), s);
    ct_label_fill(sum, M20, buf);
    ct_fmt_stat(buf, sizeof(buf), s->n.add, s->n.del);
    ct_label(sum, MB20, buf);

    approve_bar(screen, ask);
    present(screen, SCR_APPROVE);
}

/* ---------- the whole change of a permission request ---------- */

/* One diff line that wraps instead of being cut off at the screen edge. */
static void diff_line_wrapped(lv_obj_t *box, const char *line) {
    const char kind = line[0];
    lv_obj_t *row = ct_box(box);
    lv_obj_set_size(row, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_set_style_pad_hor(row, 8, 0);
    lv_obj_set_style_pad_ver(row, 2, 0);
    lv_obj_set_style_pad_column(row, 8, 0);
    if (kind == '+') {
        ct_invert(row);
    }
    ct_label(row, M18, kind == '+' ? "+" : (kind == '-' ? "−" : " "));
    lv_obj_t *code = ct_label(row, M18, kind != '\0' ? line + 1 : "");
    lv_label_set_long_mode(code, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_width(code, 1);
    lv_obj_set_flex_grow(code, 1);
    ct_label_wrap(code);
}

static void on_back_approve(lv_event_t *e) {
    (void)e;
    show_approve();
}

static void show_diff(void) {
    const ct_session_t *s = current();
    if (s == NULL) {
        session_gone();
        return;
    }
    if (!wants_approval(s)) {
        show_detail();
        return;
    }
    const ct_ask_t *ask = &s->ask;
    lv_obj_t *screen = ct_screen_new();
    header(screen, s, on_back_approve);
    char buf[96], stat[32];
    ct_fmt_stat(stat, sizeof(stat), ask->add, ask->del);
    if (ask->line > 0) {
        snprintf(buf, sizeof(buf), "%s · 从第 %d 行起", ct_basename(ask->target), ask->line);
    } else {
        snprintf(buf, sizeof(buf), "%s", ct_basename(ask->target));
    }
    ct_meta(screen, buf, stat[0] != '\0' ? stat : NULL);

    lv_obj_t *content = ct_content(screen, CT_PAD);
    lv_obj_set_style_pad_top(content, 10, 0);
    lv_obj_set_style_pad_row(content, 8, 0);
    lv_obj_t *box = ct_diff_box(content);
    for (int i = 0; i < ask->line_count; i++) {
        diff_line_wrapped(box, ask->lines[i]);
    }
    if (ask->has_stat && ask->add + ask->del > ask->line_count) {
        ct_paragraph(content, F18, "改动太长，这里只显示开头一段，完整内容要回电脑看。");
    }
    approve_bar(screen, ask);
    present(screen, SCR_DIFF);
}

/* ---------- question ---------- */

static void on_option(lv_event_t *e) {
    const int option = (int)(intptr_t)lv_event_get_user_data(e);
    await_ack(ct_proto_answer(s_sel.link, s_sel.id, s_req, option));
}

static void show_question(void) {
    const ct_session_t *s = current();
    if (s == NULL) {
        session_gone();
        return;
    }
    if (!wants_answer(s)) {
        show_detail();
        return;
    }
    const ct_ask_t *ask = &s->ask;
    snprintf(s_req, sizeof(s_req), "%s", req_of(s));

    lv_obj_t *screen = ct_screen_new();
    header(screen, s, on_back_list);
    char buf[96];
    fmt_meta_right(buf, sizeof(buf), s);
    agent_meta(screen, s, buf);

    lv_obj_t *content = ct_content(screen, CT_PAD);
    lv_obj_set_style_pad_row(content, 8, 0);
    lv_obj_set_style_pad_top(content, 10, 0);

    ct_section(content, "它问你");
    short_paragraph(content, B24, ask->text, 3);
    if (ask->note != NULL) {
        short_paragraph(content, F20, ask->note, 3);
    }

    for (int i = 0; i < ask->option_count; i++) {
        lv_obj_t *opt = ct_row(content, 88, 14, 14);
        ct_border(opt, 3, LV_BORDER_SIDE_FULL);
        lv_obj_t *num = ct_box(opt);
        lv_obj_set_size(num, 48, 48);
        ct_invert(num);
        snprintf(buf, sizeof(buf), "%d", i + 1);
        lv_obj_center(ct_label(num, MB24, buf));
        lv_obj_t *text = ct_col(opt, 0, 2);
        lv_obj_set_flex_grow(text, 1);
        lv_obj_t *label = ct_label(text, B20, ask->options[i].label);
        lv_label_set_long_mode(label, LV_LABEL_LONG_MODE_DOTS);
        lv_obj_set_width(label, LV_PCT(100));
        if (ask->options[i].desc != NULL) {
            lv_obj_t *desc = ct_label(text, F18, ask->options[i].desc);
            lv_label_set_long_mode(desc, LV_LABEL_LONG_MODE_DOTS);
            lv_obj_set_width(desc, LV_PCT(100));
        }
        ct_tappable(opt, on_option, (void *)(intptr_t)i);
    }
    if (s->reply) {
        ct_button(content, "都不是，按住这里说", B20, LV_PCT(100), 64, false, on_open_reply, NULL);
    }

    lv_obj_t *hint = ct_row(screen, 44, CT_PAD, 0);
    lv_obj_set_flex_align(hint, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    ct_label(hint, F18, "点一个选项，就直接发给它");
    present(screen, SCR_QUESTION);
}

/* ---------- completion report ---------- */

static void on_dismiss(lv_event_t *e) {
    (void)e;
    await_ack(ct_proto_seen(s_sel.link, s_sel.id));
}

static void report_para(lv_obj_t *parent, const ct_para_t *p) {
    lv_obj_t *row = ct_box(parent);
    lv_obj_set_size(row, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_set_style_pad_column(row, 8, 0);
    if (p->bullet) {
        lv_obj_t *dot = ct_box(row);
        lv_obj_set_size(dot, 5, 5);
        lv_obj_set_style_bg_color(dot, lv_color_black(), 0);
        lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
        lv_obj_set_style_margin_top(dot, 10, 0);
        lv_obj_set_style_margin_left(dot, 6, 0);
    }
    lv_obj_t *spans = lv_spangroup_create(row);
    lv_obj_remove_style_all(spans);
    lv_obj_set_width(spans, 1); /* a fixed width makes it wrap; flex grow then sets the real one */
    lv_obj_set_flex_grow(spans, 1);
    lv_obj_set_height(spans, LV_SIZE_CONTENT);
    lv_obj_set_style_text_font(spans, F20, 0);
    lv_obj_set_style_text_line_space(spans, 3, 0);
    /* Break the lines ourselves (Chinese rules), across the bold lead and the body. */
    lv_obj_update_layout(spans);
    const int32_t width = lv_obj_get_content_width(spans) - 1;
    const char *lead_text = p->lead != NULL ? p->lead : "";
    const size_t lead_size = strlen(lead_text) * 2 + 1;
    const size_t body_size = strlen(p->text) * 2 + 1;
    char *lead_out = lv_malloc(lead_size);
    char *body_out = lv_malloc(body_size);
    if (lead_out != NULL && body_out != NULL && width > 0) {
        ct_run_t runs[2] = {{lead_text, B20, lead_out, lead_size}, {p->text, F20, body_out, body_size}};
        ct_wrap(runs, 2, width);
    } else if (lead_out != NULL && body_out != NULL) {
        snprintf(lead_out, lead_size, "%s", lead_text);
        snprintf(body_out, body_size, "%s", p->text);
    }
    if (p->lead != NULL) {
        lv_span_t *lead = lv_spangroup_add_span(spans);
        lv_span_set_text(lead, lead_out != NULL ? lead_out : p->lead);
        lv_style_set_text_font(lv_span_get_style(lead), B20);
    }
    lv_span_t *body = lv_spangroup_add_span(spans);
    lv_span_set_text(body, body_out != NULL ? body_out : p->text);
    lv_spangroup_refresh(spans);
    lv_free(lead_out);
    lv_free(body_out);
}

static void on_done_prev(lv_event_t *e) {
    (void)e;
    if (s_page > 0) {
        s_page--;
        show_done();
    }
}

static void on_done_next(lv_event_t *e) {
    (void)e;
    if (s_page + 1 < s_done_pages) {
        s_page++;
        show_done();
    }
}

static void show_done(void) {
    const ct_session_t *s = current();
    if (s == NULL) {
        session_gone();
        return;
    }
    if (s->state != CT_STATE_DONE) {
        show_detail();
        return;
    }
    if (s_screen != SCR_DONE) {
        s_page = 0;
    }
    lv_obj_t *screen = ct_screen_new();
    header(screen, s, on_back_list);
    char took[32], counts[48], buf[128], stat[32];
    fmt_took(took, sizeof(took), s);
    fmt_counts(counts, sizeof(counts), s);
    snprintf(buf, sizeof(buf), "%s · %s · %s", s->model, took, counts);
    ct_fmt_stat(stat, sizeof(stat), s->n.add, s->n.del);
    ct_meta(screen, buf, stat[0] != '\0' ? stat : NULL);

    lv_obj_t *content = ct_content(screen, CT_PAD);
    lv_obj_set_style_pad_row(content, 7, 0);
    lv_obj_set_style_pad_top(content, 10, 0);
    if (s->report_count == 0) {
        ct_paragraph(content, F20, "做完了，没有留下说明。");
    }
    for (int i = 0; i < s->report_count; i++) {
        report_para(content, &s->report[i]);
    }

    lv_obj_t *bar = ct_bottom_bar(screen, 76);
    ct_button(bar, "‹", MB24, 60, 56, false, on_done_prev, NULL);
    lv_obj_t *pager = ct_label(bar, MB20, "1/1");
    ct_button(bar, "›", MB24, 60, 56, false, on_done_next, NULL);
    ct_spacer(bar);
    ct_button(bar, "知道了", B20, 96, 56, !s->reply, on_dismiss, NULL);
    if (s->reply) {
        ct_button(bar, "回复", B20, 80, 56, true, on_open_reply, NULL);
    }

    /* Long reports: split the paragraphs into pages that fit, show one page. */
    lv_obj_update_layout(screen);
    const int32_t room = lv_obj_get_content_height(content);
    const uint32_t count = lv_obj_get_child_count(content);
    int page = 0;
    int32_t used = 0;
    for (uint32_t i = 0; i < count; i++) {
        lv_obj_t *para = lv_obj_get_child(content, (int32_t)i);
        const int32_t h = lv_obj_get_height(para);
        if (used > 0 && used + h > room) {
            page++;
            used = 0;
        }
        used += h + 7;
        lv_obj_set_user_data(para, (void *)(intptr_t)page);
    }
    s_done_pages = page + 1;
    if (s_page >= s_done_pages) {
        s_page = s_done_pages - 1;
    }
    for (uint32_t i = 0; i < count; i++) {
        lv_obj_t *para = lv_obj_get_child(content, (int32_t)i);
        if ((int)(intptr_t)lv_obj_get_user_data(para) != s_page) {
            lv_obj_add_flag(para, LV_OBJ_FLAG_HIDDEN);
        }
    }
    snprintf(buf, sizeof(buf), "%d/%d", s_page + 1, s_done_pages);
    lv_label_set_text(pager, buf);
    present(screen, SCR_DONE);
}

/* ---------- reply ---------- */

static void on_quick(lv_event_t *e) {
    const char *text = ct_model_quick(s_sel.link, (int)(intptr_t)lv_event_get_user_data(e));
    if (text != NULL) {
        await_ack(ct_proto_reply(s_sel.link, s_sel.id, text));
    }
}

static void on_hold_to_talk(lv_event_t *e) {
    (void)e;
    show_voice();
}

static void show_reply(void) {
    const ct_session_t *s = current();
    if (s == NULL) {
        session_gone();
        return;
    }
    lv_obj_t *screen = ct_screen_new();
    status_bar(screen);
    lv_obj_t *nav = ct_nav(screen, s->name, on_back_from_reply);
    ct_chip(nav, "回复", false, true);
    agent_meta(screen, s, state_text(s->state));

    lv_obj_t *content = ct_content(screen, CT_PAD);
    lv_obj_set_style_pad_row(content, 8, 0);
    lv_obj_set_style_pad_top(content, 12, 0);

    if (ct_model_quick_count(s->link) > 0) {
        ct_section(content, "点一句直接发");
    }
    for (int i = 0; i < ct_model_quick_count(s->link); i++) {
        lv_obj_t *q = ct_row(content, 60, 14, 8);
        ct_border(q, 3, LV_BORDER_SIDE_FULL);
        ct_label_fill(q, B20, ct_model_quick(s->link, i));
        ct_label(q, MB24, "›");
        ct_tappable(q, on_quick, (void *)(intptr_t)i);
    }

    ct_section(content, "或者自己说");
    lv_obj_t *talk = ct_col(content, 0, 6);
    lv_obj_set_height(talk, 112);
    lv_obj_set_flex_align(talk, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    ct_invert(talk);
    ct_label(talk, B24, "按住这里说话");
    ct_label(talk, F18, "松开后先显示识别出的文字，确认了再发");
    ct_tappable(talk, on_hold_to_talk, NULL);

    lv_obj_t *hint = ct_row(screen, 44, CT_PAD, 0);
    lv_obj_set_flex_align(hint, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    ct_label(hint, F18, s->state == CT_STATE_RUNNING ? "它正在干活，这句话会排在当前这一步之后"
                                                     : "按住机身上的 BOOT 键也一样");
    present(screen, SCR_REPLY);
}

/* ---------- voice confirmation ---------- */

static void on_send(lv_event_t *e) {
    (void)e;
    await_ack(ct_proto_reply(s_sel.link, s_sel.id, s_heard));
}

static void show_voice(void) {
    const ct_session_t *s = current();
    if (s == NULL) {
        session_gone();
        return;
    }
    lv_obj_t *screen = ct_screen_new();
    status_bar(screen);
    lv_obj_t *nav = ct_nav(screen, s->name, on_back_reply);
    ct_chip(nav, "语音", false, true);
    agent_meta(screen, s, "豆包识别");

    lv_obj_t *content = ct_content(screen, CT_PAD);
    lv_obj_set_style_pad_row(content, 8, 0);
    lv_obj_set_style_pad_top(content, 12, 0);

    ct_section(content, "你说的");
    lv_obj_t *heard = ct_col(content, 12, 0);
    lv_obj_set_style_pad_ver(heard, 12, 0);
    ct_border(heard, 2, LV_BORDER_SIDE_FULL);
    ct_paragraph(heard, B24, s_heard);

    if (s->now.verb != NULL) {
        ct_section(content, "它现在");
        lv_obj_t *now = ct_row(content, 28, 0, 8);
        ct_verb(now, s->now.verb);
        ct_label_fill(now, M20, s->now.target);
    }

    if (s->say != NULL) {
        ct_section(content, "它刚说");
        short_paragraph(content, F20, s->say, 3);
    }

    ct_section(content, "发出去之后");
    ct_paragraph(content, F20,
                 s->state == CT_STATE_RUNNING ? "这句话排在它当前这一步后面，不会打断正在进行的修改。"
                                              : "它会马上开始按这句话去做。");

    lv_obj_t *bar = ct_bottom_bar(screen, 88);
    lv_obj_set_style_pad_column(bar, 12, 0);
    lv_obj_t *redo = ct_button(bar, "重说", B24, 100, 64, false, on_back_reply, NULL);
    lv_obj_set_flex_grow(redo, 1);
    lv_obj_t *send = ct_button(bar, "发送", B24, 100, 64, true, on_send, NULL);
    lv_obj_set_flex_grow(send, 1);
    present(screen, SCR_VOICE);
}

/* ---------- pairing ---------- */

static void on_pair_later(lv_event_t *e) {
    (void)e;
    if (s_pair_link >= 0) {
        s_pair_later[s_pair_link] = true;
    }
    s_pair_link = -1;
    show_list();
}

static void show_pair(void) {
    const int link = s_pair_link;
    if (link < 0 || !ct_proto_pairing(link)) {
        s_pair_link = -1;
        show_list();
        return;
    }
    const char *code = ct_proto_pair_code(link);
    lv_obj_t *screen = ct_screen_new();
    status_bar(screen);
    ct_nav(screen, "配对", NULL);

    lv_obj_t *content = ct_content(screen, CT_PAD);
    lv_obj_set_style_pad_row(content, 12, 0);
    lv_obj_set_style_pad_top(content, 20, 0);
    char buf[160];
    snprintf(buf, sizeof(buf), "这台设备还没和“%s”配对过。配好以后才能看那台电脑上的 agent。", ct_proto_pair_host(link));
    ct_paragraph(content, F20, buf);

    ct_section(content, "配对码");
    lv_obj_t *digits = ct_row(content, 80, 0, 8);
    lv_obj_set_flex_align(digits, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    for (int i = 0; code[i] != '\0' && i < 6; i++) {
        lv_obj_t *box = ct_box(digits);
        lv_obj_set_size(box, 58, 76);
        ct_border(box, 3, LV_BORDER_SIDE_FULL);
        if (i == 3) {
            lv_obj_set_style_margin_left(box, 12, 0);
        }
        const char digit[2] = {code[i], '\0'};
        lv_obj_center(ct_label(box, MB24, digit));
    }

    snprintf(buf, sizeof(buf), "在“%s”上运行", ct_proto_pair_host(link));
    ct_section(content, buf);
    lv_obj_t *cmd = ct_col(content, 12, 0);
    lv_obj_set_style_pad_ver(cmd, 12, 0);
    ct_border(cmd, 2, LV_BORDER_SIDE_FULL);
    snprintf(buf, sizeof(buf), "codetalky pair %s", code);
    ct_paragraph(cmd, MB20, buf);
    ct_paragraph(content, F18, "这样只有能操作那台电脑的人才能配对。配对码 5 分钟内有效，过期会自动换一个。");

    lv_obj_t *bar = ct_bottom_bar(screen, 76);
    ct_spacer(bar);
    ct_button(bar, "以后再说", B20, 140, 56, false, on_pair_later, NULL);
    present(screen, SCR_PAIR);
}

/* A computer asked to pair: show its code, unless the user already said later. */
static void start_pairing(int link) {
    if (s_pair_later[link] || s_pending.seq != 0) {
        return;
    }
    if (s_pair_link < 0 || s_pair_link == link) {
        s_pair_link = link;
        s_pair_since = lv_tick_get();
        s_next_refresh = CT_REFRESH_FAST;
        show_pair();
    }
}

/* ---------- following the data ---------- */

static uint32_t hash_pair(const char *a, const char *b) {
    uint32_t h = 2166136261u; /* FNV-1a */
    for (const char *p = a; *p != '\0'; p++) h = (h ^ (uint8_t)*p) * 16777619u;
    h = (h ^ 0xff) * 16777619u;
    for (const char *p = b; *p != '\0'; p++) h = (h ^ (uint8_t)*p) * 16777619u;
    return h;
}

/* Buzz when a session starts waiting for the user. */
static void announce_new_requests(void) {
    if (ct_model_rev() == s_announced_rev) {
        return;
    }
    s_announced_rev = ct_model_rev();
    uint32_t now[CT_MAX_SESSIONS];
    int count = 0;
    bool fresh = false;
    for (int i = 0; i < ct_model_count(); i++) {
        const ct_session_t *s = ct_model_at(i);
        if (!wants_approval(s) && !wants_answer(s)) {
            continue;
        }
        const uint32_t h = hash_pair(s->id, req_of(s)) ^ ((uint32_t)s->link * 0x9E3779B9u);
        bool known = false;
        for (int j = 0; j < s_announced_count; j++) {
            known = known || s_announced[j] == h;
        }
        fresh = fresh || !known;
        now[count++] = h;
    }
    memcpy(s_announced, now, sizeof(now[0]) * (size_t)count);
    s_announced_count = count;
    if (fresh) {
        ct_hal_vibrate(150);
    }
}

/* Redraw the current screen if what it shows has changed. */
static void follow_data(void) {
    if (key_eq(key_now(), s_drawn)) {
        return;
    }
    s_next_refresh = s_partials + 1 >= FAST_EVERY || s_resynced ? CT_REFRESH_FAST : CT_REFRESH_PARTIAL;
    s_resynced = false;
    if (s_screen == SCR_LIST) {
        show_list();
        return;
    }
    const ct_session_t *s = current();
    if (s == NULL) {
        session_gone();
        return;
    }
    switch (s_screen) {
    case SCR_APPROVE:
        /* Answered elsewhere, timed out, or replaced by another request: leave. */
        if (!wants_approval(s) || strcmp(req_of(s), s_req) != 0) {
            s_next_refresh = CT_REFRESH_FAST;
            open_session(s);
        } else {
            show_approve();
        }
        break;
    case SCR_QUESTION:
        if (!wants_answer(s) || strcmp(req_of(s), s_req) != 0) {
            s_next_refresh = CT_REFRESH_FAST;
            open_session(s);
        } else {
            show_question();
        }
        break;
    case SCR_DONE:
        if (s->state != CT_STATE_DONE) {
            s_next_refresh = CT_REFRESH_FAST;
        }
        show_done();
        break;
    case SCR_DIFF:
        if (!wants_approval(s) || strcmp(req_of(s), s_req) != 0) {
            s_next_refresh = CT_REFRESH_FAST;
            open_session(s);
        } else {
            show_diff();
        }
        break;
    case SCR_ENTRY: show_entry(); break;
    case SCR_PAIR: show_pair(); break;
    case SCR_REPLY: show_reply(); break;
    case SCR_VOICE: show_voice(); break;
    default: show_detail(); break;
    }
}

/* Forget computers that have been gone longer than the grace period. */
static void forget_lost_links(void) {
    for (int i = 0; i < CT_MAX_LINKS; i++) {
        if (s_links[i].seen && !s_links[i].up && lv_tick_elaps(s_links[i].down_at) >= LINK_GRACE_MS) {
            s_links[i].seen = false;
            ct_model_drop_link(i);
        }
    }
}

static void on_poll(lv_timer_t *timer) {
    (void)timer;
    forget_lost_links();
    /* The computer forgets a pairing code after five minutes: ask with a new one first. */
    if (s_screen == SCR_PAIR && s_pair_link >= 0 && lv_tick_elaps(s_pair_since) >= PAIR_REFRESH_MS) {
        ct_proto_pair_again(s_pair_link);
        s_pair_since = lv_tick_get();
        s_next_refresh = CT_REFRESH_FAST;
        show_pair();
        return;
    }
    announce_new_requests();
    if (s_pending.seq != 0) {
        if (lv_tick_elaps(s_pending.sent_at) >= ACK_TIMEOUT_MS) {
            finish_action(CT_ACK_TIMEOUT);
        }
        return;
    }
    if (input_pressed() || lv_tick_elaps(s_drawn_at) < MIN_REDRAW_MS) {
        return;
    }
    follow_data();
}

/* ---------- entry points ---------- */

void ct_ui_init(void) {
    ct_widgets_init();
    for (lv_indev_t *i = lv_indev_get_next(NULL); i != NULL; i = lv_indev_get_next(i)) {
        lv_indev_set_long_press_time(i, LONG_PRESS_MS);
    }
    show_list();
    lv_timer_create(on_poll, POLL_MS, NULL);
}

void ct_ui_on_link(int link, bool up) {
    if (link < 0 || link >= CT_MAX_LINKS) {
        return;
    }
    s_links[link].seen = true;
    s_links[link].up = up;
    s_links[link].synced = false;
    if (!up) {
        s_links[link].down_at = lv_tick_get();
    }
    ct_proto_link(link, up);
    if (!up && s_pending.seq != 0 && s_pending.link == link) {
        finish_action(CT_ACK_OFFLINE);
    }
}

void ct_ui_on_message(int link, const char *json, size_t len) {
    if (link < 0 || link >= CT_MAX_LINKS) {
        return;
    }
    const ct_event_t ev = ct_proto_receive(link, json, len);
    switch (ev.type) {
    case CT_EV_HELLO:
        s_links[link].synced = false;
        s_links[link].bad_proto = false;
        break;
    case CT_EV_READY:
        s_links[link].synced = true;
        s_resynced = true;
        break;
    case CT_EV_BAD_PROTO: s_links[link].bad_proto = true; break;
    case CT_EV_PAIRING: start_pairing(link); break;
    case CT_EV_PAIRED:
        s_pair_later[link] = false;
        if (s_screen == SCR_PAIR && s_pair_link == link) {
            s_pair_link = -1;
            s_banner = "配对好了";
            s_next_refresh = CT_REFRESH_FAST;
            show_list();
        }
        break;
    case CT_EV_ACK:
        if (s_pending.seq != 0 && s_pending.link == link && ev.seq == s_pending.seq) {
            finish_action(ev.ack);
        }
        break;
    default: break;
    }
}

void ct_ui_on_key(ct_key_t key, bool down) {
    if (!down || s_pending.seq != 0) {
        return;
    }
    switch (key) {
    case CT_KEY_HOME:
        show_list();
        break;
    case CT_KEY_VOL_UP:
    case CT_KEY_PREV:
        if (s_screen == SCR_LIST) on_list_prev(NULL);
        else if (s_screen == SCR_DETAIL) on_detail_prev(NULL);
        else if (s_screen == SCR_DONE) on_done_prev(NULL);
        break;
    case CT_KEY_VOL_DOWN:
    case CT_KEY_NEXT:
        if (s_screen == SCR_LIST) on_list_next(NULL);
        else if (s_screen == SCR_DETAIL) on_detail_next(NULL);
        else if (s_screen == SCR_DONE) on_done_next(NULL);
        break;
    case CT_KEY_BOOT: {
        const ct_session_t *s = current();
        if (s_screen != SCR_LIST && s != NULL && s->reply) {
            if (s_screen != SCR_REPLY && s_screen != SCR_VOICE) {
                s_reply_from = s_screen;
            }
            show_voice();
        }
        break;
    }
    default:
        break;
    }
}
