// Managed runs: agents started with `codetalky claude` / `codetalky codex`, inside a
// terminal the bridge can type into. Each run connects to ws://127.0.0.1:<port>/run
// and says which run token it gave its agent (in the CODETALKY_RUN environment
// variable, which the agent's hooks send back as a header). Device replies to a
// session from that run are typed into its terminal.

export const RUN_HEADER = 'x-codetalky-run';
export const RUN_ENV = 'CODETALKY_RUN';

export type FromRun = { t: 'hello'; run: string; agent: string; cwd: string };
export type ToRun = { t: 'type'; text: string };

interface Run {
  agent: string;
  cwd: string;
  type: (text: string) => void;
}

export type RunEvent = { type: 'started' | 'ended'; run: string };

export class Runs {
  private readonly runs = new Map<string, Run>();
  private readonly listeners = new Set<(event: RunEvent) => void>();

  /** A run's launcher connected. Returns the function to call when it disconnects. */
  add(run: string, agent: string, cwd: string, type: (text: string) => void): () => void {
    this.runs.set(run, { agent, cwd, type });
    this.emit({ type: 'started', run });
    return () => {
      if (this.runs.get(run)?.type !== type) return;
      this.runs.delete(run);
      this.emit({ type: 'ended', run });
    };
  }

  has(run: string): boolean {
    return this.runs.has(run);
  }

  /** Type a line into a run's terminal. False if the run is gone. */
  type(run: string, text: string): boolean {
    const r = this.runs.get(run);
    if (!r) return false;
    r.type(text);
    return true;
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
  if (!m || m.t !== 'hello') return null;
  if (typeof m.run !== 'string' || !/^[0-9a-f-]{36}$/.test(m.run)) return null;
  return {
    t: 'hello',
    run: m.run,
    agent: typeof m.agent === 'string' ? m.agent.slice(0, 32) : '',
    cwd: typeof m.cwd === 'string' ? m.cwd.slice(0, 1024) : '',
  };
}
