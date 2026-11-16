/*
 * Metalio E-Ink 4 board: pins and the small parts on the I2C bus.
 * Pin numbers come from the vendor firmware (main/boards/metalio-e-ink-4/config.h).
 */
#ifndef BOARD_H
#define BOARD_H

#include <stdbool.h>
#include <stdint.h>

#include "driver/gpio.h"
#include "driver/i2c_master.h"

/* E-ink panel: SSD1677, 800 x 480 landscape; the UI is 480 x 800 portrait. */
#define EPD_SPI_HOST SPI3_HOST
#define EPD_SPI_HZ (10 * 1000 * 1000)
#define EPD_PIN_MOSI GPIO_NUM_8
#define EPD_PIN_SCLK GPIO_NUM_14
#define EPD_PIN_CS GPIO_NUM_45
#define EPD_PIN_DC GPIO_NUM_13
#define EPD_PIN_RST GPIO_NUM_18
#define EPD_PIN_BUSY GPIO_NUM_9

#define I2C_PIN_SDA GPIO_NUM_41
#define I2C_PIN_SCL GPIO_NUM_42

#define TOUCH_PIN_INT GPIO_NUM_1
#define BOOT_KEY_PIN GPIO_NUM_0  /* active low */
#define POWER_KEY_PIN GPIO_NUM_3 /* active low, also wired to the power controller */
#define MOTOR_PIN GPIO_NUM_44    /* active high */

/* TCA9555 port expander, pin index 0..15 = P0.0..P1.7. */
#define XP_USB_MUX 0     /* high: USB goes to the flash/debug port, low: camera */
#define XP_PA_SWITCH 1   /* audio amp source */
#define XP_PA 4          /* audio amp enable */
#define XP_SCREEN_PWR 5  /* e-ink panel socket power */
#define XP_MAIN_PWR 6    /* main power rail: keeps the device on */
#define XP_VOL_DOWN 7    /* input, active low */
#define XP_VOL_UP 8      /* input, active low */
#define XP_TOUCH_RST 9   /* touch controller reset, active low */
#define XP_PWR_PULSE 11  /* pulsing it tells the power controller to switch off */
#define XP_ACCEL_INT 12  /* input */

/* Power rails, I2C bus, port expander, touch reset, motor. Call first. */
void board_init(void);

i2c_master_bus_handle_t board_i2c(void);

/* Port expander inputs as a 16-bit mask (bit n = Pn), or false if the read failed. */
bool board_xp_inputs(uint16_t *levels);

/* One haptic pulse; returns at once. */
void board_vibrate(uint16_t ms);

/* Battery charge from the fuel gauge's voltage, 0..100, or -1 if unknown. Cached;
 * board_battery_poll() refreshes it (call every few seconds from one task). */
int board_battery_percent(void);
void board_battery_poll(void);

/* One fuel gauge reading: battery voltage (mV) and current (mA, negative while the
 * battery is being drained, positive while it charges). False if unavailable. */
bool board_battery_sample(int *mv, int *ma);

/* The gauge's idea of the battery's full capacity in mAh, or -1. */
int board_battery_capacity(void);

/* Switch the device off (does not return). */
void board_power_off(void);

#endif /* BOARD_H */
