#include "ct_arena.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define CHUNK_MIN 4096
#define ALIGN 8

typedef struct chunk {
    struct chunk *next;
    size_t used;
    size_t size;
    /* data follows, ALIGN-aligned */
} chunk_t;

struct ct_arena {
    chunk_t *head;
    bool failed;
};

#define CHUNK_HEADER ((sizeof(chunk_t) + ALIGN - 1) & ~(size_t)(ALIGN - 1))

ct_arena_t *ct_arena_new(void) {
    return calloc(1, sizeof(ct_arena_t));
}

void ct_arena_free(ct_arena_t *arena) {
    if (arena == NULL) {
        return;
    }
    chunk_t *c = arena->head;
    while (c != NULL) {
        chunk_t *next = c->next;
        free(c);
        c = next;
    }
    free(arena);
}

void *ct_arena_alloc(ct_arena_t *arena, size_t size) {
    size = (size + ALIGN - 1) & ~(size_t)(ALIGN - 1);
    if (size == 0) {
        size = ALIGN;
    }
    chunk_t *c = arena->head;
    if (c == NULL || c->size - c->used < size) {
        const size_t want = size > CHUNK_MIN ? size : CHUNK_MIN;
        c = malloc(CHUNK_HEADER + want);
        if (c == NULL) {
            arena->failed = true;
            return NULL;
        }
        c->next = arena->head;
        c->used = 0;
        c->size = want;
        arena->head = c;
    }
    uint8_t *p = (uint8_t *)c + CHUNK_HEADER + c->used;
    c->used += size;
    memset(p, 0, size);
    return p;
}

const char *ct_arena_str(ct_arena_t *arena, const char *s, size_t max_bytes) {
    size_t n = strlen(s);
    if (n > max_bytes) {
        n = max_bytes;
        /* Step back over UTF-8 continuation bytes so the cut lands on a character. */
        while (n > 0 && ((uint8_t)s[n] & 0xC0) == 0x80) {
            n--;
        }
    }
    char *out = ct_arena_alloc(arena, n + 1);
    if (out == NULL) {
        return "";
    }
    memcpy(out, s, n);
    out[n] = '\0';
    return out;
}

bool ct_arena_failed(const ct_arena_t *arena) {
    return arena->failed;
}
