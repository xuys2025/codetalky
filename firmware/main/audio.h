/*
 * The microphone.
 *
 * It sits behind the board's Bluetooth audio chip, which is controlled with AT
 * commands over a UART and, once in its mode 1, is the I2S master: it clocks 16 kHz
 * stereo frames (32-bit slots) to the ESP32, the microphone in the left slot. Taken
 * from the vendor firmware (boards/common/audio/bt_audio_codec.cc and
 * display/screen/bluetooth_screen/bluetooth_uart.cc).
 */
#ifndef AUDIO_H
#define AUDIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define AUDIO_RATE 16000
#define AUDIO_CHUNK_SAMPLES 800 /* 50 ms per chunk */

/* Called from the capture task with each chunk of 16-bit mono samples. */
typedef void (*audio_sink_t)(const int16_t *pcm, size_t samples);

/* UART and I2S set up, the audio chip switched to mode 1 in the background. */
void audio_init(audio_sink_t sink);

/* Start or stop capturing. Any task. */
bool audio_start(void);
void audio_stop(void);

#endif /* AUDIO_H */
