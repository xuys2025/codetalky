/*
 * A bump allocator: many small allocations, freed all at once. Each session
 * snapshot lives in one arena, so replacing a session is a single free.
 */
#ifndef CT_ARENA_H
#define CT_ARENA_H

#include <stdbool.h>
#include <stddef.h>

typedef struct ct_arena ct_arena_t;

ct_arena_t *ct_arena_new(void);
void ct_arena_free(ct_arena_t *arena);

/* Zeroed, 8-byte aligned. NULL when out of memory; the arena then reports failed. */
void *ct_arena_alloc(ct_arena_t *arena, size_t size);

/* Copy of s, cut to at most max_bytes without splitting a UTF-8 character.
 * Returns "" when out of memory, so callers can keep going. */
const char *ct_arena_str(ct_arena_t *arena, const char *s, size_t max_bytes);

/* True if any allocation failed. */
bool ct_arena_failed(const ct_arena_t *arena);

#endif /* CT_ARENA_H */
