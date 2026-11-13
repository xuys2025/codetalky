/*
 * Pairing and the encrypted link, device side (docs/PROTOCOL.md, 配对). Built on
 * Monocypher (third_party/monocypher). The bridge side is bridge/src/secure.ts:
 * every derivation here must match it byte for byte.
 */
#ifndef CT_SECURE_H
#define CT_SECURE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CT_KEY_BYTES 32
#define CT_NONCE_BYTES 16

/* Random bytes from the platform (ct_hal_random). */
void ct_random(uint8_t *out, size_t n);

/* A one-off X25519 key pair. */
void ct_keypair(uint8_t secret[CT_KEY_BYTES], uint8_t pub[CT_KEY_BYTES]);
/* The shared secret; false if their key makes it all zeros. */
bool ct_shared(uint8_t out[CT_KEY_BYTES], const uint8_t secret[CT_KEY_BYTES], const uint8_t their_pub[CT_KEY_BYTES]);

void ct_commit(uint8_t out[CT_KEY_BYTES], const uint8_t r[CT_NONCE_BYTES]);
/* Six digits and a terminator. */
void ct_pair_code(char out[7], const uint8_t device_pub[32], const uint8_t bridge_pub[32], const uint8_t device_r[16], const uint8_t bridge_r[16]);
void ct_pair_key(uint8_t out[CT_KEY_BYTES], const uint8_t shared[32], const uint8_t device_pub[32], const uint8_t bridge_pub[32],
                 const uint8_t device_r[16], const uint8_t bridge_r[16]);
void ct_proof(uint8_t out[CT_KEY_BYTES], const uint8_t key[32], const char *device_id, const char *host_id, const uint8_t bridge_nonce[16],
              const uint8_t device_nonce[16]);
void ct_link_keys(uint8_t to_bridge[CT_KEY_BYTES], uint8_t to_device[CT_KEY_BYTES], const uint8_t key[32], const uint8_t bridge_nonce[16],
                  const uint8_t device_nonce[16]);

/* One frame: "E" + base64(tag || ChaCha20-Poly1305 ciphertext), nonce = counter.
 * Returns a malloc'd, terminated string (free it), or NULL if out of memory. */
char *ct_seal(const uint8_t key[CT_KEY_BYTES], uint64_t counter, const char *text, size_t len);
/* The text of a frame (without its leading "E"), malloc'd and terminated, or NULL if
 * it isn't genuine for this key and counter. */
char *ct_open(const uint8_t key[CT_KEY_BYTES], uint64_t counter, const char *b64, size_t len, size_t *out_len);

/* Lowercase hex of n bytes into out (2n + 1 chars). */
void ct_hex(char *out, const uint8_t *bytes, size_t n);
/* Exactly n bytes of hex; false otherwise. */
bool ct_unhex(uint8_t *out, size_t n, const char *hex);

/* Overwrite secrets before letting go of them. */
void ct_wipe(void *p, size_t n);

#endif /* CT_SECURE_H */
