/*
 * What the device knows about agent sessions, as last sent by the bridge
 * (see docs/PROTOCOL.md). Each session is replaced whole when a new snapshot
 * arrives, so never keep a pointer into one across calls into the UI loop:
 * look sessions up by id each time.
 */
#ifndef CT_MODEL_H
#define CT_MODEL_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define CT_MAX_SESSIONS 16
#define CT_ID_MAX 48  /* bytes with the terminator; the bridge keeps ids to 47 */
#define CT_REQ_MAX 64 /* bytes with the terminator */
#define CT_MAX_QUICK 8

typedef enum {
    CT_STATE_IDLE = 0,
    CT_STATE_RUNNING,
    CT_STATE_WAIT_APPROVE, /* blocked on a permission request */
    CT_STATE_WAIT_ANSWER,  /* blocked on a question */
    CT_STATE_DONE,
    CT_STATE_ERROR,
} ct_state_t;

/* One step the agent took. */
typedef struct {
    int64_t at; /* Unix seconds */
    const char *verb;
    const char *target;
    const char *res; /* short result when there is no line count, or NULL */
    int add, del;
    bool has_stat; /* add/del were given */
    bool bad;
} ct_log_t;

typedef struct {
    char st; /* 'M', 'A' or 'D' */
    const char *path;
    int add, del;
} ct_file_t;

typedef struct {
    const char *file;
    int line, add, del;
    const char *const *lines; /* each starts with ' ', '+' or '-' */
    int line_count;
} ct_hunk_t;

typedef struct {
    const char *label;
    const char *desc; /* or NULL */
} ct_option_t;

/* One paragraph of the agent's final message. */
typedef struct {
    bool bullet;
    const char *lead; /* bold lead-in, or NULL */
    const char *text;
} ct_para_t;

typedef enum { CT_ASK_NONE = 0, CT_ASK_APPROVE, CT_ASK_QUESTION } ct_ask_kind_t;

typedef struct {
    ct_ask_kind_t kind;
    const char *req; /* must be sent back with the answer */

    /* approve */
    const char *verb, *target;
    int add, del;
    bool has_stat;
    int line;
    const char *const *lines;
    int line_count;
    const char *why;
    int64_t until; /* 0 = no deadline */
    bool risky;    /* approve needs a long press */

    /* question */
    const char *text, *note;
    const ct_option_t *options;
    int option_count;
} ct_ask_t;

typedef struct {
    char id[CT_ID_MAX];
    const char *name, *agent, *model;
    const char *branch; /* or NULL */
    ct_state_t state;
    int64_t since;   /* entered the current state */
    int64_t started; /* this round of work began */
    bool reply;      /* the device may send it instructions */

    struct {
        const char *verb, *target; /* verb is NULL when nothing is going on */
        int add, del;
        bool has_stat;
    } now;
    const char *say; /* what it said last, or NULL */
    struct {
        int read, edit, created, cmd, add, del;
    } n;
    int ctx; /* context used, percent; -1 when unknown */

    const char *const *todos;
    int todo_count, todo_done;
    const ct_log_t *log; /* newest first */
    int log_count;
    const ct_file_t *files;
    int file_count;
    const ct_hunk_t *hunks;
    int hunk_count, hunk_total;
    ct_ask_t ask;
    const ct_para_t *report;
    int report_count;
    const char *err; /* or NULL */

    uint32_t rev; /* changes with every new snapshot */
    bool stale;   /* not re-sent since the bridge last said hello */
    void *mem;    /* owns everything above */
} ct_session_t;

/* Sessions in display order: waiting for you, then errors, finished, running, idle. */
int ct_model_count(void);
const ct_session_t *ct_model_at(int index);
const ct_session_t *ct_model_find(const char *id);
/* Changes whenever any session is added, replaced or removed. */
uint32_t ct_model_rev(void);

/* For the protocol layer. ct_model_put takes ownership of s and of s->mem. */
void ct_model_put(ct_session_t *s);
void ct_model_remove(const char *id);
void ct_model_mark_stale(void);
void ct_model_purge_stale(void);
void ct_session_free(ct_session_t *s);

/* Replies the user can send with one tap. */
int ct_model_quick_count(void);
const char *ct_model_quick(int index);
void ct_model_set_quick(const char *const *texts, int count);

/* Wall clock, set from the bridge. ct_model_now() is 0 until then. */
void ct_model_set_time(int64_t unix_seconds, int tz_minutes);
int64_t ct_model_now(void);
int ct_model_tz_minutes(void);

#ifdef __cplusplus
}
#endif

#endif /* CT_MODEL_H */
