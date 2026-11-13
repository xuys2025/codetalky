/*
 * What the UI shows about agent sessions. For now the data is a built-in demo set;
 * later the bridge fills the same structures over the network.
 */
#ifndef CT_MODEL_H
#define CT_MODEL_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

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
    const char *time;   /* "14:31" */
    const char *verb;   /* tool name: Edit, Bash, Read ... */
    const char *target; /* file or command */
    const char *result; /* "+18 −7", "通过", "88 行" */
    bool bad;           /* result is a failure */
} ct_activity_t;

typedef struct {
    char status;      /* 'M' modified, 'A' added, 'D' deleted */
    const char *path;
    const char *stat; /* "+54 −28" */
} ct_file_t;

typedef struct {
    char kind; /* ' ' context, '+' added, '-' removed */
    const char *text;
} ct_diff_line_t;

typedef struct {
    const char *label;
    const char *desc;
} ct_option_t;

/* One paragraph of an agent's final message. */
typedef struct {
    bool bullet;
    const char *lead; /* bold lead-in, or NULL */
    const char *text;
} ct_para_t;

typedef struct {
    const char *name;  /* project */
    const char *agent; /* "claude", "codex" */
    const char *model;
    const char *branch;
    ct_state_t state;

    const char *verb;   /* what it is doing or asking for right now */
    const char *target;
    const char *stat;   /* total lines changed, "+86 −21", or NULL */
    const char *counts; /* "读 12 · 改 3" */
    const char *when;   /* "等了 2 分", "8 分 · 任务 3/5" */

    const char *meta_right; /* detail header, right side */
    const char *thinking;   /* the agent's latest message */
    const char *summary;    /* "读 21 · 改 4 · 新 1 · 命令 6" */
    const char *const *todos;
    int todo_count;
    int todo_done;

    const ct_activity_t *activity;
    int activity_count;
    const ct_file_t *files;
    int file_count;
    const char *hunk_title;
    const char *hunk_stat;
    const ct_diff_line_t *hunk;
    int hunk_count;
    int hunk_total;

    const char *reason; /* why it wants the pending change */
    const char *expiry;

    const char *question;
    const char *question_note;
    const ct_option_t *options;
    int option_count;

    const ct_para_t *report;
    int report_count;
} ct_session_t;

int ct_model_session_count(void);
const ct_session_t *ct_model_session(int index);

/* Replies the user can send with one tap. */
int ct_model_quick_reply_count(void);
const char *ct_model_quick_reply(int index);

#ifdef __cplusplus
}
#endif

#endif /* CT_MODEL_H */
