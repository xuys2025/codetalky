#include "ct_widgets.h"

#include "ct_hal.h"

static lv_style_t s_pressed;     /* normal objects: turn black while pressed */
static lv_style_t s_pressed_inv; /* inverted objects: turn white while pressed */
static bool s_ready;

void ct_widgets_init(void) {
    if (s_ready) {
        return;
    }
    s_ready = true;
    lv_style_init(&s_pressed);
    lv_style_set_bg_color(&s_pressed, lv_color_black());
    lv_style_set_bg_opa(&s_pressed, LV_OPA_COVER);
    lv_style_set_text_color(&s_pressed, lv_color_white());
    lv_style_init(&s_pressed_inv);
    lv_style_set_bg_color(&s_pressed_inv, lv_color_white());
    lv_style_set_bg_opa(&s_pressed_inv, LV_OPA_COVER);
    lv_style_set_text_color(&s_pressed_inv, lv_color_black());
}

lv_obj_t *ct_box(lv_obj_t *parent) {
    lv_obj_t *obj = lv_obj_create(parent);
    lv_obj_remove_style_all(obj);
    lv_obj_remove_flag(obj, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
    return obj;
}

lv_obj_t *ct_row(lv_obj_t *parent, int32_t height, int32_t pad_x, int32_t gap) {
    lv_obj_t *row = ct_box(parent);
    lv_obj_set_size(row, LV_PCT(100), height);
    lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(row, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_hor(row, pad_x, 0);
    lv_obj_set_style_pad_column(row, gap, 0);
    return row;
}

lv_obj_t *ct_col(lv_obj_t *parent, int32_t pad_x, int32_t gap) {
    lv_obj_t *col = ct_box(parent);
    lv_obj_set_size(col, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_hor(col, pad_x, 0);
    lv_obj_set_style_pad_row(col, gap, 0);
    return col;
}

lv_obj_t *ct_spacer(lv_obj_t *parent) {
    lv_obj_t *spacer = ct_box(parent);
    lv_obj_set_size(spacer, 1, 1);
    lv_obj_set_flex_grow(spacer, 1);
    return spacer;
}

lv_obj_t *ct_label(lv_obj_t *parent, const lv_font_t *font, const char *text) {
    lv_obj_t *label = lv_label_create(parent);
    lv_obj_set_style_text_font(label, font, 0);
    lv_label_set_text(label, text != NULL ? text : "");
    return label;
}

lv_obj_t *ct_label_fill(lv_obj_t *parent, const lv_font_t *font, const char *text) {
    lv_obj_t *label = ct_label(parent, font, text);
    lv_label_set_long_mode(label, LV_LABEL_LONG_MODE_DOTS);
    lv_obj_set_height(label, lv_font_get_line_height(font));
    lv_obj_set_flex_grow(label, 1);
    return label;
}

lv_obj_t *ct_paragraph(lv_obj_t *parent, const lv_font_t *font, const char *text) {
    lv_obj_t *label = ct_label(parent, font, text);
    lv_label_set_long_mode(label, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_width(label, LV_PCT(100));
    lv_obj_set_style_text_line_space(label, 3, 0);
    return label;
}

void ct_invert(lv_obj_t *obj) {
    lv_obj_set_style_bg_color(obj, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(obj, LV_OPA_COVER, 0);
    lv_obj_set_style_text_color(obj, lv_color_white(), 0);
}

void ct_border(lv_obj_t *obj, int32_t width, lv_border_side_t side) {
    lv_obj_set_style_border_color(obj, lv_color_black(), 0);
    lv_obj_set_style_border_width(obj, width, 0);
    lv_obj_set_style_border_side(obj, side, 0);
}

lv_obj_t *ct_chip(lv_obj_t *parent, const char *text, bool inverted, bool outlined) {
    lv_obj_t *chip = ct_box(parent);
    lv_obj_set_size(chip, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_style_pad_hor(chip, 8, 0);
    lv_obj_set_style_pad_ver(chip, 1, 0);
    if (inverted) {
        ct_invert(chip);
    } else if (outlined) {
        ct_border(chip, 2, LV_BORDER_SIDE_FULL);
    }
    ct_label(chip, B20, text);
    return chip;
}

lv_obj_t *ct_verb(lv_obj_t *parent, const char *text) {
    lv_obj_t *verb = ct_box(parent);
    lv_obj_set_size(verb, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_style_pad_hor(verb, 5, 0);
    ct_border(verb, 2, LV_BORDER_SIDE_FULL);
    ct_label(verb, MB20, text);
    return verb;
}

lv_obj_t *ct_section(lv_obj_t *parent, const char *text) {
    lv_obj_t *row = ct_row(parent, 26, 0, 8);
    lv_obj_t *tag = ct_box(row);
    lv_obj_set_size(tag, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    lv_obj_set_style_pad_hor(tag, 7, 0);
    ct_invert(tag);
    ct_label(tag, F18, text);
    lv_obj_t *rule = ct_box(row);
    lv_obj_set_height(rule, 2);
    lv_obj_set_flex_grow(rule, 1);
    lv_obj_set_style_bg_color(rule, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(rule, LV_OPA_COVER, 0);
    return row;
}

static void on_pressed(lv_event_t *e) {
    (void)e;
    ct_hal_refresh_hint(CT_REFRESH_PARTIAL);
    ct_hal_vibrate(35);
}

void ct_tappable(lv_obj_t *obj, lv_event_cb_t on_click, void *user_data) {
    lv_obj_add_flag(obj, LV_OBJ_FLAG_CLICKABLE);
    const bool inverted = lv_obj_get_style_bg_opa(obj, 0) == LV_OPA_COVER &&
                          lv_color_eq(lv_obj_get_style_bg_color(obj, 0), lv_color_black());
    lv_obj_add_style(obj, inverted ? &s_pressed_inv : &s_pressed, LV_STATE_PRESSED);
    lv_obj_add_event_cb(obj, on_pressed, LV_EVENT_PRESSED, NULL);
    if (on_click != NULL) {
        lv_obj_add_event_cb(obj, on_click, LV_EVENT_CLICKED, user_data);
    }
}

lv_obj_t *ct_button(lv_obj_t *parent, const char *text, const lv_font_t *font, int32_t width,
                    int32_t height, bool inverted, lv_event_cb_t on_click, void *user_data) {
    lv_obj_t *button = ct_box(parent);
    lv_obj_set_size(button, width, height);
    ct_border(button, 3, LV_BORDER_SIDE_FULL);
    if (inverted) {
        ct_invert(button);
    }
    lv_obj_t *label = ct_label(button, font, text);
    lv_obj_center(label);
    ct_tappable(button, on_click, user_data);
    return button;
}

lv_obj_t *ct_screen_new(void) {
    lv_obj_t *screen = lv_obj_create(NULL);
    lv_obj_remove_style_all(screen);
    lv_obj_remove_flag(screen, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_bg_color(screen, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);
    lv_obj_set_style_text_color(screen, lv_color_black(), 0);
    lv_obj_set_style_text_font(screen, F20, 0);
    lv_obj_set_flex_flow(screen, LV_FLEX_FLOW_COLUMN);
    return screen;
}

void ct_status_bar(lv_obj_t *screen) {
    lv_obj_t *bar = ct_row(screen, 36, CT_PAD, 0);
    ct_invert(bar);
    ct_label(bar, MB20, "codetalky");
    ct_spacer(bar);
    ct_label(bar, MB20, "14:32 · 82%");
}

lv_obj_t *ct_nav(lv_obj_t *screen, const char *title, lv_event_cb_t on_back) {
    lv_obj_t *nav = ct_row(screen, 56, 0, 12);
    ct_border(nav, 3, LV_BORDER_SIDE_BOTTOM);
    lv_obj_set_style_pad_right(nav, CT_PAD, 0);
    if (on_back != NULL) {
        lv_obj_t *back = ct_box(nav);
        lv_obj_set_size(back, 64, 53);
        ct_border(back, 2, LV_BORDER_SIDE_RIGHT);
        lv_obj_t *arrow = ct_label(back, MB24, "‹");
        lv_obj_center(arrow);
        ct_tappable(back, on_back, NULL);
    } else {
        lv_obj_set_style_pad_left(nav, CT_PAD, 0);
    }
    ct_label_fill(nav, MB24, title);
    return nav;
}

void ct_tabs(lv_obj_t *screen, const char *const *names, int count, int active, lv_event_cb_t on_tab) {
    lv_obj_t *tabs = ct_row(screen, 56, 0, 0);
    ct_border(tabs, 3, LV_BORDER_SIDE_BOTTOM);
    for (int i = 0; i < count; i++) {
        lv_obj_t *tab = ct_box(tabs);
        lv_obj_set_height(tab, 53);
        lv_obj_set_flex_grow(tab, 1);
        if (i < count - 1) {
            ct_border(tab, 2, LV_BORDER_SIDE_RIGHT);
        }
        if (i == active) {
            ct_invert(tab);
        }
        lv_obj_t *label = ct_label(tab, B20, names[i]);
        lv_obj_center(label);
        ct_tappable(tab, on_tab, (void *)(intptr_t)i);
    }
}

lv_obj_t *ct_meta(lv_obj_t *screen, const char *left, const char *right) {
    lv_obj_t *meta = ct_row(screen, 34, CT_PAD, 8);
    ct_border(meta, 2, LV_BORDER_SIDE_BOTTOM);
    ct_label_fill(meta, M18, left);
    if (right != NULL) {
        ct_label(meta, M18, right);
    }
    return meta;
}

lv_obj_t *ct_content(lv_obj_t *screen, int32_t pad_x) {
    lv_obj_t *content = ct_box(screen);
    lv_obj_set_width(content, LV_PCT(100));
    lv_obj_set_flex_grow(content, 1);
    lv_obj_set_flex_flow(content, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_hor(content, pad_x, 0);
    return content;
}

lv_obj_t *ct_bottom_bar(lv_obj_t *screen, int32_t height) {
    lv_obj_t *bar = ct_row(screen, height, CT_PAD, 10);
    ct_border(bar, 3, LV_BORDER_SIDE_TOP);
    return bar;
}

void ct_pager(lv_obj_t *bar, const char *text, lv_event_cb_t on_prev, lv_event_cb_t on_next) {
    ct_button(bar, "‹", MB24, 60, 56, false, on_prev, NULL);
    ct_label(bar, MB20, text);
    ct_button(bar, "›", MB24, 60, 56, false, on_next, NULL);
}

lv_obj_t *ct_diff_box(lv_obj_t *parent) {
    lv_obj_t *box = ct_box(parent);
    lv_obj_set_size(box, LV_PCT(100), LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(box, LV_FLEX_FLOW_COLUMN);
    ct_border(box, 2, LV_BORDER_SIDE_FULL);
    return box;
}

void ct_diff_add(lv_obj_t *diff_box, char kind, const char *text) {
    lv_obj_t *line = ct_row(diff_box, 26, 8, 8);
    if (kind == '+') {
        ct_invert(line);
    }
    ct_label(line, M18, kind == '+' ? "+" : (kind == '-' ? "−" : " "));
    lv_obj_t *code = ct_label_fill(line, M18, text);
    lv_label_set_long_mode(code, LV_LABEL_LONG_MODE_CLIP);
}
