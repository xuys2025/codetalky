# Monocypher 4.0.2

`monocypher.c`、`monocypher.h` 和 `LICENCE.md` 原样取自 Monocypher 4.0.2 的发布包（<https://monocypher.org/download/monocypher-4.0.2.tar.gz>，和 GitHub 发布页上的同名文件一致，SHA-256 `38d07179738c0c90677dba3ceb7a7b8496bcfea758ba1a53e803fed30ae0879c`）。授权：CC0 或 2 条款 BSD，任选。

设备端用它做配对和加密连接：X25519（配对时交换密钥）、BLAKE2b（派生密钥和配对码）、ChaCha20-Poly1305（每条消息加密，用 `crypto_aead_init_ietf`，和 RFC 8439 一致，电脑端用 Node 自带的实现）。用法见 `ui/src/ct_secure.c`。
