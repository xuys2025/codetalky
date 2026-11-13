// Managed runs: agents started with `codetalky claude` / `codetalky codex`, inside a
// terminal the bridge can type into. Each run connects to ws://127.0.0.1:<port>/run
// and says which run token it gave its agent (in the CODETALKY_RUN environment
// variable, which the agent's hooks send back as a header). Device replies to a
// session from that run are typed into its terminal.

export const RUN_HEADER = 'x-codetalky-run';
export const RUN_ENV = 'CODETALKY_RUN';

export type FromRun =
  | { t: 'hello'; run: string; agent: string; cwd: string }
  /** Answer to a press: ok is false if the screen didn't show what was expected. */
  | { t: 'pressed'; id: number; ok: boolean };
export type ToRun =
  | { t: 'type'; text: string }
  /**
   * Press keys, but only if the screen matches expect (a case-insensitive regular
   * expression: the agent's prompt is up) and shows needle (what this particular
   * request is about, compared without whitespace since the terminal wraps it).
   */
  | { t: 'press'; id: number; keys: string; expect: string; needle?: string };

/** How long to wait for a launcher to say whether it pressed. */
const PRESS_TIMEOUT_MS = 3000;

interface Run {
  agent: string;
  cwd: string;
  send: (msg: ToRun) => void;
  presses: Map<number, (ok: boolean) => void>;
}

export type RunEvent = { type: 'started' | 'ended'; run: string; agent: string; cwd: string };

export class Runs {
  private readonly runs = new Map<string, Run>();
  private readonly listeners = new Set<(event: RunEvent) => void>();
  private nextPress = 1;

  /** A run's launcher connected. Returns the function to call when it disconnects. */
  add(run: string, agent: string, cwd: string, send: (msg: ToRun) => void): () => void {
    const entry: Run = { agent, cwd, send, presses: new Map() };
    this.runs.set(run, entry);
    this.emit({ type: 'started', run, agent, cwd });
    return () => {
      if (this.runs.get(run) !== entry) return;
      this.runs.delete(run);
      for (const done of entry.presses.values()) done(false);
      entry.presses.clear();
      this.emit({ type: 'ended', run, agent, cwd });
    };
  }

  has(run: string): boolean {
    return this.runs.has(run);
  }

  /** Type a line into a run's terminal. False if the run is gone. */
  type(run: string, text: string): boolean {
    const r = this.runs.get(run);
    if (!r) return false;
    r.send({ t: 'type', text });
    return true;
  }

  /** Press keys in a run's terminal if its screen shows the prompt and needle. Resolves with whether it did. */
  press(run: string, keys: string, expect: string, needle?: string): Promise<boolean> {
    const r = this.runs.get(run);
    if (!r) return Promise.resolve(false);
    const id = this.nextPress++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => done(false), PRESS_TIMEOUT_MS);
      const done = (ok: boolean) => {
        clearTimeout(timer);
        r.presses.delete(id);
        resolve(ok);
      };
      r.presses.set(id, done);
      r.send({ t: 'press', id, keys, expect, ...(needle ? { needle } : {}) });
    });
  }

  /** A launcher's answer to press(). */
  pressed(run: string, id: number, ok: boolean): void {
    this.runs.get(run)?.presses.get(id)?.(ok);
  }

  subscribe(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: RunEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

/** Validate one frame from a launcher. */
export function parseFromRun(text: string): FromRun | null {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  const m = msg as Record<string, unknown> | null;
  if (m?.t === 'pressed') {
    return typeof m.id === 'number' && Number.isInteger(m.id) ? { t: 'pressed', id: m.id, ok: m.ok === true } : null;
  }
  if (!m || m.t !== 'hello') return null;
  if (typeof m.run !== 'string' || !/^[0-9a-f-]{36}$/.test(m.run)) return null;
  return {
    t: 'hello',
    run: m.run,
    agent: typeof m.agent === 'string' ? m.agent.slice(0, 32) : '',
    cwd: typeof m.cwd === 'string' ? m.cwd.slice(0, 1024) : '',
  };
}
