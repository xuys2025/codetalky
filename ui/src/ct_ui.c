/*
 * CodeTalky screens and navigation.
 *
 * Every action can be done by touch; the hardware keys are shortcuts:
 * volume up/down and the PREV/NEXT touch keys turn pages, HOME returns to the
 * session list, BOOT is push-to-talk.
 */
#include "ct_ui.h"

#include <stdint.h>
#include <stdio.h>

#include "ct_hal.h"
#include "ct_model.h"
#include "ct_widgets.h"

#define MAX_SESSIONS 16
#define LIST_ROWS 6
#define ACTIVITY_ROWS 12

typedef enum { SCR_LIST, SCR_DETAIL, SCR_APPROVE, SCR_QUESTION, SCR_DONE, SCR_REPLY, SCR_VOICE } screen_id_t;

static screen_id_t s_screen;
static screen_id_t s_reply_from = SCR_LIST;
static int s_sel;       /* selected session */
static int s_tab;       /* detail tab: 0 overview, 1 activity, 2 changes */
static int s_page;      /* page within the current list */
static ct_state_t s_state[MAX_SESSIONS];
static const char *s_note[MAX_SESSIONS]; /* what the user last did to a session */
static const char *s_heard = "把刚才失败的两个测试修好，然后重新跑一遍。";

static void show_list(void);
static void show_detail(void);
static void show_approve(void);
static void show_question(void);
static void show_done(void);
static void show_reply(void);
static void show_voice(void);

/* ---------- helpers ---------- */

static void present(lv_obj_t *screen, screen_id_t id) {
    lv_obj_t *old = lv_screen_active();
    s_screen = id;
    ct_hal_refresh_hint(CT_REFRESH_FAST);
    lv_screen_load(screen);
    if (old != NULL && old != screen) {
        lv_obj_delete_async(old);
    }
}

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

static bool is_waiting(ct_state_t state) {
    return state == CT_STATE_WAIT_APPROVE || state == CT_STATE_WAIT_ANSWER;
}

static void state_chip(lv_obj_t *parent, ct_state_t state) {
    /* Only sessions waiting for the user are shown white-on-black. */
    ct_chip(parent, state_text(state), is_waiting(state), state == CT_STATE_RUNNING);
}

static void open_selected(void) {
    switch (s_state[s_sel]) {
    case CT_STATE_WAIT_APPROVE: show_approve(); break;
    case CT_STATE_WAIT_ANSWER: show_question(); break;
    case CT_STATE_DONE: show_done(); break;
    default: show_detail(); break;
    }
}

static void resolve(const char *note) {
    s_state[s_sel] = CT_STATE_RUNNING;
    s_note[s_sel] = note;
    show_list();
}

static void on_back_list(lv_event_t *e) { (void)e; show_list(); }
static void on_back_reply(lv_event_t *e) { (void)e; show_reply(); }
static void on_back_from_reply(lv_event_t *e) {
    (void)e;
    if (s_reply_from == SCR_DONE) show_done(); else if (s_reply_from == SCR_DETAIL) show_detail(); else show_list();
}
static void on_open_reply(lv_event_t *e) { (void)e; s_reply_from = s_screen; show_reply(); }

static void header(lv_obj_t *screen, const ct_session_t *s, lv_event_cb_t on_back) {
    ct_status_bar(screen);
    lv_obj_t *nav = ct_nav(screen, s->name, on_back);
    state_chip(nav, s_state[s_sel]);
}

/* ---------- session list ---------- */

static void on_row(lv_event_t *e) {
    s_sel = (int)(intptr_t)lv_event_get_user_data(e);
    s_tab = 0;
    s_page = 0;
    open_selected();
}

static void session_row(lv_obj_t *parent, int index) {
    const ct_session_t *s = ct_model_session(index);
    lv_obj_t *row = ct_col(parent, CT_PAD, 3);
    lv_obj_set_height(row, 104);
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_START);
    ct_border(row, 2, LV_BORDER_SIDE_BOTTOM);

    char buf[96];
    lv_obj_t *r1 = ct_row(row, 28, 0, 10);
    ct_label(r1, MB20, s->name);
    snprintf(buf, sizeof(buf), "%s · %s", s->agent, s->model);
    ct_label_fill(r1, M18, buf);
    state_chip(r1, s_state[index]);

    lv_obj_t *r2 = ct_row(row, 28, 0, 8);
    if (s_note[index] != NULL) {
        ct_label_fill(r2, F20, s_note[index]);
    } else {
        ct_verb(r2, s->verb);
        ct_label_fill(r2, M20, s->target);
    }
    ct_label(r2, MB24, "›");

    lv_obj_t *r3 = ct_row(row, 24, 0, 8);
    if (s->stat != NULL) {
        snprintf(buf, sizeof(buf), "%s · %s", s->counts, s->stat);
    } else {
        snprintf(buf, sizeof(buf), "%s", s->counts);
    }
    ct_label_fill(r3, M18, buf);
    ct_label(r3, M18, s->when);

    ct_tappable(row, on_row, (void *)(intptr_t)index);
}

static void on_list_prev(lv_event_t *e) { (void)e; if (s_page > 0) { s_page--; show_list(); } }
static void on_list_next(lv_event_t *e) {
    (void)e;
    if ((s_page + 1) * LIST_ROWS < ct_model_session_count()) { s_page++; show_list(); }
}

static void show_list(void) {
    const int count = ct_model_session_count();
    if (s_screen != SCR_LIST) {
        s_page = 0;
    }
    int waiting = 0;
    for (int i = 0; i < count; i++) {
        waiting += is_waiting(s_state[i]) ? 1 : 0;
    }

    lv_obj_t *screen = ct_screen_new();
    ct_status_bar(screen);
    char buf[48];
    snprintf(buf, sizeof(buf), "会话 %d", count);
    lv_obj_t *nav = ct_nav(screen, buf, NULL);
    if (waiting > 0) {
        snprintf(buf, sizeof(buf), "%d 个等你", waiting);
        ct_chip(nav, buf, true, false);
    }

    lv_obj_t *content = ct_content(screen, 0);
    for (int i = s_page * LIST_ROWS; i < count && i < (s_page + 1) * LIST_ROWS; i++) {
        session_row(content, i);
    }

    lv_obj_t *bar = ct_bottom_bar(screen, 76);
    snprintf(buf, sizeof(buf), "%d/%d", s_page + 1, (count + LIST_ROWS - 1) / LIST_ROWS);
    ct_pager(bar, buf, on_list_prev, on_list_next);
    ct_spacer(bar);
    ct_label(bar, F18, "点一行看详情");
    present(screen, SCR_LIST);
}

/* ---------- session detail ---------- */

static const char *const kTabs[] = {"概览", "活动", "改动"};

static void on_tab(lv_event_t *e) {
    s_tab = (int)(intptr_t)lv_event_get_user_data(e);
    s_page = 0;
    show_detail();
}

static int activity_pages(const ct_session_t *s) {
    return (s->activity_count + ACTIVITY_ROWS - 1) / ACTIVITY_ROWS;
}

static void on_detail_prev(lv_event_t *e) { (void)e; if (s_page > 0) { s_page--; show_detail(); } }
static void on_detail_next(lv_event_t *e) {
    (void)e;
    const ct_session_t *s = ct_model_session(s_sel);
    const int pages = s_tab == 1 ? activity_pages(s) : (s_tab == 2 ? s->hunk_total : 1);
    if (s_page + 1 < pages) { s_page++; show_detail(); }
}

static void activity_row(lv_obj_t *parent, const ct_activity_t *a, int height, bool tappable) {
    lv_obj_t *row = ct_row(parent, height, tappable ? CT_PAD : 0, 8);
    lv_obj_t *time = ct_label(row, M18, a->time);
    lv_obj_set_width(time, 56);
    lv_obj_t *verb = ct_label(row, MB20, a->verb);
    lv_obj_set_width(verb, 62);
    ct_label_fill(row, M20, a->target);
    if (a->bad) {
        ct_chip(row, a->result, true, false);
    } else {
        ct_label(row, MB20, a->result);
    }
    if (tappable) {
        ct_border(row, 1, LV_BORDER_SIDE_BOTTOM);
        ct_label(row, MB24, "›");
        ct_tappable(row, NULL, NULL);
    }
}

static void detail_overview(lv_obj_t *screen, const ct_session_t *s) {
    char buf[96];
    snprintf(buf, sizeof(buf), "%s · %s", s->model, s->branch);
    ct_meta(screen, buf, s->meta_right);

    lv_obj_t *content = ct_content(screen, CT_PAD);
    lv_obj_set_style_pad_row(content, 6, 0);
    lv_obj_set_style_pad_top(content, 10, 0);

    ct_section(content, "正在做");
    lv_obj_t *now = ct_row(content, 40, 0, 8);
    ct_verb(now, s->verb);
    ct_label_fill(now, MB20, s->target);
    ct_label(now, MB20, "+18 −7");
    ct_label(now, MB24, "›");
    ct_tappable(now, NULL, NULL);

    ct_section(content, "在想");
    ct_paragraph(content, F20, s->thinking);

    ct_section(content, "做了这些");
    lv_obj_t *sum = ct_row(content, 26, 0, 8);
    ct_label_fill(sum, M20, s->summary);
    if (s->stat != NULL) {
        ct_label(sum, MB20, s->stat);
    }

    snprintf(buf, sizeof(buf), "任务 %d/%d", s->todo_done, s->todo_count);
    ct_section(content, buf);
    lv_obj_t *todos = ct_col(content, 0, 1);
    for (int i = 0; i < s->todo_count; i++) {
        const char *mark = i < s->todo_done ? "[x]" : (i == s->todo_done ? "[>]" : "[ ]");
        snprintf(buf, sizeof(buf), "%s %s", mark, s->todos[i]);
        ct_label(todos, i == s->todo_done ? MB20 : M20, buf);
    }

    ct_section(content, "刚才");
    lv_obj_t *recent = ct_col(content, 0, 2);
    for (int i = 1; i < 4 && i < s->activity_count; i++) {
        activity_row(recent, &s->activity[i], 28, false);
    }
}

static void detail_activity(lv_obj_t *screen, const ct_session_t *s) {
    lv_obj_t *content = ct_content(screen, 0);
    const int first = s_page * ACTIVITY_ROWS;
    for (int i = first; i < s->activity_count && i < first + ACTIVITY_ROWS; i++) {
        activity_row(content, &s->activity[i], 48, true);
    }
}

static void detail_changes(lv_obj_t *screen, const ct_session_t *s) {
    lv_obj_t *content = ct_content(screen, 0);
    for (int i = 0; i < s->file_count; i++) {
        const ct_file_t *f = &s->files[i];
        lv_obj_t *row = ct_row(content, 48, CT_PAD, 8);
        ct_border(row, i == s->file_count - 1 ? 3 : 1, LV_BORDER_SIDE_BOTTOM);
        if (i == 0) {
            ct_invert(row);
        }
        const char status[2] = {f->status, '\0'};
        ct_label(row, MB20, status);
        ct_label_fill(row, M20, f->path);
        ct_label(row, MB20, f->stat);
        ct_tappable(row, NULL, NULL);
    }
    lv_obj_t *hunk = ct_col(content, CT_PAD, 6);
    lv_obj_set_style_pad_top(hunk, 10, 0);
    lv_obj_t *title = ct_row(hunk, 24, 0, 8);
    ct_label_fill(title, B20, "epd_driver.c · 第 214 行");
    ct_label(title, M18, "这一处 +5 −1");
    lv_obj_t *box = ct_diff_box(hunk);
    static const ct_diff_line_t kLines[] = {
        {' ', "static int partial_n;"}, {' ', "void epd_flush(rect_t r) {"},
        {'-', "  epd_refresh(PARTIAL);"}, {'+', "  if (++partial_n >= 8) {"},
        {'+', "    epd_refresh(FULL);"}, {'+', "    partial_n = 0;"},
        {'+', "  } else {"}, {'+', "    epd_refresh(PARTIAL);"},
        {' ', "  }"}, {' ', "  epd_wait_busy();"}, {' ', "}"},
    };
    for (unsigned i = 0; i < sizeof(kLines) / sizeof(kLines[0]); i++) {
        ct_diff_add(box, kLines[i].kind, kLines[i].text);
    }
}

static void show_detail(void) {
    const ct_session_t *s = ct_model_session(s_sel);
    lv_obj_t *screen = ct_screen_new();
    header(screen, s, on_back_list);
    ct_tabs(screen, kTabs, 3, s_tab, on_tab);

    char buf[32];
    if (s_tab == 0) {
        detail_overview(screen, s);
        snprintf(buf, sizeof(buf), "1/1");
    } else if (s_tab == 1) {
        detail_activity(screen, s);
        snprintf(buf, sizeof(buf), "%d/%d", s_page + 1, activity_pages(s));
    } else {
        detail_changes(screen, s);
        snprintf(buf, sizeof(buf), "%d/%d 处", s_page + 1, s->hunk_total);
    }

    lv_obj_t *bar = ct_bottom_bar(screen, 76);
    ct_pager(bar, buf, on_detail_prev, on_detail_next);
    ct_spacer(bar);
    ct_button(bar, "发指令", B20, 112, 56, true, on_open_reply, NULL);
    present(screen, SCR_DETAIL);
}

/* ---------- approve ---------- */

static void on_approve(lv_event_t *e) { (void)e; resolve("已批准，继续运行"); }
static void on_deny(lv_event_t *e) { (void)e; resolve("已拒绝，等它换个办法"); }

static void show_approve(void) {
    const ct_session_t *s = ct_model_session(s_sel);
    lv_obj_t *screen = ct_screen_new();
    header(screen, s, on_back_list);
    char buf[96];
    snprintf(buf, sizeof(buf), "%s · %s", s->agent, s->model);
    ct_meta(screen, buf, s->expiry);

    lv_obj_t *content = ct_content(screen, CT_PAD);
    lv_obj_set_style_pad_row(content, 6, 0);
    lv_obj_set_style_pad_top(content, 10, 0);

    ct_section(content, "想改这个文件");
    lv_obj_t *file = ct_row(content, 28, 0, 8);
    ct_verb(file, s->verb);
    ct_label_fill(file, MB20, s->target);
    ct_label(file, MB20, s->hunk_stat);
    lv_obj_t *box = ct_diff_box(content);
    for (int i = 0; i < s->hunk_count; i++) {
        ct_diff_add(box, s->hunk[i].kind, s->hunk[i].text);
    }
    lv_obj_t *more = ct_row(content, 48, 12, 8);
    ct_border(more, 2, LV_BORDER_SIDE_FULL);
    ct_label_fill(more, B20, "看完整改动");
    ct_label(more, MB24, "›");
    ct_tappable(more, NULL, NULL);

    ct_section(content, "它的理由");
    ct_paragraph(content, F20, s->reason);

    ct_section(content, "这一轮");
    lv_obj_t *sum = ct_row(content, 26, 0, 8);
    ct_label_fill(sum, M20, s->counts);
    ct_label(sum, MB20, s->stat);

    lv_obj_t *hint = ct_row(screen, 32, CT_PAD, 0);
    ct_label(hint, F18, "删除、推送这类命令要长按“批准”才生效");

    lv_obj_t *bar = ct_bottom_bar(screen, 88);
    lv_obj_set_style_pad_column(bar, 12, 0);
    lv_obj_t *deny = ct_button(bar, "拒绝", B24, 100, 64, false, on_deny, NULL);
    lv_obj_set_flex_grow(deny, 1);
    lv_obj_t *ok = ct_button(bar, "批准", B24, 100, 64, true, on_approve, NULL);
    lv_obj_set_flex_grow(ok, 1);
    present(screen, SCR_APPROVE);
}

/* ---------- question ---------- */

static void on_option(lv_event_t *e) {
    (void)e;
    resolve("已回答，继续运行");
}

static void show_question(void) {
    const ct_session_t *s = ct_model_session(s_sel);
    lv_obj_t *screen = ct_screen_new();
    header(screen, s, on_back_list);
    char buf[96];
    snprintf(buf, sizeof(buf), "%s · %s", s->agent, s->model);
    ct_meta(screen, buf, s->meta_right);

    lv_obj_t *content = ct_content(screen, CT_PAD);
    lv_obj_set_style_pad_row(content, 8, 0);
    lv_obj_set_style_pad_top(content, 10, 0);

    ct_section(content, "它问你");
    ct_paragraph(content, B24, s->question);
    ct_paragraph(content, F20, s->question_note);

    for (int i = 0; i < s->option_count; i++) {
        lv_obj_t *opt = ct_row(content, 88, 14, 14);
        ct_border(opt, 3, LV_BORDER_SIDE_FULL);
        lv_obj_t *num = ct_box(opt);
        lv_obj_set_size(num, 48, 48);
        ct_invert(num);
        snprintf(buf, sizeof(buf), "%d", i + 1);
        lv_obj_center(ct_label(num, MB24, buf));
        lv_obj_t *text = ct_col(opt, 0, 2);
        lv_obj_set_flex_grow(text, 1);
        ct_label(text, B20, s->options[i].label);
        ct_label(text, F18, s->options[i].desc);
        ct_tappable(opt, on_option, (void *)(intptr_t)i);
    }
    ct_button(content, "都不是，按住这里说", B20, LV_PCT(100), 64, false, on_open_reply, NULL);

    lv_obj_t *hint = ct_row(screen, 44, CT_PAD, 0);
    lv_obj_set_flex_align(hint, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    ct_label(hint, F18, "点一个选项，就直接发给它");
    present(screen, SCR_QUESTION);
}

/* ---------- completion report ---------- */

static void on_dismiss(lv_event_t *e) {
    (void)e;
    s_state[s_sel] = CT_STATE_IDLE;
    s_note[s_sel] = "已看过，等你的下一步";
    show_list();
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
    lv_obj_set_flex_grow(spans, 1);
    lv_obj_set_height(spans, LV_SIZE_CONTENT);
    lv_obj_set_style_text_font(spans, F20, 0);
    lv_obj_set_style_text_line_space(spans, 3, 0);
    lv_spangroup_set_mode(spans, LV_SPAN_MODE_BREAK);
    if (p->lead != NULL) {
        lv_span_t *lead = lv_spangroup_add_span(spans);
        lv_span_set_text(lead, p->lead);
        lv_style_set_text_font(lv_span_get_style(lead), B20);
    }
    lv_span_t *body = lv_spangroup_add_span(spans);
    lv_span_set_text(body, p->text);
    lv_spangroup_refresh(spans);
}

static void show_done(void) {
    const ct_session_t *s = ct_model_session(s_sel);
    lv_obj_t *screen = ct_screen_new();
    header(screen, s, on_back_list);
    char buf[96];
    snprintf(buf, sizeof(buf), "%s · %s", s->model, s->meta_right);
    ct_meta(screen, buf, s->stat);

    lv_obj_t *content = ct_content(screen, CT_PAD);
    lv_obj_set_style_pad_row(content, 7, 0);
    lv_obj_set_style_pad_top(content, 10, 0);
    for (int i = 0; i < s->report_count; i++) {
        report_para(content, &s->report[i]);
    }

    lv_obj_t *bar = ct_bottom_bar(screen, 76);
    ct_pager(bar, "1/1", NULL, NULL);
    ct_spacer(bar);
    ct_button(bar, "知道了", B20, 96, 56, false, on_dismiss, NULL);
    ct_button(bar, "回复", B20, 80, 56, true, on_open_reply, NULL);
    present(screen, SCR_DONE);
}

/* ---------- reply ---------- */

static void on_quick(lv_event_t *e) {
    (void)e;
    resolve("已发送，继续运行");
}

static void on_hold_to_talk(lv_event_t *e) { (void)e; show_voice(); }

static void show_reply(void) {
    const ct_session_t *s = ct_model_session(s_sel);
    lv_obj_t *screen = ct_screen_new();
    ct_status_bar(screen);
    lv_obj_t *nav = ct_nav(screen, s->name, on_back_from_reply);
    ct_chip(nav, "回复", false, true);
    char buf[96];
    snprintf(buf, sizeof(buf), "%s · %s", s->agent, s->model);
    ct_meta(screen, buf, state_text(s_state[s_sel]));

    lv_obj_t *content = ct_content(screen, CT_PAD);
    lv_obj_set_style_pad_row(content, 8, 0);
    lv_obj_set_style_pad_top(content, 12, 0);

    ct_section(content, "点一句直接发");
    for (int i = 0; i < ct_model_quick_reply_count(); i++) {
        lv_obj_t *q = ct_row(content, 60, 14, 8);
        ct_border(q, 3, LV_BORDER_SIDE_FULL);
        ct_label_fill(q, B20, ct_model_quick_reply(i));
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
    ct_label(hint, F18, "按住机身上的 BOOT 键也一样");
    present(screen, SCR_REPLY);
}

/* ---------- voice confirmation ---------- */

static void on_send(lv_event_t *e) { (void)e; resolve("已发送，继续运行"); }

static void show_voice(void) {
    const ct_session_t *s = ct_model_session(s_sel);
    lv_obj_t *screen = ct_screen_new();
    ct_status_bar(screen);
    lv_obj_t *nav = ct_nav(screen, s->name, on_back_reply);
    ct_chip(nav, "语音", false, true);
    char buf[96];
    snprintf(buf, sizeof(buf), "%s · %s", s->agent, s->model);
    ct_meta(screen, buf, "豆包识别");

    lv_obj_t *content = ct_content(screen, CT_PAD);
    lv_obj_set_style_pad_row(content, 8, 0);
    lv_obj_set_style_pad_top(content, 12, 0);

    ct_section(content, "你说的");
    lv_obj_t *heard = ct_col(content, 12, 0);
    lv_obj_set_style_pad_ver(heard, 12, 0);
    ct_border(heard, 2, LV_BORDER_SIDE_FULL);
    ct_paragraph(heard, B24, s_heard);

    ct_section(content, "它现在");
    lv_obj_t *now = ct_row(content, 28, 0, 8);
    ct_verb(now, s->verb);
    ct_label_fill(now, M20, s->target);

    ct_section(content, "它刚说");
    ct_paragraph(content, F20, s->thinking);

    ct_section(content, "发出去之后");
    ct_paragraph(content, F20, "这句话排在它当前这一步后面，不会打断正在进行的修改。");

    lv_obj_t *bar = ct_bottom_bar(screen, 88);
    lv_obj_set_style_pad_column(bar, 12, 0);
    lv_obj_t *redo = ct_button(bar, "重说", B24, 100, 64, false, on_back_reply, NULL);
    lv_obj_set_flex_grow(redo, 1);
    lv_obj_t *send = ct_button(bar, "发送", B24, 100, 64, true, on_send, NULL);
    lv_obj_set_flex_grow(send, 1);
    present(screen, SCR_VOICE);
}

/* ---------- entry points ---------- */

void ct_ui_init(void) {
    ct_widgets_init();
    const int count = ct_model_session_count();
    for (int i = 0; i < count && i < MAX_SESSIONS; i++) {
        s_state[i] = ct_model_session(i)->state;
        s_note[i] = NULL;
    }
    s_screen = SCR_DETAIL; /* so the first show_list() starts on page 0 */
    show_list();
}

void ct_ui_on_key(ct_key_t key, bool down) {
    if (!down) {
        return;
    }
    switch (key) {
    case CT_KEY_HOME:
        show_list();
        break;
    case CT_KEY_VOL_UP:
    case CT_KEY_PREV:
        if (s_screen == SCR_LIST) on_list_prev(NULL); else if (s_screen == SCR_DETAIL) on_detail_prev(NULL);
        break;
    case CT_KEY_VOL_DOWN:
    case CT_KEY_NEXT:
        if (s_screen == SCR_LIST) on_list_next(NULL); else if (s_screen == SCR_DETAIL) on_detail_next(NULL);
        break;
    case CT_KEY_BOOT:
        if (s_screen != SCR_LIST) {
            if (s_screen != SCR_REPLY && s_screen != SCR_VOICE) {
                s_reply_from = s_screen;
            }
            show_voice();
        }
        break;
    default:
        break;
    }
}
