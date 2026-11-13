// A scripted stand-in for a real coding agent. It walks through a list of steps,
// writes what it "does" into the hub, and stops to wait whenever a real agent would:
// for permission, for an answer, or for the next instruction.

import type { Clock } from '../clock.ts';
import type { Hub } from '../hub.ts';
import { LIMITS, type ApproveAsk, type Choice, type Hunk, type LogEntry, type Para, type SessionSnapshot } from '../protocol.ts';

type AskBody = Pick<ApproveAsk, 'verb' | 'target' | 'add' | 'del' | 'line' | 'lines' | 'why' | 'risky'>;

export type Step =
  /** A tool call that takes `takes` seconds. For Edit and Write, `target` is the file path. */
  | {
      do: 'tool';
      verb: string;
      target: string;
      takes: number;
      add?: number;
      del?: number;
      res?: string;
      bad?: boolean;
      hunk?: Hunk;
    }
  | { do: 'say'; text: string }
  | { do: 'todo'; done: number }
  /** `ago` backdates the wait, for sessions that are already waiting when the demo opens. */
  | { do: 'approve'; ask: AskBody; allow: Step[]; deny: Step[]; ago?: number }
  | { do: 'question'; text: string; note?: string; multi?: boolean; options: { label: string; desc?: string; then: Step[] }[]; ago?: number }
  /** A plan waiting to be approved (Claude's plan mode); sent back, it goes on with `sendBack`. */
  | { do: 'plan'; plan: Para[]; approve: Step[]; sendBack: Step[]; ago?: number }
  | { do: 'done'; report: Para[]; ago?: number }
  /** Stops until the user replies, or by itself after `retryAfter` seconds. */
  | { do: 'error'; text: string; retryAfter?: number; ago?: number };

export type ToolStep = Extract<Step, { do: 'tool' }>;

export interface FakeScript {
  /** The session as it looks when the demo opens; t0 is "now" in Unix seconds. */
  initial(t0: number): SessionSnapshot;
  steps: Step[];
  /** What it does when told something after the script has run out. */
  followUp(text: string): Step[];
}

const APPROVE_TIMEOUT_S = 600;
/** In the demo, how long after a request goes back to the computer the user gets there and answers it. */
const AT_COMPUTER_S = 40;
const COUNTED: Record<string, 'read' | 'edit' | 'new' | 'cmd'> = {
  Read: 'read',
  Grep: 'read',
  Glob: 'read',
  Edit: 'edit',
  Write: 'new',
  Bash: 'cmd',
};

export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function addLog(s: SessionSnapshot, entry: LogEntry): void {
  s.log.unshift(entry);
  s.log.length = Math.min(s.log.length, LIMITS.log);
}

/** Write a finished tool call into a snapshot: log, counters, files, hunks. */
export function recordTool(s: SessionSnapshot, at: number, step: ToolStep): void {
  const isFile = step.verb === 'Edit' || step.verb === 'Write' || step.verb === 'Read';
  addLog(s, {
    at,
    verb: step.verb,
    target: isFile ? baseName(step.target) : step.target,
    add: step.add,
    del: step.del,
    res: step.res,
    bad: step.bad,
  });
  const counter = COUNTED[step.verb];
  if (counter) s.n[counter] += 1;
  s.n.add += step.add ?? 0;
  s.n.del += step.del ?? 0;
  if (step.verb === 'Edit' || step.verb === 'Write') {
    let file = s.files.find((f) => f.path === step.target);
    if (!file) {
      file = { st: step.verb === 'Write' ? 'A' : 'M', path: step.target, add: 0, del: 0 };
      s.files.unshift(file);
    }
    file.add += step.add ?? 0;
    file.del += step.del ?? 0;
    s.hunks.total += 1;
    if (step.hunk) s.hunks.list.unshift(step.hunk);
  }
}

/** Write something the agent said into a snapshot. */
export function recordSay(s: SessionSnapshot, at: number, text: string): void {
  s.say = text;
  addLog(s, { at, verb: '说', target: text });
}

export class FakeAgent {
  private readonly hub: Hub;
  private readonly clock: Clock;
  private readonly script: FakeScript;
  private readonly id: string;
  private queue: Step[];
  /** The step the agent is stopped on, if any. */
  private blocked: Extract<Step, { do: 'approve' | 'question' | 'plan' | 'done' | 'error' }> | null = null;
  private cancelTimer: (() => void) | null = null;
  private nextReq = 1;

  constructor(hub: Hub, clock: Clock, script: FakeScript) {
    this.hub = hub;
    this.clock = clock;
    this.script = script;
    this.queue = [...script.steps];
    const snapshot = script.initial(hub.nowSeconds());
    this.id = snapshot.id;
    hub.put(snapshot, {
      decide: (req, allow, text) => this.decide(req, allow, text),
      answer: (req, option) => this.answer(req, option),
      reply: (text) => this.reply(text),
    });
    this.next();
  }

  stop(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private change(fn: (s: SessionSnapshot) => void): void {
    this.hub.update(this.id, fn);
  }

  private log(s: SessionSnapshot, entry: Omit<LogEntry, 'at'>): void {
    addLog(s, { at: this.hub.nowSeconds(), ...entry });
  }

  private wait(seconds: number, fn: () => void): void {
    this.cancelTimer?.();
    this.cancelTimer = this.clock.after(seconds * 1000, () => {
      this.cancelTimer = null;
      fn();
    });
  }

  private resume(s: SessionSnapshot): void {
    s.state = 'running';
    s.since = this.hub.nowSeconds();
    delete s.ask;
    delete s.err;
    this.blocked = null;
  }

  private next(): void {
    const step = this.queue.shift();
    if (step === undefined) {
      // Ran out of script without a final report: sit idle until told something.
      this.blocked = { do: 'done', report: [] };
      this.change((s) => {
        s.state = 'idle';
        s.since = this.hub.nowSeconds();
      });
      return;
    }
    const now = this.hub.nowSeconds();
    switch (step.do) {
      case 'tool':
        this.change((s) => {
          s.state = 'running';
          s.now = { verb: step.verb, target: step.target, add: step.add, del: step.del };
        });
        this.wait(step.takes, () => {
          this.change((s) => this.finishTool(s, step));
          this.next();
        });
        break;
      case 'say':
        this.change((s) => recordSay(s, now, step.text));
        this.wait(2, () => this.next());
        break;
      case 'todo':
        this.change((s) => {
          if (s.todos) s.todos.done = Math.min(step.done, s.todos.items.length);
        });
        this.next();
        break;
      case 'approve': {
        const since = now - (step.ago ?? 0);
        const req = `r${this.nextReq++}`;
        this.blocked = step;
        this.change((s) => {
          s.state = 'approve';
          s.since = since;
          s.now = { verb: step.ask.verb, target: step.ask.target, add: step.ask.add, del: step.ask.del };
          s.ask = { kind: 'approve', req, ...step.ask, until: since + APPROVE_TIMEOUT_S };
        });
        // A real hook gives up after its timeout and the agent asks in the terminal
        // instead; here the user gets to the computer a little later and says no.
        this.wait(since + APPROVE_TIMEOUT_S - now, () => {
          this.change((s) => {
            this.resume(s);
            s.say = '没等到设备回话，回电脑确认';
            s.there = true;
          });
          this.wait(AT_COMPUTER_S, () => {
            this.queue.unshift({ do: 'say', text: '在电脑上拒绝了，这一步先跳过。' }, ...step.deny);
            this.change((s) => {
              delete s.there;
            });
            this.next();
          });
        });
        break;
      }
      case 'question': {
        const req = `r${this.nextReq++}`;
        this.blocked = step;
        this.change((s) => {
          s.state = 'question';
          s.since = now - (step.ago ?? 0);
          s.ask = {
            kind: 'question',
            req,
            text: step.text,
            note: step.note,
            options: step.options.map(({ label, desc }) => ({ label, desc })),
            ...(step.multi ? { multi: true } : {}),
          };
        });
        break;
      }
      case 'plan': {
        const since = now - (step.ago ?? 0);
        const req = `r${this.nextReq++}`;
        this.blocked = step;
        this.change((s) => {
          s.state = 'approve';
          s.since = since;
          s.now = { verb: '计划', target: `${step.plan[0]?.lead ?? ''}${step.plan[0]?.text ?? ''}` };
          s.ask = { kind: 'plan', req, plan: step.plan, until: since + APPROVE_TIMEOUT_S };
        });
        this.wait(since + APPROVE_TIMEOUT_S - now, () => {
          this.queue.unshift({ do: 'say', text: '没等到批准，回电脑确认计划。' }, ...step.sendBack);
          this.change((s) => this.resume(s));
          this.next();
        });
        break;
      }
      case 'done':
        this.blocked = step;
        this.change((s) => {
          s.state = 'done';
          s.since = now - (step.ago ?? 0);
          s.report = step.report;
          if (s.todos) s.todos.done = s.todos.items.length;
        });
        break;
      case 'error':
        this.blocked = step;
        this.change((s) => {
          s.state = 'error';
          s.since = now - (step.ago ?? 0);
          s.err = step.text;
        });
        if (step.retryAfter !== undefined) {
          this.wait(step.retryAfter, () => {
            this.change((s) => this.resume(s));
            this.next();
          });
        }
        break;
    }
  }

  private finishTool(s: SessionSnapshot, step: ToolStep): void {
    recordTool(s, this.hub.nowSeconds(), step);
    if (s.ctx !== undefined) s.ctx = Math.min(95, s.ctx + 1);
  }

  private decide(_req: string, allow: boolean, text?: string): void {
    const step = this.blocked;
    if (step?.do === 'plan') {
      this.cancelTimer?.();
      this.cancelTimer = null;
      this.queue.unshift(...(allow ? step.approve : [...(text ? [{ do: 'say' as const, text: `按你的意见改：${text}` }] : []), ...step.sendBack]));
      this.change((s) => {
        this.log(s, allow ? { verb: '计划', target: '已批准' } : { verb: '计划', target: text ? `打回：${text}` : '打回重做', bad: true });
        this.resume(s);
      });
      this.next();
      return;
    }
    if (step?.do !== 'approve') return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.queue.unshift(...(allow ? step.allow : step.deny));
    this.change((s) => {
      if (!allow) this.log(s, { verb: step.ask.verb, target: step.ask.target, res: '已拒绝', bad: true });
      this.resume(s);
    });
    this.next();
  }

  private answer(_req: string, choice: Choice): void {
    const step = this.blocked;
    if (step?.do !== 'question') return;
    // The script only knows how to go on from its options: several, or the user's own
    // words, go on as the first one picked (or the first one).
    const option = 'option' in choice ? choice.option : 'options' in choice ? (choice.options[0] ?? 0) : 0;
    const chosen = step.options[option];
    if (!chosen) return;
    const said = 'text' in choice ? choice.text : 'options' in choice ? choice.options.map((i) => step.options[i]?.label ?? '').join('、') : chosen.label;
    this.queue.unshift(...chosen.then);
    this.change((s) => {
      this.log(s, { verb: '答', target: said });
      this.resume(s);
    });
    this.next();
  }

  private reply(text: string): void {
    const step = this.blocked;
    if (step?.do === 'done' || step?.do === 'error') {
      // A new turn starts.
      this.cancelTimer?.();
      this.cancelTimer = null;
      if (this.queue.length === 0) this.queue = this.script.followUp(text);
      this.change((s) => {
        this.log(s, { verb: '你', target: text });
        this.resume(s);
        s.started = s.since;
        delete s.report;
      });
      this.next();
      return;
    }
    // Busy or waiting on something else: it will get to it after the current step.
    this.queue.unshift({ do: 'say', text: `收到，手上这一步做完就处理：${text}` });
    this.change((s) => this.log(s, { verb: '你', target: text }));
  }
}
