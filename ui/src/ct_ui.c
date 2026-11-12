/*
 * Bring-up screen: proves that LVGL renders, touch works and keys arrive.
 * It is replaced by the real screens once the visual style is chosen.
 */
#include "ct_ui.h"

#include "ct_hal.h"
#include "lvgl.h"

static lv_obj_t *s_tap_label;
static lv_obj_t *s_key_label;
static int s_taps;

static const char *const kKeyNames[CT_KEY_COUNT] = {
    "BOOT", "POWER", "VOL+", "VOL-", "HOME", "PREV", "NEXT",
};

static void on_tap(lv_event_t *e) {
    (void)e;
    s_taps++;
    ct_hal_refresh_hint(CT_REFRESH_PARTIAL);
    ct_hal_vibrate(35);
    lv_label_set_text_fmt(s_tap_label, "Taps: %d", s_taps);
}

void ct_ui_init(void) {
    lv_display_t *disp = lv_display_get_default();
    lv_display_set_theme(disp, lv_theme_mono_init(disp, false, &lv_font_montserrat_24));

    lv_obj_t *scr = lv_screen_active();
    lv_obj_set_style_bg_color(scr, lv_color_white(), 0);
    lv_obj_set_style_bg_opa(scr, LV_OPA_COVER, 0);
    lv_obj_set_style_text_color(scr, lv_color_black(), 0);
    lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);

    lv_obj_t *title = lv_label_create(scr);
    lv_label_set_text(title, "CodeTalky");
    lv_obj_set_style_text_font(title, &lv_font_montserrat_32, 0);
    lv_obj_align(title, LV_ALIGN_TOP_LEFT, 28, 40);

    lv_obj_t *rule = lv_obj_create(scr);
    lv_obj_remove_style_all(rule);
    lv_obj_set_size(rule, 424, 4);
    lv_obj_set_style_bg_color(rule, lv_color_black(), 0);
    lv_obj_set_style_bg_opa(rule, LV_OPA_COVER, 0);
    lv_obj_align(rule, LV_ALIGN_TOP_LEFT, 28, 96);

    lv_obj_t *cjk = lv_label_create(scr);
    /* LVGL's built-in CJK font only has about 1000 glyphs; the real fonts come later. */
    lv_label_set_text(cjk, "中文正常");
    lv_obj_set_style_text_font(cjk, &lv_font_source_han_sans_sc_16_cjk, 0);
    lv_obj_align(cjk, LV_ALIGN_TOP_LEFT, 28, 124);

    lv_obj_t *info = lv_label_create(scr);
    lv_label_set_text_fmt(info, "LVGL %d.%d.%d simulator bring-up\n480 x 800, 1-bit",
                          LVGL_VERSION_MAJOR, LVGL_VERSION_MINOR, LVGL_VERSION_PATCH);
    lv_obj_align(info, LV_ALIGN_TOP_LEFT, 28, 168);

    lv_obj_t *btn = lv_button_create(scr);
    lv_obj_set_size(btn, 424, 100);
    lv_obj_align(btn, LV_ALIGN_TOP_LEFT, 28, 300);
    lv_obj_add_event_cb(btn, on_tap, LV_EVENT_CLICKED, NULL);
    lv_obj_t *btn_label = lv_label_create(btn);
    lv_label_set_text(btn_label, "Tap me");
    lv_obj_set_style_text_font(btn_label, &lv_font_montserrat_32, 0);
    lv_obj_center(btn_label);

    s_tap_label = lv_label_create(scr);
    lv_label_set_text(s_tap_label, "Taps: 0");
    lv_obj_align(s_tap_label, LV_ALIGN_TOP_LEFT, 28, 430);

    s_key_label = lv_label_create(scr);
    lv_label_set_text(s_key_label, "Key: none");
    lv_obj_align(s_key_label, LV_ALIGN_TOP_LEFT, 28, 480);
}

void ct_ui_on_key(ct_key_t key, bool down) {
    if (key >= CT_KEY_COUNT || s_key_label == NULL) {
        return;
    }
    ct_hal_refresh_hint(CT_REFRESH_PARTIAL);
    lv_label_set_text_fmt(s_key_label, "Key: %s %s", kKeyNames[key], down ? "down" : "up");
}
