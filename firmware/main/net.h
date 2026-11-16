/*
 * Wi-Fi and the links to the computers' bridges.
 *
 * Wi-Fi uses the networks the vendor firmware saved in NVS (namespace "wifi",
 * keys ssid/password, ssid1/password1, ...). Computers are found by a UDP
 * broadcast: every bridge on the network answers with its address and id, and the
 * device keeps one WebSocket per computer (ws://<ip>:<port>/device), up to
 * CT_MAX_LINKS. Link numbers stay with a computer (by its hostId) until reboot.
 */
#ifndef NET_H
#define NET_H

#include <stdbool.h>

void net_init(void);

/* Send one text frame on a link; false if that link is not connected. Any task. */
bool net_send(int link, const char *json);

/* Drop a link's connection now; it reconnects a little later. Any task. */
void net_close(int link);

#endif /* NET_H */
