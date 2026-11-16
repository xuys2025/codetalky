/*
 * CX25601N charger, following the vendor firmware
 * (main/boards/common/power/cx25601n.cc: hw_init_defaults and charger_vreg_task).
 */
#include "charger.h"

#include <stdio.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "charger";

#define ADDR 0x6B
#define TIMEOUT_MS 100

#define REG_ICHG_LO 0x02 /* ICHG[1:0] at bits 7:6 */
#define REG_ICHG_HI 0x03 /* ICHG[5:2] at bits 3:0 */
#define REG_VREG_LO 0x04 /* VREG[4:0] at bits 7:3 */
#define REG_VREG_HI 0x05 /* VREG[8:5] at bits 3:0 */
#define REG_IINDPM_LO 0x06
#define REG_IINDPM_HI 0x07
#define REG_IPRECHG_LO 0x10
#define REG_IPRECHG_HI 0x11
#define REG_ITERM_LO 0x12
#define REG_ITERM_HI 0x13
#define REG_CTRL0 0x14 /* bit 2 EN_TERM */
#define REG_TIMER 0x15 /* bit 6 automatic input type detection */
#define REG_CTRL1 0x16 /* bit 5 EN_CHG, bit 4 EN_HIZ, bits 1:0 watchdog */
#define REG_CTRL3 0x18 /* bit 6 OTG boost, BATFET control */
#define REG_STATUS 0x1E /* bits 4:3 charge status, bits 2:0 VBUS status */
#define REG_PART 0x38
#define REG_UNLOCK 0x70

/* Values the vendor firmware uses: a 4.4 V cell, 1000 mA (its settings default),
 * input limit equal to the charge current. */
#define VREG_MV 4400
#define ICHG_MA 1000
/* Below this, with nothing plugged in, the battery is switched off to protect it. */
#define CUTOFF_MV 3100

static i2c_master_dev_handle_t s_dev;
static int s_status = -1;
static bool s_usb;
static bool s_cut_off;
static bool s_on_battery; /* measuring: input switched off on purpose */

static esp_err_t rd(uint8_t reg, uint8_t *v) {
    return i2c_master_transmit_receive(s_dev, &reg, 1, v, 1, TIMEOUT_MS);
}

static esp_err_t wr(uint8_t reg, uint8_t v) {
    const uint8_t buf[2] = {reg, v};
    return i2c_master_transmit(s_dev, buf, 2, TIMEOUT_MS);
}

/* Set the field of `mask` bits at `shift` in reg. */
static esp_err_t set_bits(uint8_t reg, uint8_t mask, uint8_t shift, uint8_t value) {
    uint8_t cur;
    esp_err_t err = rd(reg, &cur);
    if (err != ESP_OK) {
        return err;
    }
    const uint8_t m = (uint8_t)(mask << shift);
    return wr(reg, (uint8_t)((cur & ~m) | ((value << shift) & m)));
}

static void unlock_private(bool unlock) {
    if (!unlock) {
        wr(REG_UNLOCK, 0x00);
        return;
    }
    for (int i = 0; i < 10; i++) {
        wr(REG_UNLOCK, 0x00);
        wr(REG_UNLOCK, 0x50);
        wr(REG_UNLOCK, 0x57);
        wr(REG_UNLOCK, 0x44);
        uint8_t v = 0;
        if (rd(REG_UNLOCK, &v) == ESP_OK && v == 0x03) {
            return;
        }
    }
    ESP_LOGW(TAG, "private registers stayed locked");
}

static void dump(const char *when) {
    char line[128];
    int n = 0;
    for (uint8_t reg = 0x02; reg <= 0x18 && n < (int)sizeof(line) - 4; reg++) {
        uint8_t v = 0;
        n += snprintf(line + n, sizeof(line) - n, rd(reg, &v) == ESP_OK ? "%02x " : "?? ", v);
    }
    uint8_t st = 0;
    rd(REG_STATUS, &st);
    ESP_LOGI(TAG, "%s: regs 02..18 = %sstatus %02x (charge %d, vbus %d)", when, line, st, (st >> 3) & 3, st & 7);
}

static esp_err_t apply_defaults(void) {
    esp_err_t err = ESP_OK;
    /* A PC's port gets detected as "standard USB" and limited to 500 mA otherwise. */
    err |= set_bits(REG_TIMER, 0x01, 6, 0);
    /* Reverse boost (OTG: the battery powering the USB port, for the vendor's USB
     * camera) off. The vendor's self test turns it on and, if left early, never off;
     * the chip keeps it while the battery is connected: no charging, battery drained
     * (found 2026-11-16). */
    err |= set_bits(REG_CTRL3, 0x01, 6, 0);
    err |= set_bits(REG_CTRL1, 0x01, 4, 0); /* not high impedance */
    err |= set_bits(REG_CTRL1, 0x03, 0, 0); /* no I2C watchdog (it would reset all this) */
    err |= set_bits(REG_IPRECHG_LO, 0x0F, 4, 0x0C); /* precharge 240 mA */
    err |= set_bits(REG_IPRECHG_HI, 0x01, 0, 0);
    err |= set_bits(REG_ITERM_LO, 0x1F, 3, 0x06); /* terminate at 60 mA */
    err |= set_bits(REG_ITERM_HI, 0x01, 0, 0);
    const unsigned vreg = VREG_MV / 10;
    err |= set_bits(REG_VREG_LO, 0x1F, 3, vreg & 0x1F);
    err |= set_bits(REG_VREG_HI, 0x0F, 0, (vreg >> 5) & 0x0F);
    const unsigned ichg = ICHG_MA / 80;
    err |= set_bits(REG_ICHG_LO, 0x03, 6, ichg & 0x03);
    err |= set_bits(REG_ICHG_HI, 0x0F, 0, (ichg >> 2) & 0x0F);
    const unsigned iindpm = ICHG_MA / 20;
    err |= set_bits(REG_IINDPM_LO, 0x0F, 4, iindpm & 0x0F);
    err |= set_bits(REG_IINDPM_HI, 0x0F, 0, (iindpm >> 4) & 0x0F);

    /* The vendor's private register sequence (from the chip maker's reference code). */
    unlock_private(true);
    wr(0x86, 0x06);
    wr(0x3A, 0x10);
    wr(0x46, 0x20);
    unlock_private(false);
    set_bits(REG_CTRL0, 0x01, 0, 1);
    set_bits(REG_CTRL3, 0x01, 2, 0);
    set_bits(0x1A, 0x01, 7, 1);
    set_bits(0x23, 0x07, 2, 0x07);
    set_bits(0x24, 0x01, 3, 1);

    err |= set_bits(REG_CTRL1, 0x01, 5, 1); /* charging on */
    return err;
}

void charger_init(i2c_master_bus_handle_t bus) {
    if (i2c_master_probe(bus, ADDR, 100) != ESP_OK) {
        ESP_LOGW(TAG, "no charger at 0x%02x", ADDR);
        return;
    }
    const i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = ADDR,
        .scl_speed_hz = 400000,
    };
    if (i2c_master_bus_add_device(bus, &cfg, &s_dev) != ESP_OK) {
        s_dev = NULL;
        return;
    }
    uint8_t part = 0;
    rd(REG_PART, &part);
    ESP_LOGI(TAG, "charger part info %02x", part);
    dump("as found");
    if (apply_defaults() != ESP_OK) {
        ESP_LOGE(TAG, "setting up the charger failed");
    }
    vTaskDelay(pdMS_TO_TICKS(50));
    dump("set up");
}

void charger_run_on_battery(bool on) {
    if (s_dev == NULL) {
        return;
    }
    s_on_battery = on;
    set_bits(REG_CTRL1, 0x01, 4, on ? 1 : 0);
    ESP_LOGW(TAG, "%s", on ? "running on the battery with USB in (measuring)" : "taking power from USB again");
}

int charger_status(bool *usb) {
    if (usb != NULL) {
        *usb = s_usb;
    }
    return s_status;
}

void charger_battery_off(void) {
    if (s_dev != NULL) {
        ESP_LOGW(TAG, "switching the battery off");
        wr(REG_CTRL3, 0x01); /* BATFET off */
    }
}

bool charger_tick(int mv, int ma) {
    if (s_dev == NULL) {
        return false;
    }
    uint8_t st;
    if (rd(REG_STATUS, &st) != ESP_OK) {
        return false;
    }
    s_status = (st >> 3) & 3;
    /* With input type detection off, the chip reports "no input" even while charging:
     * current flowing into the battery is the reliable sign of USB power. */
    s_usb = ((st & 7) != 0 && (st & 7) != 7) || ma > 20;
    if (mv < 2500 || s_on_battery) {
        return false; /* no believable reading, or measuring on purpose */
    }

    if (!s_usb && ma < 0 && mv <= CUTOFF_MV && !s_cut_off) {
        ESP_LOGW(TAG, "battery at %d mV with nothing plugged in: empty", mv);
        s_cut_off = true;
        return true;
    }
    if (mv > CUTOFF_MV + 100) {
        s_cut_off = false;
    }

    /* Allow termination only once the cell is at the target voltage: the device's own
     * draw can otherwise make the charge current look finished too early. */
    const bool below = mv < VREG_MV;
    set_bits(REG_CTRL0, 0x01, 2, below ? 0 : 1);

    /* Not full and not charging: give charging a fresh start, as the vendor firmware
     * does. Whether USB is in cannot be told apart from "stopped", and toggling it with
     * nothing plugged in does nothing, so just do it, once a minute at most. */
    static int64_t last_kick;
    const int64_t now = esp_timer_get_time();
    if (below && s_status == 0 && ma < 5 && now - last_kick > 60LL * 1000 * 1000) {
        last_kick = now;
        ESP_LOGD(TAG, "not charging at %d mV: restarting", mv);
        set_bits(REG_CTRL1, 0x01, 5, 0);
        set_bits(REG_CTRL1, 0x01, 4, 0);
        vTaskDelay(pdMS_TO_TICKS(200));
        set_bits(REG_CTRL1, 0x01, 5, 1);
    }
    return false;
}
