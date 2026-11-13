// The device's fonts hold about 3,900 characters (common Chinese, ASCII, punctuation;
// list in ui/fonts/charset.txt, written by the font tool). Agents write anything,
// emoji included. Before text goes to the device, symbols it can't draw are swapped
// for ones it can, decoration is dropped, and anything else becomes □ so the user
// can see something was there.

import { readFileSync } from 'node:fs';

const CHARSET = new URL('../../ui/fonts/charset.txt', import.meta.url);

/** Symbols agents like, and the nearest thing the device can draw. */
const SWAPS: Record<string, string> = {
  '✅': '√',
  '✔': '√',
  '☑': '√',
  '✓': '√',
  '❌': '×',
  '✖': '×',
  '✗': '×',
  '❎': '×',
  '⚠': '!',
  '❗': '!',
  '‼': '!!',
  '❓': '?',
  '➡': '→',
  '⬅': '←',
  '⬆': '↑',
  '⬇': '↓',
  '↗': '↑',
  '↘': '↓',
  '🔴': '●',
  '🟢': '●',
  '🟡': '●',
  '🔵': '●',
  '⭕': '○',
  '▪': '·',
  '▫': '·',
  '‧': '·',
  '’': '’',
  ' ': ' ',
  '　': '　',
};

/** Emoji and their joiners: decoration, dropped rather than shown as boxes. */
const DECORATION = /^(\p{Extended_Pictographic}|\p{Emoji_Modifier}|[‍︎️⃣])$/u;

export const MISSING = '□';

export class Glyphs {
  private readonly shown: Set<string> | null;

  /** null: no charset known, pass text through unchanged. */
  constructor(charset: string | null) {
    this.shown = charset === null ? null : new Set([...charset.replace(/\n/g, '')]);
  }

  /** The device's charset from ui/fonts/charset.txt, or pass-through if it isn't there. */
  static load(file: URL | string = CHARSET): Glyphs {
    try {
      return new Glyphs(readFileSync(file, 'utf8'));
    } catch {
      return new Glyphs(null);
    }
  }

  can(ch: string): boolean {
    return this.shown === null || this.shown.has(ch) || ch === ' ' || ch === '\n';
  }

  /** Text with every character the device can't draw swapped, dropped or boxed. */
  fix(text: string): string {
    if (this.shown === null) return text;
    let out = '';
    let dropped = false; // just dropped an emoji: the space after it goes too
    for (const ch of text) {
      if (ch === ' ' && dropped && (out === '' || out.endsWith(' ') || out.endsWith('\n'))) {
        continue;
      }
      dropped = false;
      if (ch === '\t') {
        out += '  ';
      } else if (this.can(ch)) {
        out += ch;
      } else if (ch < ' ') {
        // control characters: nothing to show
      } else if (SWAPS[ch] !== undefined && [...SWAPS[ch]].every((c) => this.can(c))) {
        out += SWAPS[ch];
      } else if (DECORATION.test(ch)) {
        dropped = true;
      } else {
        out += MISSING;
      }
    }
    return out;
  }
}

/** Every string inside a value, run through fix. */
export function fixStrings<T>(value: T, fix: (text: string) => string): T {
  if (typeof value === 'string') return fix(value) as T;
  if (Array.isArray(value)) return value.map((v) => fixStrings(v, fix)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = fixStrings(v, fix);
    return out as T;
  }
  return value;
}
