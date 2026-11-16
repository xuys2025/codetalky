// Speech from the device: it streams what the microphone hears while the talk key is
// held (16 kHz mono 16-bit), and gets back the words. Recognition itself is behind
// the Recognizer interface: Doubao's cloud service once credentials are set, until
// then a placeholder that only says how long the recording was.

export const VOICE_RATE = 16000;

/** One recording being recognised; samples arrive while the user is still talking. */
export interface Recognition {
  push(pcm: Buffer): void;
  /** All samples are in: the words (empty if nothing was said). */
  finish(): Promise<string>;
  cancel(): void;
}

export interface Recognizer {
  /** For the log, e.g. "doubao". */
  readonly name: string;
  start(): Recognition;
}

/** Stands in until a real recognizer is configured. */
export class Placeholder implements Recognizer {
  readonly name = 'placeholder';
  start(): Recognition {
    let bytes = 0;
    return {
      push: (pcm) => {
        bytes += pcm.length;
      },
      finish: () => Promise.resolve(`（还没接豆包：录到 ${(bytes / 2 / VOICE_RATE).toFixed(1)} 秒声音）`),
      cancel: () => {},
    };
  }
}

/** A WAV file of 16-bit mono samples. */
export function wav(pcm: Buffer, rate = VOICE_RATE): Buffer {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16); // fmt chunk size
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); // bytes per second
  head.writeUInt16LE(2, 32); // bytes per frame
  head.writeUInt16LE(16, 34); // bits per sample
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

/** Loudness of 16-bit samples: RMS and peak, for the log. */
export function level(pcm: Buffer): { rms: number; peak: number } {
  let sum = 0;
  let peak = 0;
  const n = Math.floor(pcm.length / 2);
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  return { rms: n > 0 ? Math.round(Math.sqrt(sum / n)) : 0, peak };
}
