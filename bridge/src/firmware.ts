// Firmware updates over the network. `codetalky firmware [file]` loads an image
// built by firmware/build.sh; the bridge offers it to every connected device that
// can update itself, over the device's encrypted link: where to download it and its
// SHA-256. The device downloads it over plain HTTP from this bridge
// (GET /firmware/<sha256>.bin), checks the hash, installs it and restarts. A wrong
// or swapped file never gets past the hash, and only a paired computer can ask.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface FirmwareImage {
  data: Buffer;
  sha256: string;
  /** Which build this is: the first 10 hex digits of the ELF's SHA-256, which the
   * build writes into the image (esp_app_desc_t.app_elf_sha256) and the running
   * firmware reports in its hello. Differs for every build, unlike the app version. */
  version: string;
  /** Where devices download it. */
  path: string;
}

/** Room for the image in an OTA partition (firmware/partitions.csv: 5 MB). */
export const MAX_IMAGE = 5 * 1024 * 1024;

/** ESP-IDF app image: header magic 0xE9, then the first segment starts with esp_app_desc_t. */
const IMAGE_MAGIC = 0xe9;
const APP_DESC_OFFSET = 24 + 8; // image header, then the first segment's header
const APP_DESC_MAGIC = 0xabcd5432;

function cString(buf: Buffer, start: number, length: number): string {
  const end = buf.indexOf(0, start);
  return buf.toString('utf8', start, end === -1 || end > start + length ? start + length : end);
}

/** Read and check an image. Throws with a message for the user if it isn't one of ours. */
export function readImage(file: string): FirmwareImage {
  const data = readFileSync(file);
  if (data.length < 256 || data.length > MAX_IMAGE) throw new Error(`${file}: not a firmware image (${data.length} bytes)`);
  if (data[0] !== IMAGE_MAGIC || data.readUInt32LE(APP_DESC_OFFSET) !== APP_DESC_MAGIC) {
    throw new Error(`${file}: not an ESP-IDF app image`);
  }
  const project = cString(data, APP_DESC_OFFSET + 48, 32);
  const version = data.toString('hex', APP_DESC_OFFSET + 144, APP_DESC_OFFSET + 149);
  if (project !== 'codetalky') throw new Error(`${file}: built for "${project}", not CodeTalky`);
  const sha256 = createHash('sha256').update(data).digest('hex');
  return { data, sha256, version, path: `/firmware/${sha256}.bin` };
}

/** The image on offer, and who wants to hear about new ones. */
export class FirmwareStore {
  private current: FirmwareImage | null = null;
  /** Each returns true if it told its device. */
  private readonly listeners = new Set<(image: FirmwareImage) => boolean>();

  get image(): FirmwareImage | null {
    return this.current;
  }

  /** Offer an image to every listening device. Returns how many were told. */
  offer(image: FirmwareImage): number {
    this.current = image;
    let told = 0;
    for (const listener of this.listeners) {
      if (listener(image)) told++;
    }
    return told;
  }

  /** Bytes for GET path, or null. Only the image on offer is served. */
  serve(path: string): Buffer | null {
    return this.current && path === this.current.path ? this.current.data : null;
  }

  subscribe(listener: (image: FirmwareImage) => boolean): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
