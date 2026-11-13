// Time source for everything in the bridge that waits. Tests and the headless
// simulator use ManualClock so runs are instant and repeatable.

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  /** Run fn once after ms. Returns a function that cancels it. */
  after(ms: number, fn: () => void): () => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  after(ms, fn) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/** A clock that runs `speed` times faster than real time, for watching demos. */
export function fastClock(speed: number): Clock {
  return {
    now: () => Date.now(),
    after(ms, fn) {
      const timer = setTimeout(fn, ms / speed);
      return () => clearTimeout(timer);
    },
  };
}

export class ManualClock implements Clock {
  private time: number;
  private nextId = 1;
  private timers = new Map<number, { due: number; fn: () => void }>();

  constructor(startMs: number) {
    this.time = startMs;
  }

  now(): number {
    return this.time;
  }

  after(ms: number, fn: () => void): () => void {
    const id = this.nextId++;
    this.timers.set(id, { due: this.time + Math.max(0, ms), fn });
    return () => {
      this.timers.delete(id);
    };
  }

  /** Move time forward, running due timers in order (ties in the order they were set). */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let nextId = 0;
      let nextDue = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.due <= end && timer.due < nextDue) {
          nextDue = timer.due;
          nextId = id;
        }
      }
      if (nextId === 0) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.time = Math.max(this.time, timer.due);
      timer.fn();
    }
    this.time = end;
  }
}
