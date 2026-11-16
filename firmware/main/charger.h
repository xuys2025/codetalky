/*
 * CX25601N battery charger. Without setting up, it can sit idle with USB plugged in
 * (seen 2026-11-16: the battery drained while connected to the PC).
 */
#ifndef CHARGER_H
#define CHARGER_H

#include <stdbool.h>

#include "driver/i2c_master.h"

/* Probe and apply the vendor firmware's charging settings. */
void charger_init(i2c_master_bus_handle_t bus);

/* Call every ~10 s with a fuel gauge reading (current > 0 while charging): restarts
 * charging that stopped short. Returns true once the battery is nearly empty with
 * nothing plugged in: show something, then call charger_battery_off(). */
bool charger_tick(int battery_mv, int battery_ma);

/* Disconnect the battery to protect it (the device goes dark; plugging in USB
 * brings it back). */
void charger_battery_off(void);

/* Measuring the device's own draw with USB in: the charger stops taking power from
 * USB (high impedance), so the device runs on the battery and the fuel gauge reads
 * its consumption. Charging logic pauses meanwhile. */
void charger_run_on_battery(bool on);

/* Last status read: 0 not charging, 1 pre/fast charge, 2 constant voltage, 3 top-off;
 * -1 unknown. usb: true while USB power is present. */
int charger_status(bool *usb);

#endif /* CHARGER_H */
