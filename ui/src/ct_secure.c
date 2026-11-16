#include "ct_secure.h"

#include <stdlib.h>
#include <string.h>

#include "ct_hal.h"
#include "monocypher.h"

void ct_random(uint8_t *out, size_t n) {
    while (n > 0) {
        uint32_t r = ct_hal_random();
        const size_t take = n < 4 ? n : 4;
        memcpy(out, &r, take);
        out += take;
        n -= take;
    }
}

void ct_wipe(void *p, size_t n) {
    crypto_wipe(p, n);
}

void ct_keypair(uint8_t secret[CT_KEY_BYTES], uint8_t pub[CT_KEY_BYTES]) {
    ct_random(secret, CT_KEY_BYTES);
    crypto_x25519_public_key(pub, secret);
}

bool ct_shared(uint8_t out[CT_KEY_BYTES], const uint8_t secret[CT_KEY_BYTES], const uint8_t their_pub[CT_KEY_BYTES]) {
    crypto_x25519(out, secret, their_pub);
    uint8_t any = 0;
    for (int i = 0; i < CT_KEY_BYTES; i++) any |= out[i];
    return any != 0;
}

/* ---------- derivations (bridge/src/secure.ts derive()) ---------- */

typedef struct {
    const void *p;
    size_t n;
    bool prefixed; /* a variable-length string: its length goes first */
} part_t;

/* BLAKE2b-512 of the length-prefixed label and the parts, cut to out_size. */
static void derive(uint8_t *out, size_t out_size, const char *label, const part_t *parts, int count) {
    crypto_blake2b_ctx ctx;
    crypto_blake2b_init(&ctx, 64);
    const size_t label_len = strlen(label);
    const uint8_t len = (uint8_t)(label_len > 255 ? 255 : label_len);
    crypto_blake2b_update(&ctx, &len, 1);
    crypto_blake2b_update(&ctx, (const uint8_t *)label, len);
    for (int i = 0; i < count; i++) {
        size_t n = parts[i].n;
        if (parts[i].prefixed) {
            if (n > 255) n = 255;
            const uint8_t l = (uint8_t)n;
            crypto_blake2b_update(&ctx, &l, 1);
        }
        crypto_blake2b_update(&ctx, parts[i].p, n);
    }
    uint8_t hash[64];
    crypto_blake2b_final(&ctx, hash);
    memcpy(out, hash, out_size);
    crypto_wipe(hash, sizeof(hash));
}

void ct_commit(uint8_t out[CT_KEY_BYTES], const uint8_t r[CT_NONCE_BYTES]) {
    const part_t parts[] = {{r, CT_NONCE_BYTES, false}};
    derive(out, CT_KEY_BYTES, "codetalky commit", parts, 1);
}

void ct_pair_code(char out[7], const uint8_t device_pub[32], const uint8_t bridge_pub[32], const uint8_t device_r[16], const uint8_t bridge_r[16]) {
    const part_t parts[] = {{device_pub, 32, false}, {bridge_pub, 32, false}, {device_r, 16, false}, {bridge_r, 16, false}};
    uint8_t h[4];
    derive(h, sizeof(h), "codetalky code", parts, 4);
    const uint32_t n = (uint32_t)h[0] | ((uint32_t)h[1] << 8) | ((uint32_t)h[2] << 16) | ((uint32_t)h[3] << 24);
    uint32_t v = n % 1000000u;
    for (int i = 5; i >= 0; i--) {
        out[i] = (char)('0' + v % 10);
        v /= 10;
    }
    out[6] = '\0';
}

void ct_pair_key(uint8_t out[CT_KEY_BYTES], const uint8_t shared[32], const uint8_t device_pub[32], const uint8_t bridge_pub[32],
                 const uint8_t device_r[16], const uint8_t bridge_r[16]) {
    const part_t parts[] = {{shared, 32, false}, {device_pub, 32, false}, {bridge_pub, 32, false}, {device_r, 16, false}, {bridge_r, 16, false}};
    derive(out, CT_KEY_BYTES, "codetalky key", parts, 5);
}

void ct_proof(uint8_t out[CT_KEY_BYTES], const uint8_t key[32], const char *device_id, const char *host_id, const uint8_t bridge_nonce[16],
              const uint8_t device_nonce[16]) {
    const part_t parts[] = {
        {key, 32, false}, {device_id, strlen(device_id), true}, {host_id, strlen(host_id), true}, {bridge_nonce, 16, false}, {device_nonce, 16, false},
    };
    derive(out, CT_KEY_BYTES, "codetalky proof", parts, 5);
}

void ct_link_keys(uint8_t to_bridge[CT_KEY_BYTES], uint8_t to_device[CT_KEY_BYTES], const uint8_t key[32], const uint8_t bridge_nonce[16],
                  const uint8_t device_nonce[16]) {
    const part_t parts[] = {{key, 32, false}, {bridge_nonce, 16, false}, {device_nonce, 16, false}};
    derive(to_bridge, CT_KEY_BYTES, "codetalky device->bridge", parts, 3);
    derive(to_device, CT_KEY_BYTES, "codetalky bridge->device", parts, 3);
}

/* ---------- frames ---------- */

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static int b64_value(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

/* RFC 8439 nonce: the counter, little-endian, then four zero bytes. */
static void nonce_of(uint8_t nonce[12], uint64_t counter) {
    for (int i = 0; i < 8; i++) nonce[i] = (uint8_t)(counter >> (8 * i));
    memset(nonce + 8, 0, 4);
}

size_t ct_b64(char *out, const uint8_t *in, size_t n) {
    char *o = out;
    size_t i = 0;
    for (; i + 2 < n; i += 3) {
        const uint32_t v = ((uint32_t)in[i] << 16) | ((uint32_t)in[i + 1] << 8) | in[i + 2];
        *o++ = B64[(v >> 18) & 63];
        *o++ = B64[(v >> 12) & 63];
        *o++ = B64[(v >> 6) & 63];
        *o++ = B64[v & 63];
    }
    if (i < n) {
        const uint32_t v = ((uint32_t)in[i] << 16) | (i + 1 < n ? (uint32_t)in[i + 1] << 8 : 0);
        *o++ = B64[(v >> 18) & 63];
        *o++ = B64[(v >> 12) & 63];
        *o++ = i + 1 < n ? B64[(v >> 6) & 63] : '=';
        *o++ = '=';
    }
    *o = '\0';
    return (size_t)(o - out);
}

char *ct_seal(const uint8_t key[CT_KEY_BYTES], uint64_t counter, const char *text, size_t len) {
    const size_t raw_len = 16 + len;
    uint8_t *raw = malloc(raw_len);
    char *out = malloc(1 + CT_B64_LEN(raw_len) + 1);
    if (raw == NULL || out == NULL) {
        free(raw);
        free(out);
        return NULL;
    }
    uint8_t nonce[12];
    nonce_of(nonce, counter);
    crypto_aead_ctx ctx;
    crypto_aead_init_ietf(&ctx, key, nonce);
    crypto_aead_write(&ctx, raw + 16, raw, NULL, 0, (const uint8_t *)text, len);
    crypto_wipe(&ctx, sizeof(ctx));

    out[0] = 'E';
    ct_b64(out + 1, raw, raw_len);
    free(raw);
    return out;
}

char *ct_open(const uint8_t key[CT_KEY_BYTES], uint64_t counter, const char *b64, size_t len, size_t *out_len) {
    if (len % 4 != 0 || len < 24) { /* at least the 16-byte tag */
        return NULL;
    }
    size_t raw_len = len / 4 * 3;
    if (b64[len - 1] == '=') raw_len--;
    if (b64[len - 2] == '=') raw_len--;
    uint8_t *raw = malloc(raw_len);
    if (raw == NULL) {
        return NULL;
    }
    size_t o = 0;
    for (size_t i = 0; i < len; i += 4) {
        int v[4];
        for (int k = 0; k < 4; k++) {
            const bool pad = b64[i + k] == '=' && i + 4 == len && k >= 2;
            v[k] = pad ? 0 : b64_value(b64[i + k]);
            if (v[k] < 0) {
                free(raw);
                return NULL;
            }
        }
        const uint32_t n = ((uint32_t)v[0] << 18) | ((uint32_t)v[1] << 12) | ((uint32_t)v[2] << 6) | (uint32_t)v[3];
        const uint8_t bytes[3] = {(uint8_t)(n >> 16), (uint8_t)(n >> 8), (uint8_t)n};
        for (int k = 0; k < 3 && o < raw_len; k++) raw[o++] = bytes[k];
    }
    if (raw_len < 16) {
        free(raw);
        return NULL;
    }
    const size_t text_len = raw_len - 16;
    char *text = malloc(text_len + 1);
    if (text == NULL) {
        free(raw);
        return NULL;
    }
    uint8_t nonce[12];
    nonce_of(nonce, counter);
    crypto_aead_ctx ctx;
    crypto_aead_init_ietf(&ctx, key, nonce);
    const int bad = crypto_aead_read(&ctx, (uint8_t *)text, raw, NULL, 0, raw + 16, text_len);
    crypto_wipe(&ctx, sizeof(ctx));
    free(raw);
    if (bad) {
        free(text);
        return NULL;
    }
    text[text_len] = '\0';
    *out_len = text_len;
    return text;
}

/* ---------- hex ---------- */

void ct_hex(char *out, const uint8_t *bytes, size_t n) {
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) {
        out[2 * i] = digits[bytes[i] >> 4];
        out[2 * i + 1] = digits[bytes[i] & 15];
    }
    out[2 * n] = '\0';
}

static int hex_value(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

bool ct_unhex(uint8_t *out, size_t n, const char *hex) {
    if (hex == NULL || strlen(hex) != 2 * n) {
        return false;
    }
    for (size_t i = 0; i < n; i++) {
        const int hi = hex_value(hex[2 * i]);
        const int lo = hex_value(hex[2 * i + 1]);
        if (hi < 0 || lo < 0) {
            return false;
        }
        out[i] = (uint8_t)(hi << 4 | lo);
    }
    return true;
}
