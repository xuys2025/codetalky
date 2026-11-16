/*
 * Wi-Fi, bridge discovery and the WebSocket links. See net.h.
 */
#include "net.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

#include "app.h"
#include "cJSON.h"
#include "ct_model.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "nvs.h"

static const char *TAG = "net";

#define DISCOVERY_PORT_FIRST 8137
#define DISCOVERY_PORTS 4 /* bridges on 8137..8140 */
#define FIND_FAST_MS 3000  /* while a computer is missing */
#define FIND_SLOW_MS 30000 /* all known computers connected: still look for new ones */
#define MAX_FRAME (256 * 1024)
#define MAX_NETWORKS 10
/* A computer that answers discovery while its link has been down this long gets a
 * fresh connection, whatever state the WebSocket client is in. */
#define STALE_LINK_MS 10000

#define GOT_IP BIT0

typedef struct {
    bool used;
    char host_id[80];
    char uri[64];
    esp_websocket_client_handle_t ws;
    volatile bool up;
    volatile int64_t down_since; /* ms; when it last went down or was restarted */
    char *rx; /* frame being assembled (websocket task only) */
    size_t rx_cap;
} link_t;

typedef struct {
    char ssid[33];
    char password[65];
} network_t;

static link_t s_links[CT_MAX_LINKS];
static EventGroupHandle_t s_events;
static QueueHandle_t s_cmds; /* link numbers to drop and reconnect */
static network_t s_networks[MAX_NETWORKS];
static int s_network_count;
static int s_network;  /* the one being tried */
static int s_failures; /* in a row on it */

/* ---------- Wi-Fi ---------- */

static void load_networks(void) {
    nvs_handle_t h;
    if (nvs_open("wifi", NVS_READONLY, &h) != ESP_OK) {
        return;
    }
    for (int i = 0; i < MAX_NETWORKS; i++) {
        char ssid_key[12], pass_key[12];
        snprintf(ssid_key, sizeof(ssid_key), i == 0 ? "ssid" : "ssid%d", i);
        snprintf(pass_key, sizeof(pass_key), i == 0 ? "password" : "password%d", i);
        network_t *n = &s_networks[s_network_count];
        size_t len = sizeof(n->ssid);
        if (nvs_get_str(h, ssid_key, n->ssid, &len) != ESP_OK || n->ssid[0] == '\0') {
            continue;
        }
        len = sizeof(n->password);
        if (nvs_get_str(h, pass_key, n->password, &len) != ESP_OK) {
            n->password[0] = '\0';
        }
        s_network_count++;
    }
    nvs_close(h);
}

static void wifi_join(void) {
    if (s_network_count == 0) {
        return;
    }
    const network_t *n = &s_networks[s_network];
    wifi_config_t cfg = {0};
    memcpy(cfg.sta.ssid, n->ssid, sizeof(cfg.sta.ssid));
    memcpy(cfg.sta.password, n->password, sizeof(cfg.sta.password));
    cfg.sta.threshold.authmode = n->password[0] ? WIFI_AUTH_WPA_PSK : WIFI_AUTH_OPEN;
    cfg.sta.pmf_cfg.capable = true;
    esp_wifi_set_config(WIFI_IF_STA, &cfg);
    ESP_LOGI(TAG, "joining \"%s\"", n->ssid);
    esp_wifi_connect();
}

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        wifi_join();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *d = data;
        xEventGroupClearBits(s_events, GOT_IP);
        ESP_LOGW(TAG, "Wi-Fi lost (reason %d)", d->reason);
        /* After a few failures on one saved network, try the next. */
        if (++s_failures >= 3 && s_network_count > 1) {
            s_failures = 0;
            s_network = (s_network + 1) % s_network_count;
        }
        /* The event loop must not block for long; a short pause avoids a busy loop. */
        vTaskDelay(pdMS_TO_TICKS(s_failures == 0 ? 200 : 1000));
        wifi_join();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *e = data;
        s_failures = 0;
        ESP_LOGI(TAG, "got " IPSTR, IP2STR(&e->ip_info.ip));
        xEventGroupSetBits(s_events, GOT_IP);
    }
}

static void wifi_start(void) {
    esp_netif_init();
    esp_event_loop_create_default();
    esp_netif_t *sta = esp_netif_create_default_wifi_sta();
    esp_netif_set_hostname(sta, "codetalky");
    const wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init));
    esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi_event, NULL);
    esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi_event, NULL);
    esp_wifi_set_storage(WIFI_STORAGE_RAM);
    esp_wifi_set_mode(WIFI_MODE_STA);
    ESP_ERROR_CHECK(esp_wifi_start());
    /* Replies to taps should not wait for the next beacon. Battery tuning comes later. */
    esp_wifi_set_ps(WIFI_PS_NONE);
}

/* ---------- links ---------- */

static int link_of(esp_websocket_client_handle_t ws) {
    for (int i = 0; i < CT_MAX_LINKS; i++) {
        if (s_links[i].ws == ws) return i;
    }
    return -1;
}

static void set_up(int i, bool up) {
    if (s_links[i].up == up) {
        return;
    }
    s_links[i].up = up;
    if (!up) {
        s_links[i].down_since = esp_timer_get_time() / 1000;
    }
    ESP_LOGI(TAG, "link %d %s (%s)", i, up ? "up" : "down", s_links[i].uri);
    const app_event_t ev = {.type = APP_EV_LINK, .a = i, .b = up};
    app_post(&ev);
}

static void on_ws_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    const esp_websocket_event_data_t *d = data;
    const int i = link_of(d->client);
    if (i < 0) {
        return;
    }
    link_t *l = &s_links[i];
    switch (id) {
    case WEBSOCKET_EVENT_CONNECTED:
        set_up(i, true);
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED:
        set_up(i, false);
        break;
    case WEBSOCKET_EVENT_DATA: {
        if (d->op_code != 0x1 && d->op_code != 0x0) {
            break; /* binary, ping, pong, close */
        }
        const size_t total = (size_t)d->payload_len;
        const size_t offset = (size_t)d->payload_offset;
        if (total == 0 || total > MAX_FRAME || offset + (size_t)d->data_len > total) {
            break;
        }
        if (offset == 0 && l->rx_cap < total + 1) {
            free(l->rx);
            l->rx = heap_caps_malloc(total + 1, MALLOC_CAP_SPIRAM);
            l->rx_cap = l->rx != NULL ? total + 1 : 0;
        }
        if (l->rx == NULL || l->rx_cap < total + 1) {
            break;
        }
        memcpy(l->rx + offset, d->data_ptr, (size_t)d->data_len);
        if (offset + (size_t)d->data_len == total) {
            char *copy = heap_caps_malloc(total + 1, MALLOC_CAP_SPIRAM);
            if (copy != NULL) {
                memcpy(copy, l->rx, total);
                copy[total] = '\0';
                const app_event_t ev = {.type = APP_EV_MSG, .a = i, .text = copy, .len = total};
                app_post(&ev);
            }
        }
        break;
    }
    default:
        break;
    }
}

static void link_start(int i, const char *uri) {
    link_t *l = &s_links[i];
    snprintf(l->uri, sizeof(l->uri), "%s", uri);
    const esp_websocket_client_config_t cfg = {
        .uri = l->uri,
        .task_stack = 6144,
        .task_prio = 5,
        .buffer_size = 4096,
        .reconnect_timeout_ms = 2000,
        .network_timeout_ms = 5000,
        .ping_interval_sec = 10,
        .pingpong_timeout_sec = 25,
        /* The bridge closes cleanly too (e.g. pairing not finished in time): reconnect anyway. */
        .enable_close_reconnect = true,
    };
    if (l->ws == NULL) {
        l->ws = esp_websocket_client_init(&cfg);
        if (l->ws == NULL) {
            ESP_LOGE(TAG, "websocket init failed");
            return;
        }
        esp_websocket_register_events(l->ws, WEBSOCKET_EVENT_ANY, on_ws_event, NULL);
    } else {
        esp_websocket_client_set_uri(l->ws, l->uri);
    }
    l->down_since = esp_timer_get_time() / 1000;
    esp_websocket_client_start(l->ws);
}

static void link_stop(int i) {
    link_t *l = &s_links[i];
    if (l->ws != NULL && esp_websocket_client_is_connected(l->ws)) {
        esp_websocket_client_close(l->ws, pdMS_TO_TICKS(500));
    }
    if (l->ws != NULL) {
        esp_websocket_client_stop(l->ws);
    }
    set_up(i, false);
}

bool net_send(int link, const char *json) {
    if (link < 0 || link >= CT_MAX_LINKS || !s_links[link].up || s_links[link].ws == NULL) {
        return false;
    }
    return esp_websocket_client_send_text(s_links[link].ws, json, (int)strlen(json), pdMS_TO_TICKS(2000)) >= 0;
}

void net_close(int link) {
    if (link >= 0 && link < CT_MAX_LINKS && s_cmds != NULL) {
        xQueueSend(s_cmds, &link, 0);
    }
}

/* ---------- discovery ---------- */

static void on_here(const char *text, const struct sockaddr_in *from) {
    cJSON *msg = cJSON_Parse(text);
    if (msg == NULL) {
        return;
    }
    const cJSON *t = cJSON_GetObjectItemCaseSensitive(msg, "t");
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(msg, "hostId");
    const cJSON *port = cJSON_GetObjectItemCaseSensitive(msg, "port");
    if (!cJSON_IsString(t) || strcmp(t->valuestring, "here") != 0 || !cJSON_IsString(id) || !cJSON_IsNumber(port) ||
        port->valueint <= 0 || port->valueint > 65535) {
        cJSON_Delete(msg);
        return;
    }
    char ip[16], uri[64];
    inet_ntoa_r(from->sin_addr, ip, sizeof(ip));
    snprintf(uri, sizeof(uri), "ws://%s:%d/device", ip, port->valueint);

    int slot = -1, free_slot = -1;
    for (int i = 0; i < CT_MAX_LINKS; i++) {
        if (s_links[i].used && strcmp(s_links[i].host_id, id->valuestring) == 0) {
            slot = i;
        } else if (!s_links[i].used && free_slot < 0) {
            free_slot = i;
        }
    }
    if (slot >= 0) {
        /* Known computer whose link is down: follow it if its address changed, and
         * start over if the link has not come back on its own for a while. */
        link_t *l = &s_links[slot];
        const bool moved = strcmp(l->uri, uri) != 0;
        const bool stale = esp_timer_get_time() / 1000 - l->down_since > STALE_LINK_MS;
        if (!l->up && (moved || stale)) {
            ESP_LOGI(TAG, "link %d: %s, reconnecting to %s", slot, moved ? "computer moved" : "still down", uri);
            link_stop(slot);
            link_start(slot, uri);
        }
    } else if (free_slot >= 0) {
        link_t *l = &s_links[free_slot];
        l->used = true;
        snprintf(l->host_id, sizeof(l->host_id), "%s", id->valuestring);
        ESP_LOGI(TAG, "found computer %s at %s: link %d", l->host_id, uri, free_slot);
        link_start(free_slot, uri);
    }
    cJSON_Delete(msg);
}

static void send_find(int sock) {
    static const char FIND[] = "{\"t\":\"find\",\"proto\":1}";
    esp_netif_ip_info_t info;
    esp_netif_t *sta = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    uint32_t subnet_bcast = 0;
    if (sta != NULL && esp_netif_get_ip_info(sta, &info) == ESP_OK) {
        subnet_bcast = info.ip.addr | ~info.netmask.addr;
    }
    for (int p = 0; p < DISCOVERY_PORTS; p++) {
        struct sockaddr_in to = {.sin_family = AF_INET, .sin_port = htons(DISCOVERY_PORT_FIRST + p)};
        to.sin_addr.s_addr = htonl(INADDR_BROADCAST);
        sendto(sock, FIND, sizeof(FIND) - 1, 0, (struct sockaddr *)&to, sizeof(to));
        if (subnet_bcast != 0) {
            to.sin_addr.s_addr = subnet_bcast;
            sendto(sock, FIND, sizeof(FIND) - 1, 0, (struct sockaddr *)&to, sizeof(to));
        }
    }
}

static bool all_links_up(void) {
    bool any = false;
    for (int i = 0; i < CT_MAX_LINKS; i++) {
        if (s_links[i].used) {
            any = true;
            if (!s_links[i].up) return false;
        }
    }
    return any;
}

static void net_task(void *arg) {
    (void)arg;
    int sock = -1;
    int64_t next_find = 0;
    for (;;) {
        int drop;
        while (xQueueReceive(s_cmds, &drop, 0) == pdTRUE) {
            if (s_links[drop].used) {
                ESP_LOGW(TAG, "dropping link %d on request", drop);
                link_stop(drop);
                vTaskDelay(pdMS_TO_TICKS(2000));
                link_start(drop, s_links[drop].uri);
            }
        }
        if ((xEventGroupWaitBits(s_events, GOT_IP, pdFALSE, pdTRUE, pdMS_TO_TICKS(1000)) & GOT_IP) == 0) {
            continue;
        }
        if (sock < 0) {
            sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
            const int yes = 1;
            setsockopt(sock, SOL_SOCKET, SO_BROADCAST, &yes, sizeof(yes));
            const struct timeval tv = {.tv_sec = 0, .tv_usec = 500 * 1000};
            setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
            struct sockaddr_in any = {.sin_family = AF_INET, .sin_port = 0, .sin_addr.s_addr = htonl(INADDR_ANY)};
            bind(sock, (struct sockaddr *)&any, sizeof(any));
        }
        const int64_t now = esp_timer_get_time() / 1000;
        if (now >= next_find) {
            send_find(sock);
            next_find = now + (all_links_up() ? FIND_SLOW_MS : FIND_FAST_MS);
        }
        char buf[512];
        struct sockaddr_in from;
        socklen_t from_len = sizeof(from);
        const int n = recvfrom(sock, buf, sizeof(buf) - 1, 0, (struct sockaddr *)&from, &from_len);
        if (n > 0) {
            buf[n] = '\0';
            on_here(buf, &from);
        } else if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
            close(sock); /* the interface went away; make a new one */
            sock = -1;
        }
    }
}

void net_init(void) {
    s_events = xEventGroupCreate();
    s_cmds = xQueueCreate(8, sizeof(int));
    load_networks();
    if (s_network_count == 0) {
        ESP_LOGE(TAG, "no saved Wi-Fi network");
    } else {
        ESP_LOGI(TAG, "%d saved Wi-Fi network(s), first \"%s\"", s_network_count, s_networks[0].ssid);
    }
    wifi_start();
    xTaskCreatePinnedToCore(net_task, "net", 6144, NULL, 4, NULL, 0);
}
