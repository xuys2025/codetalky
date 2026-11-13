/* Building blocks shared by all CodeTalky screens. Black and white only. */
#ifndef CT_WIDGETS_H
#define CT_WIDGETS_H

#include "ct_fonts.h"
#include "lvgl.h"

#define CT_W 480
#define CT_H 800
#define CT_PAD 14

#define F18 (&ct_font_text_18)
#define F20 (&ct_font_text_20)
#define B20 (&ct_font_bold_20)
#define B24 (&ct_font_bold_24)
#define M18 (&ct_font_mono_18)
#define M20 (&ct_font_mono_20)
#define MB20 (&ct_font_monob_20)
#define MB24 (&ct_font_monob_24)

void ct_widgets_init(void);

/* Plain containers: no theme styling, not scrollable, not clickable. */
lv_obj_t *ct_box(lv_obj_t *parent);
lv_obj_t *ct_row(lv_obj_t *parent, int32_t height, int32_t pad_x, int32_t gap);
lv_obj_t *ct_col(lv_obj_t *parent, int32_t pad_x, int32_t gap);
lv_obj_t *ct_spacer(lv_obj_t *parent);

lv_obj_t *ct_label(lv_obj_t *parent, const lv_font_t *font, const char *text);
/* One line that takes the remaining width and ends in dots when too long. */
lv_obj_t *ct_label_fill(lv_obj_t *parent, const lv_font_t *font, const char *text);
/* Wrapping paragraph, full width, broken by Chinese line-breaking rules. */
lv_obj_t *ct_paragraph(lv_obj_t *parent, const lv_font_t *font, const char *text);
/* Re-break a wrapping label's text to its current width by those rules. */
void ct_label_wrap(lv_obj_t *label);

void ct_invert(lv_obj_t *obj);
void ct_border(lv_obj_t *obj, int32_t width, lv_border_side_t side);

/* Small tag such as 等批准; inverted = white on black, otherwise outlined or bare. */
lv_obj_t *ct_chip(lv_obj_t *parent, const char *text, bool inverted, bool outlined);
/* Outlined tool name: Edit, Bash ... */
lv_obj_t *ct_verb(lv_obj_t *parent, const char *text);
/* Black tag followed by a rule across the rest of the row. */
lv_obj_t *ct_section(lv_obj_t *parent, const char *text);

/* Make any object tappable: it inverts while pressed and gives a haptic tick. */
void ct_tappable(lv_obj_t *obj, lv_event_cb_t on_click, void *user_data);
lv_obj_t *ct_button(lv_obj_t *parent, const char *text, const lv_font_t *font, int32_t width,
                    int32_t height, bool inverted, lv_event_cb_t on_click, void *user_data);

/* Screen chrome. */
lv_obj_t *ct_screen_new(void);
void ct_status_bar(lv_obj_t *screen, const char *left, const char *right);
lv_obj_t *ct_nav(lv_obj_t *screen, const char *title, lv_event_cb_t on_back);
void ct_tabs(lv_obj_t *screen, const char *const *names, int count, int active, lv_event_cb_t on_tab);
lv_obj_t *ct_meta(lv_obj_t *screen, const char *left, const char *right);
/* Fills the space between the top chrome and the bottom bar. */
lv_obj_t *ct_content(lv_obj_t *screen, int32_t pad_x);
lv_obj_t *ct_bottom_bar(lv_obj_t *screen, int32_t height);
void ct_pager(lv_obj_t *bar, const char *text, lv_event_cb_t on_prev, lv_event_cb_t on_next);
/* A boxed, read-only diff. */
lv_obj_t *ct_diff_box(lv_obj_t *parent);
void ct_diff_add(lv_obj_t *diff_box, char kind, const char *text);

#endif /* CT_WIDGETS_H */
