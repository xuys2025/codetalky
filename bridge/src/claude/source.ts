// Claude Code and Codex sessions, as seen through their hooks.
//
// Permission requests and questions are held open while a device is connected, so the
// user can answer on the device. If no device is connected, or nobody answers before
// the deadline, or the device goes away, the hook returns without a decision and the
// agent asks in the terminal as usual. Claude Code shows its own prompt in the
// terminal while the hook waits, and whichever side answers first wins.
//
// Codex does not draw its prompt while a hook runs. For Codex sessions started with
// `codetalky codex` the request is therefore not held: the prompt comes up in the
// terminal at once, and the device answers it by pressing its keys there. Plain
// `codex` sessions are held like Claude's, and their terminal waits meanwhile.
//
// Managed runs (codetalky claude/codex) show on the device as soon as their terminal
// opens, before the agent has a session (Codex starts one only at the first prompt),
// and keep that one entry across the agent's sessions (/clear).
//
// Subagents (Claude's Agent tool) run inside their session: their hooks carry its
// session id plus agent_id and agent_type (checked with Claude Code 2.1.325). They show
// as part of the session, marked with their type. Only what they change or run is
// logged, not what they read (an Explore agent reads dozens of files). A subagent may
// work in its own worktree: its folder is not the session's. A session whose turn ends
// while subagents work in the background stays busy: Claude Code wakes it with their
// report (a prompt it writes itself), and it stops again after that.

import { LIMITS, type ApproveAsk, type Choice, type PlanAsk, type QuestionAsk, type ReplyHow, type SessionSnapshot } from '../protocol.ts';
import type { Clock } from '../clock.ts';
import type { Hub } from '../hub.ts';
import type { IncomingHttpHeaders } from 'node:http';

import { RUN_HEADER, type RunEvent, type Runs } from '../runs.ts';
import type { PostReply } from '../server.ts';
import { firstWords, reportFromMarkdown, shortModel } from './text.ts';
import { gitBranch } from '../git.ts';
import { claudeTools, type ToolKit, type ToolResult } from './tools.ts';
import { TranscriptTail, todosFrom } from './transcript.ts';
import { RolloutTail, type CompletedChange } from '../codex/rollout.ts';
import { changeResult } from '../codex/tools.ts';

/** Keys that answer the agent's own permission prompt in its terminal. */
export interface TerminalKeys {
  allow: string;
  deny: string;
  /** Only pressed while the screen matches this (case-insensitive regular expression). */
  expect: string;
}

export interface ClaudeOptions {
  /** How long a permission request or question waits for the device, in seconds. */
  holdSeconds: number;
  /** Managed runs (codetalky claude): their sessions can take instructions from the device. */
  runs?: Runs;
  /** Which agent's hooks these are (default claude). */
  agent?: 'claude' | 'codex';
  /** How that agent's tools look on the device (default Claude Code's). */
  tools?: ToolKit;
  /**
   * For managed runs: don't hold permission requests; let the agent show its prompt in
   * the terminal at once, and answer it from the device with these keys. For agents
   * that don't draw their prompt while a hook is running (Codex).
   */
  terminalKeys?: TerminalKeys;
  log: (line: string) => void;
}

/** Codex's approval prompt in its terminal, and the keys that answer it. */
export const CODEX_KEYS: TerminalKeys = { allow: 'y', deny: '\x1b', expect: 'Yes, proceed|Press enter to confirm' };

/** Sessions with no hook events for this long are dropped (the terminal was closed). */
const FORGET_AFTER_S = 12 * 3600;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const NO_DECISION: PostReply = { status: 200 };
/** What the device says when a held request was answered at the computer instead. */
const ANSWERED_THERE = '已在电脑上处理';
/** What the device says while the agent asks at the computer and the device can't answer. */
const WAITING_THERE = '在电脑上等你确认';
/** Codex stopped a turn without a Stop hook (Esc, or no to its prompt). */
const STOPPED_THERE = '在电脑上中断了，等你的下一条指令';
/** How often a working Codex session's file is read between hooks. */
const POLL_MS = 2000;
/** How long an instruction typed into the terminal may take to show up as the agent's prompt. */
const TAKEN_MS = 30_000;
/** How long held requests wait for a device that dropped off (a Wi-Fi blip) to come back. */
export const DEVICE_GRACE_MS = 30_000;

/** The agent waits for the user at the computer: the device says so and shows it as such. */
function waitThere(s: SessionSnapshot, why = WAITING_THERE): void {
  s.say = why;
  s.there = true;
}

/** Whatever it waited for at the computer has been dealt with. */
function doneThere(s: SessionSnapshot): void {
  if (s.there) {
    delete s.there;
    delete s.say;
  } else if (s.say === WAITING_THERE) {
    delete s.say;
  }
}

/** A tool call's input for comparing two calls: keys in order, without the reason given for it. */
function sameInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input)
    .filter((k) => k !== 'description' && k !== 'justification')
    .sort();
  return JSON.stringify(keys.map((k) => [k, input[k]]));
}

/** What the device shows while instructions wait for the agent's turn to end. */
function waitingSay(queued: string[]): string {
  const more = queued.length > 1 ? `（后面还有 ${queued.length - 1} 条）` : '';
  return `它做完这一轮再发给它：${firstLine(queued[0] ?? '', 40)}${more}`;
}

type Event = Record<string, unknown> & { session_id: string; hook_event_name: string };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

const firstLine = (text: string, max = 120) => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/** A subagent's tool calls are marked with its type: "Explore › src/cart.ts". */
function byOf(event: Event): string | undefined {
  if (typeof event.agent_id !== 'string' || !event.agent_id) return undefined;
  const type = str(event.agent_type);
  return `${!type || type === 'general-purpose' ? '子代理' : type} › `;
}

/**
 * Prompts Claude Code writes itself to wake the agent: a subagent or a background task
 * reporting back. How the log shows one; undefined for the user's own words.
 */
function injected(prompt: string): { verb: string; target: string } | undefined {
  const p = prompt.trimStart();
  if (p.startsWith('<agent-message')) return { verb: 'Agent', target: '子代理交回结果' };
  if (p.startsWith('<task-notification')) {
    const summary = /<summary>([^<]*)<\/summary>/.exec(p)?.[1]?.trim();
    return { verb: '后台', target: summary ? firstLine(summary) : '后台任务有结果了' };
  }
  return undefined;
}

/** In-flight background subagents, from a Stop hook: what each one does. */
function backgroundAgents(tasks: unknown): string[] {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .map(obj)
    .filter((t) => t.type === 'subagent')
    .map((t) => str(t.description) ?? str(t.agent_type) ?? '');
}

interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
}

/** Claude's plan mode: approving the plan lets it start; from then on each step still asks (default mode). */
const PLAN_APPROVED_MODE = 'default';

/** A request held open for the device. Only the first one in a session's queue is shown. */
interface Held {
  req: string;
  /** What the device sees while this request is shown. */
  ask: ApproveAsk | QuestionAsk | PlanAsk;
  tool: string;
  target: string;
  /** For AskUserQuestion: all its questions, the one shown, and answers so far. */
  questions?: Question[];
  index?: number;
  answers?: Record<string, string>;
  input: Record<string, unknown>;
  /** The agent's id for the tool call, when its hook says. */
  toolUseId?: string;
  /** Asked by a subagent (its agent_id); undefined: by the session's own agent. */
  agent?: string;
  /** Not held: the agent's own prompt is up in the terminal, and the device answers it with keys. */
  viaKeys?: boolean;
  /** A key press for it is on its way to the terminal. */
  pressing?: boolean;
  finish: (reply: PostReply) => void;
  cancelTimer: () => void;
}

interface Session {
  /** The id on the device. */
  id: string;
  tail: TranscriptTail | null;
  /** Codex: its session file, for file changes and what it says. */
  rollout: RolloutTail | null;
  lastText: string | undefined;
  cwd: string | undefined;
  lastEvent: number;
  held: Held[];
  /** Claude Code has exited; kept only until its report has been seen. */
  ended: boolean;
  /** The run token its hooks carry, if it was started with codetalky claude. */
  token: string | null;
  /**
   * A managed run whose agent hasn't started a session yet (Codex starts one only at
   * the first prompt) or is between sessions (/clear). Shown so the device can send it
   * an instruction; the next session from the same run takes over this entry.
   */
  waiting: boolean;
  /** Instructions from the device that wait for the agent to finish its turn. */
  queued: string[];
  /** Interjections and interruptions (reply how 'now' / 'stop'): typed at once, unless a prompt is up. */
  urgent: { text: string; stop: boolean }[];
  /** Interjections typed and logged already: their UserPromptSubmit, if any, isn't logged twice. */
  steered: string[];
  /**
   * One of them was typed and the agent hasn't started on it yet: the next waits for
   * the turn after (it would otherwise go out before the agent says it's busy).
   * Calling it stops the timer that gives up waiting.
   */
  typed: (() => void) | null;
  /** Whose prompt it waits at the computer for (s.there): a subagent's agent_id, or undefined. */
  thereFor: string | undefined;
  /** Subagents seen in it (agent_id), to log each once. */
  agents: Set<string>;
}

const emptyCounts = () => ({ read: 0, edit: 0, new: 0, cmd: 0, add: 0, del: 0 });

/** In the middle of a turn: it may put up a prompt at any moment. */
const isBusy = (state: string | undefined) => state === 'running' || state === 'approve' || state === 'question';

/**
 * What the agent's terminal prompt for this request shows that another request's
 * wouldn't: the whole command, or the first file's name.
 */
function needleOf(held: Pick<Held, 'tool' | 'target'>): { text: string; whole: boolean } {
  if (/^(apply_patch|Edit|Write)$/.test(held.tool)) return { text: baseName(held.target.replace(/ 等 \d+ 个文件$/, '')), whole: false };
  return { text: held.target, whole: true };
}

export class ClaudeSource {
  private readonly hub: Hub;
  private readonly clock: Clock;
  private readonly options: ClaudeOptions;
  private readonly agent: 'claude' | 'codex';
  private readonly tools: ToolKit;
  private readonly sessions = new Map<string, Session>();
  /** Sessions whose interjections are being sent right now (see sendUrgent). */
  private readonly sendingUrgent = new Set<Session>();
  /** The agent's session id -> the device's, where they differ (a managed run's entry was there first). */
  private readonly aliases = new Map<string, string>();
  private nextReq = 1;
  private cancelSweep: () => void;
  /** The last device left a moment ago: stops the wait for it to come back. */
  private deviceGrace: (() => void) | null = null;
  private cancelPoll: () => void = () => {};
  private readonly unsubscribe: () => void;
  private readonly unsubscribeRuns: () => void;

  constructor(hub: Hub, clock: Clock, options: ClaudeOptions) {
    this.hub = hub;
    this.clock = clock;
    this.options = options;
    this.agent = options.agent ?? 'claude';
    this.tools = options.tools ?? claudeTools;
    this.cancelSweep = this.scheduleSweep();
    if (this.agent === 'codex') this.cancelPoll = this.schedulePoll();
    this.unsubscribe = hub.subscribe((event) => {
      if (event.type === 'devices') this.devicesChanged();
      // An ended session's report has been seen: it can go now.
      if (event.type === 'changed' && this.sessions.get(event.id)?.ended && hub.get(event.id)?.state === 'idle') {
        this.forget(event.id);
      }
      // A turn is over: an instruction that waited for it can go now. A question was
      // answered: an interjection that waited for that can go.
      if (event.type === 'changed') {
        const session = this.sessions.get(event.id);
        if (session && session.queued.length > 0) this.sendQueued(session);
        if (session && session.urgent.length > 0) this.sendUrgent(session);
      }
    });
    this.unsubscribeRuns = options.runs?.subscribe((event) => this.onRun(event)) ?? (() => {});
  }

  /**
   * The last device left. Held requests wait a little for it to come back (a Wi-Fi
   * blip, a restart), then go back to the terminal. Meanwhile new ones are held too.
   */
  private devicesChanged(): void {
    if (this.hub.devices() > 0) {
      this.deviceGrace?.();
      this.deviceGrace = null;
      return;
    }
    if (this.deviceGrace) return;
    this.deviceGrace = this.clock.after(DEVICE_GRACE_MS, () => {
      this.deviceGrace = null;
      if (this.hub.devices() > 0) return;
      for (const session of this.sessions.values()) this.releaseAll(session, '设备断开了，回电脑确认', true);
    });
  }

  /** No device to ask, nor one expected back soon. */
  private noDevice(): boolean {
    return this.hub.devices() === 0 && this.deviceGrace === null;
  }

  /** A managed terminal opened or closed. */
  private onRun(event: RunEvent): void {
    if (event.type === 'started' && event.agent === this.agent) {
      // A launcher that lost its connection and got it back: its sessions take instructions again.
      const known = [...this.sessions.values()].filter((s) => s.token === event.run);
      for (const session of known) this.setToken(session, event.run);
      if (known.length === 0) this.waitFor(event.run, event.cwd);
      return;
    }
    for (const session of [...this.sessions.values()]) {
      if (session.token !== event.run) continue;
      if (event.type === 'ended') {
        for (const held of session.held.filter((h) => h.viaKeys)) this.release(session, held, '');
      }
      if (event.type === 'ended' && session.waiting) {
        // Closed before (or after) its agent did anything worth keeping.
        if (this.hub.get(session.id)?.state === 'done') {
          session.ended = true;
          this.setToken(session, event.run);
        } else {
          this.forget(session.id);
        }
        continue;
      }
      this.setToken(session, event.run);
    }
  }

  /** Show a managed run before its agent has a session, so the device can send the first instruction. */
  private waitFor(run: string, cwd: string): void {
    const id = `run-${run.slice(0, 8)}`;
    if (this.sessions.has(id)) return;
    const session: Session = {
      id,
      tail: null,
      rollout: null,
      lastText: undefined,
      cwd: cwd || undefined,
      lastEvent: this.now(),
      held: [],
      ended: false,
      token: run,
      waiting: true,
      queued: [],
      urgent: [],
      steered: [],
      typed: null,
      thereFor: undefined,
      agents: new Set(),
    };
    this.sessions.set(id, session);
    this.put(id, cwd || undefined, true);
    this.options.log(`${this.agent} run ${run.slice(0, 8)} waiting in ${cwd}`);
  }

  private put(id: string, cwd: string | undefined, reply: boolean): void {
    const now = this.now();
    this.hub.put(
      {
        id,
        name: cwd ? baseName(cwd) : id.slice(0, 8),
        agent: this.agent,
        branch: cwd ? gitBranch(cwd) : undefined,
        model: '—', // until the transcript or SessionStart says which
        state: 'idle',
        since: now,
        started: now,
        reply,
        n: emptyCounts(),
        log: [],
        files: [],
        hunks: { total: 0, list: [] },
      },
      {
        decide: (req, allow, text) => this.decide(id, req, allow, text),
        answer: (req, choice) => this.answer(id, req, choice),
        reply: (text, how) => this.reply(id, text, how),
      },
    );
  }

  /** Start reading the agent's transcript (Claude Code) or session file (Codex). */
  private attach(session: Session, transcript: string | undefined): void {
    if (!transcript) return;
    if (this.agent === 'claude' && !session.tail) session.tail = new TranscriptTail(transcript);
    if (this.agent === 'codex' && session.rollout?.path !== transcript) session.rollout = new RolloutTail(transcript);
  }

  stop(): void {
    this.cancelSweep();
    this.cancelPoll();
    this.unsubscribe();
    this.unsubscribeRuns();
    this.deviceGrace?.();
    for (const session of this.sessions.values()) this.releaseAll(session, '');
  }

  /**
   * Handle one hook POST. Resolves with the HTTP reply for Claude Code. gone fires if
   * the agent stops waiting (the same prompt was answered in the terminal).
   */
  handle(body: unknown, headers: IncomingHttpHeaders = {}, gone?: AbortSignal): Promise<PostReply> {
    const event = obj(body);
    if (typeof event.session_id !== 'string' || !event.session_id || typeof event.hook_event_name !== 'string') {
      return Promise.resolve({ status: 400, body: { error: 'not a hook event' } });
    }
    const run = headers[RUN_HEADER];
    return this.dispatch(event as Event, typeof run === 'string' && /^[0-9a-f-]{36}$/.test(run) ? run : null, gone);
  }

  /**
   * The run token from a session's hooks. While that run's launcher is connected the
   * device can type into it, and it is named after the folder that terminal was opened
   * in: the agent may work in a subfolder, or have resumed a session from elsewhere.
   */
  private setToken(session: Session, token: string | null): void {
    session.token = token;
    const managed = token !== null && (this.options.runs?.has(token) ?? false);
    const home = token !== null ? this.options.runs?.cwdOf(token) : undefined;
    const shown = this.hub.get(session.id);
    if (shown?.reply !== managed || (home && shown?.name !== baseName(home))) {
      this.change(session.id, (s) => {
        s.reply = managed;
        if (home) s.name = baseName(home);
      });
    }
  }

  /**
   * An instruction from the device, typed into the agent's terminal. how 'now': at once,
   * also mid-turn (the agent takes it after its current step: the user steering it);
   * 'stop': interrupt it first. Unset (older devices): it waits until the turn is over.
   * Either way the launcher types only while no prompt is on the screen, since the
   * instruction's Enter would answer it.
   */
  private reply(id: string, text: string, how?: ReplyHow): void {
    const session = this.sessions.get(id);
    if (!session?.token) return;
    if (how) {
      // An interruption goes ahead of interjections still waiting for a prompt to close.
      if (how === 'stop') session.urgent.unshift({ text, stop: true });
      else session.urgent.push({ text, stop: false });
      this.sendUrgent(session);
      return;
    }
    session.queued.push(text);
    this.sendQueued(session);
    if (session.queued.length > 0) {
      this.change(id, (s) => {
        s.say = waitingSay(session.queued);
      });
    }
  }

  /**
   * Type the next waiting instruction, if the agent is between turns and has started
   * on the last one typed. It reports the prompt through UserPromptSubmit, which logs it.
   */
  private sendQueued(session: Session): void {
    if (session.queued.length === 0 || session.typed || !session.token || !this.options.runs?.has(session.token)) return;
    if (isBusy(this.hub.get(session.id)?.state)) return;
    this.options.runs.type(session.token, session.queued.shift()!);
    session.typed = this.clock.after(TAKEN_MS, () => {
      // It never said it started: don't hold the rest up for good.
      session.typed = null;
      this.sendQueued(session);
    });
  }

  /**
   * Interjections and interruptions go at once, except an interjection while the agent
   * asks something (approval, a question): it waits until that is answered. An
   * interruption goes even then: its Esc dismisses the prompt, and the request on the
   * device ends with it.
   */
  private sendUrgent(session: Session): void {
    // Its own changes below call it again (through the hub): one loop at a time keeps the order.
    if (!session.token || !this.options.runs?.has(session.token) || this.sendingUrgent.has(session)) return;
    this.sendingUrgent.add(session);
    try {
      this.sendUrgentNow(session, session.token);
    } finally {
      this.sendingUrgent.delete(session);
    }
  }

  private sendUrgentNow(session: Session, token: string): void {
    while (session.urgent.length > 0) {
      const next = session.urgent[0]!;
      const state = this.hub.get(session.id)?.state;
      if (!next.stop && (state === 'approve' || state === 'question')) return;
      session.urgent.shift();
      this.options.runs!.type(token, next.text, next.stop);
      // The Esc dismisses whatever prompt is up: the requests the device holds end with it.
      if (next.stop) this.releaseAll(session, '');
      if (next.text) session.steered.push(next.text);
      if (session.steered.length > 10) session.steered.shift(); // in case the agent never reports some
      this.change(session.id, (s) => {
        if (next.stop && !next.text) {
          // Just stop. Claude Code runs no Stop hook when interrupted: say so here.
          s.state = 'idle';
          s.since = this.now();
          delete s.now;
          s.say = '停下了，等你的下一条指令';
        }
        this.log(s, { verb: next.stop ? '打断' : '插话', target: next.text ? firstLine(next.text) : '让它停下' });
      });
    }
  }

  /** The agent started on a prompt: the next instruction waits for the end of this turn. */
  private taken(session: Session): void {
    session.typed?.();
    session.typed = null;
  }

  private now(): number {
    return this.hub.nowSeconds();
  }

  private change(id: string, fn: (s: SessionSnapshot) => void): void {
    this.hub.update(id, (s) => {
      fn(s);
      // Waiting at the computer is something it does while working; not once it stopped or asks the device.
      if (s.there && s.state !== 'running') doneThere(s);
    });
  }

  private log(s: SessionSnapshot, entry: Omit<SessionSnapshot['log'][number], 'at'>): void {
    s.log.unshift({ at: this.now(), ...entry });
    s.log.length = Math.min(s.log.length, LIMITS.log);
  }

  private session(event: Event, run: string | null): Session {
    const own = event.session_id.slice(0, LIMITS.id);
    const cwd = str(event.cwd);
    const transcript = str(event.transcript_path);
    let id = this.aliases.get(own) ?? own;
    let session = this.sessions.get(id);
    if ((!session || !this.hub.get(id)) && run) {
      // The first session of a managed run that is already on the device: take over its entry.
      const waiting = [...this.sessions.values()].find((s) => s.waiting && s.token === run && this.hub.get(s.id));
      if (waiting) {
        this.aliases.set(own, waiting.id);
        id = waiting.id;
        session = waiting;
        session.waiting = false;
        session.ended = false;
        this.options.log(`${this.agent} session ${own.slice(0, 8)} in ${cwd ?? '?'}`);
      }
    }
    if (session?.waiting) session.waiting = false;
    if (!session || !this.hub.get(id)) {
      session = {
        id,
        tail: null,
        rollout: null,
        lastText: undefined,
        cwd,
        lastEvent: this.now(),
        held: [],
        ended: false,
        token: null,
        waiting: false,
        queued: [],
        urgent: [],
        steered: [],
        typed: null,
        thereFor: undefined,
        agents: new Set(),
      };
      this.sessions.set(id, session);
      this.put(id, cwd, false); // replies stay off until a managed run claims it
      this.options.log(`${this.agent} session ${id.slice(0, 8)} in ${cwd ?? '?'}`);
    }
    if (run) this.dropPlaceholders(session, run);
    // A subagent may work in its own folder (a worktree): the session's stays.
    const sub = typeof event.agent_id === 'string' && event.agent_id !== '';
    if (!transcript || !/[\\/]subagents[\\/]/.test(transcript)) this.attach(session, transcript);
    if (cwd && !sub) session.cwd = cwd;
    session.lastEvent = this.now();
    if (run !== session.token) this.setToken(session, run);
    // What hooks don't say: model, branch and the latest thing Claude wrote.
    const state = session.tail?.update();
    this.change(id, (s) => {
      const model = str(event.model) ?? state?.model;
      if (model) s.model = shortModel(model);
      if (state?.branch) s.branch = state.branch;
      if (state?.text && state.text !== session.lastText) {
        session.lastText = state.text;
        s.say = firstWords(state.text);
      }
    });
    this.readRollout(session);
    return session;
  }

  /** Codex: what its session file says happened since the last look (also read between hooks). */
  private readRollout(session: Session): void {
    if (!session.rollout) return;
    const news = session.rollout.update();
    const text = session.rollout.text;
    // A turn stopped without a Stop hook: no prompt of it is up any more.
    if (news.aborted) for (const held of session.held.filter((h) => h.viaKeys).reverse()) this.release(session, held, '');
    this.change(session.id, (s) => {
      if (text && text !== session.lastText) {
        session.lastText = text;
        s.say = firstWords(text);
      }
      for (const change of news.changes) this.recordChange(s, change, session.cwd);
      if (news.aborted && (s.state === 'running' || s.state === 'approve')) {
        s.state = 'idle';
        s.since = this.now();
        delete s.now;
        s.say = STOPPED_THERE;
      }
    });
  }

  private async dispatch(event: Event, run: string | null, gone?: AbortSignal): Promise<PostReply> {
    const session = this.session(event, run);
    const id = session.id;
    const cwd = str(event.cwd);
    const raw = { tool: str(event.tool_name) ?? '', input: obj(event.tool_input) };
    const { tool, input } = this.tools.normalize?.(raw.tool, raw.input) ?? raw;
    const agent = str(event.agent_id) || undefined;
    const by = byOf(event);
    if (agent && !session.agents.has(agent)) {
      session.agents.add(agent);
      this.options.log(`${this.agent} session ${id.slice(0, 8)}: subagent ${str(event.agent_type) ?? '?'} ${agent.slice(0, 12)}`);
    }
    switch (event.hook_event_name) {
      case 'SessionStart':
        return NO_DECISION;
      case 'UserPromptSubmit': {
        const woken = injected(str(event.prompt) ?? '');
        if (woken) {
          // Work it left in the background reported back: the same task goes on.
          this.change(id, (s) => {
            if (!isBusy(s.state)) {
              s.state = 'running';
              s.since = this.now();
              delete s.now;
            }
            this.log(s, woken);
          });
          return NO_DECISION;
        }
        this.releaseKeyed(session);
        this.change(id, (s) => {
          // Sent while it was still working (queued, or typed mid-turn): part of the same task.
          const busy = s.state === 'running' || s.state === 'approve' || s.state === 'question';
          if (!busy) {
            const now = this.now();
            s.state = 'running';
            s.since = now;
            s.started = now;
            if (cwd) s.branch = gitBranch(cwd) ?? s.branch;
            s.n = emptyCounts();
            s.files = [];
            s.hunks = { total: 0, list: [] };
            delete s.report;
            delete s.err;
            delete s.now;
            delete s.say; // the last report's words; new ones come from the transcript
          }
          doneThere(s);
          if (session.queued.length > 0) s.say = waitingSay(session.queued);
          // An interjection was logged when it was typed.
          const prompt = str(event.prompt) ?? '';
          const steered = session.steered.indexOf(prompt.trim());
          if (steered >= 0) session.steered.splice(steered, 1);
          else this.log(s, { verb: '你', target: firstLine(prompt) });
        });
        // Only now that it shows as working: before, the change above could let the next one go.
        this.taken(session);
        return NO_DECISION;
      }
      case 'PreToolUse':
        if (tool === 'AskUserQuestion') return this.holdQuestion(session, input, gone);
        // The next tool call: the terminal prompt before it has been answered.
        this.releaseKeyed(session);
        if (by) {
          // A subagent at work (its to-do list is its own). Something the device shows
          // for the session itself, a request, stays up.
          this.change(id, (s) => {
            if (s.state === 'approve' || s.state === 'question') return;
            if (s.state !== 'running') {
              s.state = 'running';
              s.since = this.now();
            }
            this.movedOn(session, s, agent);
            if (tool !== 'TodoWrite') s.now = { verb: this.tools.verbOf(tool), target: by + this.tools.targetOf(tool, input, cwd) };
          });
          return NO_DECISION;
        }
        this.change(id, (s) => {
          if (s.state !== 'approve' && s.state !== 'question' && s.state !== 'running') {
            s.state = 'running';
            s.since = this.now();
          }
          this.movedOn(session, s, agent);
          if (tool === 'TodoWrite') {
            const todos = todosFrom(input);
            if (todos) s.todos = todos;
          } else {
            s.now = { verb: this.tools.verbOf(tool), target: this.tools.targetOf(tool, input, cwd) };
          }
        });
        return NO_DECISION;
      case 'PermissionRequest':
        if (tool === 'ExitPlanMode') return this.holdPlan(session, input, gone);
        if (tool === 'AskUserQuestion') return NO_DECISION;
        return this.holdPermission(session, tool, input, cwd, gone, str(event.tool_use_id), agent, by);
      case 'PostToolUse':
        this.settled(session, tool, input, str(event.tool_use_id));
        this.change(id, (s) => {
          this.movedOn(session, s, agent);
          if (tool === 'TodoWrite' || tool === 'AskUserQuestion') return;
          // Codex's session file has its file changes, with the exact diff.
          if (session.rollout && this.tools.isFileTool(tool)) return;
          this.record(s, tool, input, event.tool_response, cwd, by);
        });
        return NO_DECISION;
      case 'PostToolUseFailure':
        this.settled(session, tool, input, str(event.tool_use_id));
        this.change(id, (s) => {
          this.movedOn(session, s, agent);
          if (by && this.quiet(tool)) return; // a subagent's failed look-up: it tries another way
          const full = this.tools.targetOf(tool, input, cwd);
          const target = (by ?? '') + (this.tools.isFileTool(tool) ? baseName(full) : full);
          this.log(s, { verb: this.tools.verbOf(tool), target, res: event.is_interrupt === true ? '中断' : '失败', bad: true });
        });
        return NO_DECISION;
      case 'Notification':
        if (event.notification_type === 'permission_prompt' && session.held.length === 0) {
          session.thereFor = agent;
          this.change(id, (s) => {
            waitThere(s);
          });
        }
        return NO_DECISION;
      case 'Stop': {
        // Its own requests end with the turn; background subagents may still be asking.
        this.releaseAll(session, '', false, (h) => h.agent === undefined);
        const waitingFor = backgroundAgents(event.background_tasks);
        this.change(id, (s) => {
          const text = str(event.last_assistant_message) ?? '';
          s.report = reportFromMarkdown(text);
          if (text) s.say = firstWords(text);
          if (session.held.length > 0) return; // a background subagent's request is on the device
          delete s.ask;
          if (waitingFor.length > 0) {
            // It ended its turn to wait for subagents working in the background; it goes
            // on when they report back (and stops again then).
            if (s.state !== 'running') s.since = this.now();
            s.state = 'running';
            const one = waitingFor.length === 1 ? waitingFor[0] : undefined;
            s.now = { verb: 'Agent', target: one ? `后台：${one}` : `后台 ${waitingFor.length} 个子代理` };
            return;
          }
          s.state = 'done';
          s.since = this.now();
          delete s.now;
        });
        return NO_DECISION;
      }
      case 'StopFailure':
        this.releaseAll(session, '', false, (h) => h.agent === undefined);
        this.change(id, (s) => {
          s.state = 'error';
          s.since = this.now();
          s.err = firstLine(str(event.error) ?? str(event.message) ?? '接口出错，停下了', 200);
          delete s.ask;
          delete s.now;
        });
        return NO_DECISION;
      case 'SessionEnd':
        this.releaseAll(session, '');
        if (session.token && session.token === run && this.options.runs?.has(session.token)) {
          // Its terminal is still open (/clear, or the agent is exiting): the run's next
          // session takes over this entry; if the terminal closes, it goes then.
          for (const [own, to] of this.aliases) if (to === id) this.aliases.delete(own);
          session.waiting = true;
          session.tail = null;
          session.rollout = null;
          session.lastText = undefined;
          return NO_DECISION;
        }
        // A one-shot run (claude -p) ends right after its report: keep that until it is seen.
        if (this.hub.get(id)?.state === 'done') session.ended = true;
        else this.forget(id);
        return NO_DECISION;
      default:
        return NO_DECISION;
    }
  }

  /** A finished tool call: log it, count it, keep its file changes. by: a subagent's ("Explore › "). */
  private record(s: SessionSnapshot, tool: string, input: Record<string, unknown>, response: unknown, cwd: string | undefined, by?: string): void {
    const result = this.tools.resultOf(tool, input, response, cwd);
    this.keep(s, tool, this.tools.targetOf(tool, input, cwd), result, by);
  }

  /** Calls that only look something up. A subagent's are counted but not logged. */
  private quiet(tool: string): boolean {
    const counter = this.tools.counterOf(tool, false);
    return counter === 'read' || (counter === null && !tool.startsWith('mcp__') && tool !== 'Agent' && tool !== 'Task');
  }

  /**
   * An event from this agent (undefined: the session's own): whatever prompt of it the
   * session waited for at the computer has been dealt with. Another agent's event says
   * nothing about it: subagents work side by side.
   */
  private movedOn(session: Session, s: SessionSnapshot, agent: string | undefined): void {
    if (s.there && session.thereFor !== agent) return;
    doneThere(s);
  }

  /** A Codex apply_patch that completed, from its session file. */
  private recordChange(s: SessionSnapshot, change: CompletedChange, cwd: string | undefined): void {
    const { target, result } = changeResult(change.files, cwd);
    this.keep(s, 'apply_patch', target, result);
    // It is done: if it is still what the session shows as running, it isn't any more.
    if (s.now?.verb === 'Edit' && s.state === 'running') delete s.now;
    doneThere(s);
  }

  private keep(s: SessionSnapshot, tool: string, target: string, result: ToolResult, by?: string): void {
    if (!by || !this.quiet(tool) || result.bad) {
      this.log(s, {
        verb: this.tools.verbOf(tool),
        target: (by ?? '') + (this.tools.isFileTool(tool) ? baseName(target) : target),
        add: result.add,
        del: result.del,
        res: result.add === undefined ? result.res : undefined,
        bad: result.bad,
      });
    }
    const counter = this.tools.counterOf(tool, result.created);
    if (counter) s.n[counter] += 1;
    s.n.add += result.add ?? 0;
    s.n.del += result.del ?? 0;
    for (const changed of result.files) {
      let file = s.files.find((f) => f.path === changed.path);
      if (!file) {
        file = { ...changed, add: 0, del: 0 };
        s.files.unshift(file);
      } else if (changed.st === 'D') {
        file.st = 'D';
      }
      file.add += changed.add;
      file.del += changed.del;
    }
    if (result.hunks.length > 0) {
      s.hunks.total += result.hunks.length;
      s.hunks.list = [...result.hunks, ...s.hunks.list].slice(0, LIMITS.hunks);
    }
  }

  // ---- held requests ----

  private hold(session: Session, held: Omit<Held, 'finish' | 'cancelTimer'>, gone?: AbortSignal): Promise<PostReply> {
    return new Promise((resolve) => {
      const onGone = () => this.release(session, entry, ANSWERED_THERE);
      const entry: Held = {
        ...held,
        finish: (reply) => {
          entry.cancelTimer();
          gone?.removeEventListener('abort', onGone);
          resolve(reply);
        },
        cancelTimer: () => {},
      };
      if (gone?.aborted) return resolve(NO_DECISION);
      gone?.addEventListener('abort', onGone, { once: true });
      session.held.push(entry);
      if (session.held.length === 1) this.show(session);
    });
  }

  /**
   * The agent got past a tool call that is still held for the device: someone answered
   * it in the terminal. Agents show their own prompt while the hook waits, so this is
   * normal; it backs up `gone` for agents that don't hang up on the hook.
   */
  private settled(session: Session, tool: string, input: Record<string, unknown>, toolUseId: string | undefined): void {
    // Only the very same call: with calls running side by side, another one of the same
    // tool finishing says nothing about this one, even on the same file. Its id if both
    // sides have one, else the same input (less the reason Codex adds to the request).
    const same = sameInput(input);
    const held =
      session.held.find((h) => toolUseId !== undefined && h.toolUseId === toolUseId) ??
      session.held.find((h) => h.tool === tool && (h.toolUseId === undefined || toolUseId === undefined) && sameInput(h.input) === same);
    if (held) this.release(session, held, ANSWERED_THERE);
  }

  /** Put the first held request on the device and start its clock. */
  private show(session: Session): void {
    const head = session.held[0];
    if (!head) return;
    const now = this.now();
    if (head.ask.kind !== 'question') head.ask.until = now + this.options.holdSeconds;
    head.cancelTimer = this.clock.after(this.options.holdSeconds * 1000, () => {
      this.release(session, head, '没等到设备回话，回电脑确认', true);
    });
    this.change(session.id, (s) => {
      s.state = head.ask.kind === 'question' ? 'question' : 'approve';
      s.since = now;
      s.ask = head.ask;
      if (head.ask.kind === 'approve') s.now = { verb: head.ask.verb, target: head.ask.target, add: head.ask.add, del: head.ask.del };
      if (head.ask.kind === 'plan') s.now = { verb: '计划', target: `${head.ask.plan[0]?.lead ?? ''}${head.ask.plan[0]?.text ?? ''}` };
    });
  }

  /** Done with the first held request: show the next one, or carry on running. */
  private advance(session: Session): void {
    session.held.shift();
    if (session.held.length > 0) {
      this.show(session);
    } else {
      this.change(session.id, (s) => {
        if (s.state === 'approve' || s.state === 'question') {
          s.state = 'running';
          s.since = this.now();
        }
        delete s.ask;
      });
    }
  }

  /** Hand a held request back to the terminal. there: it is still to be answered there, so it waits for the user. */
  private release(session: Session, held: Held, why: string, there = false): void {
    const at = session.held.indexOf(held);
    if (at < 0) return;
    held.finish(NO_DECISION);
    if (at === 0) {
      this.advance(session);
    } else {
      session.held.splice(at, 1);
    }
    if (why) {
      this.change(session.id, (s) => {
        if (there && s.state === 'running') {
          session.thereFor = held.agent;
          waitThere(s, why);
        } else {
          s.say = why;
        }
      });
    }
  }

  private releaseAll(session: Session, why: string, there = false, which: (held: Held) => boolean = () => true): void {
    for (const held of [...session.held].reverse()) if (which(held)) this.release(session, held, why, there);
  }

  /** The agent moved on: whatever prompt was up in its terminal has been answered there. */
  private releaseKeyed(session: Session): void {
    for (const held of session.held.filter((h) => h.viaKeys).reverse()) this.release(session, held, ANSWERED_THERE);
  }

  private holdPermission(
    session: Session,
    tool: string,
    input: Record<string, unknown>,
    cwd: string | undefined,
    gone?: AbortSignal,
    toolUseId?: string,
    agent?: string,
    by?: string,
  ): Promise<PostReply> {
    const managed = session.token !== null && (this.options.runs?.has(session.token) ?? false);
    if (this.options.terminalKeys && !managed) {
      // This agent can't show its own prompt while a hook waits, and this session wasn't
      // started with codetalky, so the device couldn't answer it without holding up the
      // computer. It asks at the computer straight away; the device only says so.
      const body = this.tools.askOf(tool, input, cwd);
      this.change(session.id, (s) => {
        s.now = { verb: body.verb, target: body.target, add: body.add, del: body.del };
        waitThere(s);
      });
      return Promise.resolve(NO_DECISION);
    }
    if (this.noDevice()) return Promise.resolve(NO_DECISION);
    const body = this.tools.askOf(tool, input, cwd);
    const snapshot = this.hub.get(session.id);
    // The session's last words are about its own work, not what a subagent is doing.
    if (!body.why && by) body.why = by === '子代理 › ' ? '子代理要做这一步' : `${by.slice(0, -3)} 子代理要做这一步`;
    if (!body.why && snapshot?.say) body.why = snapshot.say;
    const req = `r${this.nextReq++}`;
    const held = { req, ask: { kind: 'approve', req, ...body } as ApproveAsk, tool, target: body.target, input, toolUseId, agent };
    if (this.options.terminalKeys) {
      // The agent would not draw its own prompt while this hook waits. Let it draw it
      // now; the device answers it by pressing keys in the terminal.
      void this.hold(session, { ...held, viaKeys: true });
      return Promise.resolve(NO_DECISION);
    }
    return this.hold(session, held, gone);
  }

  private holdQuestion(session: Session, input: Record<string, unknown>, gone?: AbortSignal): Promise<PostReply> {
    if (this.noDevice()) return Promise.resolve(NO_DECISION);
    const questions = (Array.isArray(input.questions) ? input.questions : [])
      .map(obj)
      .filter((q) => typeof q.question === 'string' && Array.isArray(q.options))
      .map((q) => ({
        question: q.question as string,
        header: str(q.header),
        options: (q.options as unknown[]).map(obj).map((o) => ({ label: str(o.label) ?? '', description: str(o.description) })),
        multiSelect: q.multiSelect === true,
      }));
    if (questions.length === 0) return Promise.resolve(NO_DECISION);
    const req = `r${this.nextReq++}`;
    return this.hold(session, {
      req,
      ask: this.questionAsk(req, questions, 0),
      tool: 'AskUserQuestion',
      target: questions[0]!.question,
      questions,
      index: 0,
      answers: {},
      input,
    }, gone);
  }

  private questionAsk(req: string, questions: Question[], index: number): QuestionAsk {
    const q = questions[index]!;
    // Claude marks the option it suggests in English; the answer keeps its label as is.
    const shown = (label: string) => label.replace(/\s*\(Recommended\)\s*$/i, '（推荐）');
    const ask: QuestionAsk = {
      kind: 'question',
      req,
      text: q.question,
      options: q.options.map((o) => (o.description ? { label: shown(o.label), desc: o.description } : { label: shown(o.label) })),
    };
    if (q.multiSelect) ask.multi = true;
    const note = [questions.length > 1 ? `第 ${index + 1}/${questions.length} 题` : '', q.header ?? '', q.multiSelect ? '可以多选' : '']
      .filter(Boolean)
      .join(' · ');
    if (note) ask.note = note;
    return ask;
  }

  /** Claude finished planning and wants to start: show the plan, approve it or send it back. */
  private holdPlan(session: Session, input: Record<string, unknown>, gone?: AbortSignal): Promise<PostReply> {
    if (this.noDevice()) return Promise.resolve(NO_DECISION);
    const text = str(input.plan) ?? '';
    const req = `r${this.nextReq++}`;
    const plan = reportFromMarkdown(text);
    const ask: PlanAsk = { kind: 'plan', req, plan: plan.length > 0 ? plan : [{ text: '（计划是空的，详情回电脑看）' }] };
    return this.hold(session, { req, ask, tool: 'ExitPlanMode', target: '计划', input }, gone);
  }

  private decide(id: string, req: string, allow: boolean, text?: string): void {
    const session = this.sessions.get(id);
    const head = session?.held[0];
    if (!session || !head || head.req !== req || (head.ask.kind !== 'approve' && head.ask.kind !== 'plan')) return;
    if (head.ask.kind === 'plan') {
      head.finish({
        status: 200,
        body: {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: allow
              ? {
                  behavior: 'allow',
                  updatedInput: head.input,
                  updatedPermissions: [{ type: 'setMode', mode: PLAN_APPROVED_MODE, destination: 'session' }],
                }
              : {
                  behavior: 'deny',
                  message: text
                    ? `用户在 CodeTalky 设备上看了计划，要你改：${text}`
                    : '用户在 CodeTalky 设备上没有批准这个计划。请继续完善，改好后再提交。',
                },
          },
        },
      });
      this.change(id, (s) => this.log(s, allow ? { verb: '计划', target: '已批准' } : { verb: '计划', target: text ? `打回：${text}` : '打回重做', bad: true }));
      this.advance(session);
      return;
    }
    if (head.viaKeys) {
      // The answer is a key pressed in the terminal, and only on this request's own
      // prompt: it counts once the launcher has pressed it, not before.
      if (head.pressing) return;
      head.pressing = true;
      const keys = this.options.terminalKeys!;
      const token = session.token;
      const pressed = token ? this.options.runs!.press(token, allow ? keys.allow : keys.deny, keys.expect, needleOf(head)) : Promise.resolve(false);
      void pressed.then((ok) => {
        if (!session.held.includes(head)) return; // answered at the computer meanwhile
        if (!ok) {
          this.release(session, head, '终端里没找到这个确认框，回电脑确认', true);
          return;
        }
        head.finish(NO_DECISION);
        this.change(id, (s) => {
          if (!allow) this.log(s, { verb: this.tools.verbOf(head.tool), target: head.target, res: '已拒绝', bad: true });
        });
        this.advance(session);
        if (allow) return;
        this.change(id, (s) => {
          if ((s.state === 'running' || s.state === 'idle') && session.held.length === 0) {
            // Saying no to its prompt stops the turn; it waits for the next instruction (and fires no Stop).
            s.state = 'idle';
            s.since = this.now();
            delete s.now;
            s.say = '已拒绝，它停下来了，等你的下一条指令';
          }
        });
      });
      return;
    }
    head.finish({
      status: 200,
      body: {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: allow ? { behavior: 'allow' } : { behavior: 'deny', message: '用户在 CodeTalky 设备上拒绝了这一步。' },
        },
      },
    });
    this.change(id, (s) => {
      if (!allow) this.log(s, { verb: this.tools.verbOf(head.tool), target: head.target, res: '已拒绝', bad: true });
    });
    this.advance(session);
  }

  private answer(id: string, req: string, choice: Choice): void {
    const session = this.sessions.get(id);
    const head = session?.held[0];
    if (!session || !head || head.req !== req || !head.questions || head.index === undefined || !head.answers) return;
    const q = head.questions[head.index]!;
    // Claude's own format: the option's label; several joined with commas; or the user's words.
    let said: string;
    if ('text' in choice) {
      said = choice.text;
    } else {
      const picked = 'option' in choice ? [choice.option] : choice.options;
      const labels = picked.map((i) => q.options[i]?.label);
      if (labels.length === 0 || labels.some((l) => l === undefined)) return;
      said = labels.join(', ');
    }
    head.answers[q.question] = said;
    this.change(id, (s) => this.log(s, { verb: '答', target: said }));
    if (head.index + 1 < head.questions.length) {
      // Next question of the same call, under a new request id.
      head.index++;
      head.req = `r${this.nextReq++}`;
      head.ask = this.questionAsk(head.req, head.questions, head.index);
      this.change(id, (s) => {
        s.since = this.now();
        s.ask = head.ask;
      });
      return;
    }
    head.finish({
      status: 200,
      body: {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...head.input, answers: head.answers },
        },
      },
    });
    this.advance(session);
  }

  /**
   * A run's terminal turned out to run this session, which was on the device already
   * (resumed with --resume or /resume, 2026-11-16): the entry the run put up while
   * waiting for its first session is not needed. What was sent to it goes along.
   */
  private dropPlaceholders(session: Session, run: string): void {
    for (const other of [...this.sessions.values()]) {
      if (other === session || !other.waiting || other.token !== run) continue;
      session.queued.push(...other.queued);
      session.urgent.push(...other.urgent);
      session.steered.push(...other.steered);
      for (const [own, to] of this.aliases) if (to === other.id) this.aliases.delete(own);
      this.forget(other.id);
      this.options.log(`${this.agent} run ${run.slice(0, 8)} took up session ${session.id.slice(0, 8)}`);
    }
  }

  private forget(id: string): void {
    this.sessions.get(id)?.typed?.();
    this.sessions.delete(id);
    this.hub.remove(id);
  }

  private scheduleSweep(): () => void {
    return this.clock.after(SWEEP_EVERY_MS, () => {
      const cutoff = this.now() - FORGET_AFTER_S;
      for (const [id, session] of this.sessions) {
        // A terminal started with codetalky that is still open keeps its session, however quiet.
        const open = session.token !== null && (this.options.runs?.has(session.token) ?? false);
        if (session.lastEvent < cutoff && session.held.length === 0 && !open) this.forget(id);
      }
      this.cancelSweep = this.scheduleSweep();
    });
  }

  /** Codex: while a session works, read its file between hooks too (what it says, an interrupted turn). */
  private schedulePoll(): () => void {
    return this.clock.after(POLL_MS, () => {
      for (const session of this.sessions.values()) {
        const state = this.hub.get(session.id)?.state;
        if (state === 'running' || state === 'approve') this.readRollout(session);
      }
      this.cancelPoll = this.schedulePoll();
    });
  }
}
