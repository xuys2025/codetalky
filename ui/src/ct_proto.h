/*
 * Device side of the bridge protocol (docs/PROTOCOL.md): turns incoming JSON
 * frames into model updates and builds the frames for the user's actions.
 * The bridge side is bridge/src/protocol.ts; change both together.
 *
 * The device talks to one bridge per computer at the same time. Each connection
 * is a link, numbered 0 .. CT_MAX_LINKS-1 by the platform code.
 */
#ifndef CT_PROTO_H
#define CT_PROTO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CT_PROTO_VERSION 1

typedef enum {
    CT_ACK_OK = 0,
    CT_ACK_GONE,        /* the session no longer exists */
    CT_ACK_STALE,       /* the request on screen is no longer the pending one */
    CT_ACK_UNSUPPORTED, /* this session can't take that from the device */
    CT_ACK_BAD,         /* the bridge rejected the content */
    CT_ACK_TIMEOUT,     /* no answer in time (set by the UI) */
    CT_ACK_OFFLINE,     /* the link dropped before the answer (set by the UI) */
} ct_ack_t;

typedef enum {
    CT_EV_NONE = 0,
    CT_EV_HELLO,     /* the bridge greeted us; a full resync follows */
    CT_EV_CHANGED,   /* a session was added, replaced or removed */
    CT_EV_READY,     /* resync finished */
    CT_EV_ACK,       /* answer to one of our actions */
    CT_EV_BAD_PROTO, /* the bridge speaks another protocol version */
    CT_EV_PAIRING,   /* this computer's pairing stage changed: show it (ct_proto_pair_stage) */
} ct_event_type_t;

typedef struct {
    ct_event_type_t type;
    uint32_t seq; /* CT_EV_ACK */
    ct_ack_t ack; /* CT_EV_ACK */
} ct_event_t;

/* A link came up (we say hello) or went down. */
void ct_proto_link(int link, bool up);
/* Connected and greeted by its bridge. */
bool ct_proto_link_up(int link);

/* Handle one text frame from the bridge on a link. */
ct_event_t ct_proto_receive(int link, const char *json, size_t len);

/* Pairing. A computer on the network asks the device to prove it holds the key they
 * paired with; without one the device asks to pair. Once the user runs
 * `codetalky pair` on that computer, the device shows a six-digit code both sides
 * compute (ct_secure.h), which the user types there. When the computer says it
 * paired, the user confirms on the device too; only then is the key kept. After that
 * the link is encrypted. A computer refusing a kept key never erases it by itself:
 * the user decides (it may be someone posing as that computer). */
typedef enum {
    CT_PAIR_NONE = 0,
    CT_PAIR_WAITING, /* asked to pair; waiting for the user to run `codetalky pair` there */
    CT_PAIR_CODE,    /* showing the code to type on the computer */
    CT_PAIR_CONFIRM, /* the computer says it paired: the user confirms here */
    CT_PAIR_REFUSED, /* the computer doesn't accept the key kept for it */
} ct_pair_stage_t;

ct_pair_stage_t ct_proto_pair_stage(int link);
bool ct_proto_pairing(int link);          /* any stage but NONE */
const char *ct_proto_pair_code(int link); /* "482159" in CT_PAIR_CODE */
const char *ct_proto_pair_host(int link); /* that computer's name */
void ct_proto_pair_again(int link);       /* new exchange, new code (the old one expires) */
/* CT_PAIR_CONFIRM: yes keeps the key and goes on; no drops it and the connection. */
void ct_proto_pair_confirm(int link, bool yes);
/* CT_PAIR_REFUSED: forget the key kept for this computer and pair again. */
void ct_proto_pair_reset(int link);

/* Send an action to the bridge a session is on. Returns its seq, or 0 if it could
 * not be sent. Seqs are unique across links. */
uint32_t ct_proto_approve(int link, const char *id, const char *req, bool allow);
/* A plan not approved, with what to change (text may be NULL). */
uint32_t ct_proto_send_back(int link, const char *id, const char *req, const char *text);
uint32_t ct_proto_answer(int link, const char *id, const char *req, int option);
/* A multi-select question: the options picked. */
uint32_t ct_proto_answer_many(int link, const char *id, const char *req, const int *options, int count);
/* A question answered in the user's own words. */
uint32_t ct_proto_answer_text(int link, const char *id, const char *req, const char *text);
uint32_t ct_proto_reply(int link, const char *id, const char *text);
uint32_t ct_proto_seen(int link, const char *id);

#endif /* CT_PROTO_H */
