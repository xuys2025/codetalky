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

import { LIMITS, type ApproveAsk, type QuestionAsk, type SessionSnapshot } from '../protocol.ts';
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

type Event = Record<string, unknown> & { session_id: string; hook_event_name: string };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

const firstLine = (text: string, max = 120) => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
}

/** A request held open for the device. Only the first one in a session's queue is shown. */
interface Held {
  req: string;
  /** What the device sees while this request is shown. */
  ask: ApproveAsk | QuestionAsk;
  tool: string;
  target: string;
  /** For AskUserQuestion: all its questions, the one shown, and answers so far. */
  questions?: Question[];
  index?: number;
  answers?: Record<string, string>;
  input: Record<string, unknown>;
  /** Not held: the agent's own prompt is up in the terminal, and the device answers it with keys. */
  viaKeys?: boolean;
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
}

const emptyCounts = () => ({ read: 0, edit: 0, new: 0, cmd: 0, add: 0, del: 0 });

export class ClaudeSource {
  private readonly hub: Hub;
  private readonly clock: Clock;
  private readonly options: ClaudeOptions;
  private readonly agent: 'claude' | 'codex';
  private readonly tools: ToolKit;
  private readonly sessions = new Map<string, Session>();
  /** The agent's session id -> the device's, where they differ (a managed run's entry was there first). */
  private readonly aliases = new Map<string, string>();
  private nextReq = 1;
  private cancelSweep: () => void;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeRuns: () => void;

  constructor(hub: Hub, clock: Clock, options: ClaudeOptions) {
    this.hub = hub;
    this.clock = clock;
    this.options = options;
    this.agent = options.agent ?? 'claude';
    this.tools = options.tools ?? claudeTools;
    this.cancelSweep = this.scheduleSweep();
    this.unsubscribe = hub.subscribe((event) => {
      // The last device left: give every held request back to the terminal.
      if (event.type === 'devices' && hub.devices() === 0) {
        for (const session of this.sessions.values()) this.releaseAll(session, '设备断开了，回电脑确认');
      }
      // An ended session's report has been seen: it can go now.
      if (event.type === 'changed' && this.sessions.get(event.id)?.ended && hub.get(event.id)?.state === 'idle') {
        this.forget(event.id);
      }
    });
    this.unsubscribeRuns = options.runs?.subscribe((event) => this.onRun(event)) ?? (() => {});
  }

  /** A managed terminal opened or closed. */
  private onRun(event: RunEvent): void {
    if (event.type === 'started' && event.agent === this.agent) {
      this.waitFor(event.run, event.cwd);
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
      lastEvent: this.now(),
      held: [],
      ended: false,
      token: run,
      waiting: true,
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
        decide: (req, allow) => this.decide(id, req, allow),
        answer: (req, option) => this.answer(id, req, option),
        reply: (text) => this.reply(id, text),
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
    this.unsubscribe();
    this.unsubscribeRuns();
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

  /** The run token from a session's hooks. While that run's launcher is connected the device can type into it. */
  private setToken(session: Session, token: string | null): void {
    session.token = token;
    const managed = token !== null && (this.options.runs?.has(token) ?? false);
    if (this.hub.get(session.id)?.reply !== managed) {
      this.change(session.id, (s) => {
        s.reply = managed;
      });
    }
  }

  private reply(id: string, text: string): void {
    const token = this.sessions.get(id)?.token;
    // Claude Code reports the prompt through UserPromptSubmit, which logs it.
    if (token) this.options.runs?.type(token, text);
  }

  private now(): number {
    return this.hub.nowSeconds();
  }

  private change(id: string, fn: (s: SessionSnapshot) => void): void {
    this.hub.update(id, fn);
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
        lastEvent: this.now(),
        held: [],
        ended: false,
        token: null,
        waiting: false,
      };
      this.sessions.set(id, session);
      this.put(id, cwd, false); // replies stay off until a managed run claims it
      this.options.log(`${this.agent} session ${id.slice(0, 8)} in ${cwd ?? '?'}`);
    }
    this.attach(session, transcript);
    session.lastEvent = this.now();
    if (run !== session.token) this.setToken(session, run);
    // What hooks don't say: model, branch, the latest thing the agent wrote, and for
    // Codex the files apply_patch changed.
    const state = session.tail?.update();
    const changes = session.rollout?.update() ?? [];
    const text = state?.text ?? session.rollout?.text;
    this.change(id, (s) => {
      const model = str(event.model) ?? state?.model;
      if (model) s.model = shortModel(model);
      if (state?.branch) s.branch = state.branch;
      if (text && text !== session.lastText) {
        session.lastText = text;
        s.say = firstWords(text);
      }
      for (const change of changes) this.recordChange(s, change, cwd);
    });
    return session;
  }

  private async dispatch(event: Event, run: string | null, gone?: AbortSignal): Promise<PostReply> {
    const session = this.session(event, run);
    const id = session.id;
    const cwd = str(event.cwd);
    const raw = { tool: str(event.tool_name) ?? '', input: obj(event.tool_input) };
    const { tool, input } = this.tools.normalize?.(raw.tool, raw.input) ?? raw;
    switch (event.hook_event_name) {
      case 'SessionStart':
        return NO_DECISION;
      case 'UserPromptSubmit':
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
          this.log(s, { verb: '你', target: firstLine(str(event.prompt) ?? '') });
        });
        return NO_DECISION;
      case 'PreToolUse':
        if (tool === 'AskUserQuestion') return this.holdQuestion(session, input, gone);
        // The next tool call: the terminal prompt before it has been answered.
        this.releaseKeyed(session);
        this.change(id, (s) => {
          if (s.state !== 'approve' && s.state !== 'question' && s.state !== 'running') {
            s.state = 'running';
            s.since = this.now();
          }
          if (tool === 'TodoWrite') {
            const todos = todosFrom(input);
            if (todos) s.todos = todos;
          } else {
            s.now = { verb: this.tools.verbOf(tool), target: this.tools.targetOf(tool, input, cwd) };
          }
        });
        return NO_DECISION;
      case 'PermissionRequest':
        if (tool === 'AskUserQuestion' || tool === 'ExitPlanMode') return NO_DECISION;
        return this.holdPermission(session, tool, input, cwd, gone);
      case 'PostToolUse':
        this.settled(session, tool, input);
        if (tool === 'TodoWrite' || tool === 'AskUserQuestion') return NO_DECISION;
        // Codex's session file has its file changes, with the exact diff.
        if (session.rollout && this.tools.isFileTool(tool)) return NO_DECISION;
        this.change(id, (s) => this.record(s, tool, input, event.tool_response, cwd));
        return NO_DECISION;
      case 'PostToolUseFailure':
        this.settled(session, tool, input);
        this.change(id, (s) => {
          const full = this.tools.targetOf(tool, input, cwd);
          const target = this.tools.isFileTool(tool) ? baseName(full) : full;
          this.log(s, { verb: this.tools.verbOf(tool), target, res: event.is_interrupt === true ? '中断' : '失败', bad: true });
        });
        return NO_DECISION;
      case 'Notification':
        if (event.notification_type === 'permission_prompt' && session.held.length === 0) {
          this.change(id, (s) => {
            s.say = '在电脑终端里等你确认';
          });
        }
        return NO_DECISION;
      case 'Stop':
        this.releaseAll(session, '');
        this.change(id, (s) => {
          const text = str(event.last_assistant_message) ?? '';
          s.state = 'done';
          s.since = this.now();
          s.report = reportFromMarkdown(text);
          if (text) s.say = firstWords(text);
          delete s.ask;
          delete s.now;
        });
        return NO_DECISION;
      case 'StopFailure':
        this.releaseAll(session, '');
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

  /** A finished tool call: log it, count it, keep its file changes. */
  private record(s: SessionSnapshot, tool: string, input: Record<string, unknown>, response: unknown, cwd: string | undefined): void {
    const result = this.tools.resultOf(tool, input, response, cwd);
    this.keep(s, tool, this.tools.targetOf(tool, input, cwd), result);
  }

  /** A Codex apply_patch that completed, from its session file. */
  private recordChange(s: SessionSnapshot, change: CompletedChange, cwd: string | undefined): void {
    const { target, result } = changeResult(change.files, cwd);
    this.keep(s, 'apply_patch', target, result);
    // It is done: if it is still what the session shows as running, it isn't any more.
    if (s.now?.verb === 'Edit' && s.state === 'running') delete s.now;
  }

  private keep(s: SessionSnapshot, tool: string, target: string, result: ToolResult): void {
    this.log(s, {
      verb: this.tools.verbOf(tool),
      target: this.tools.isFileTool(tool) ? baseName(target) : target,
      add: result.add,
      del: result.del,
      res: result.add === undefined ? result.res : undefined,
      bad: result.bad,
    });
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
  private settled(session: Session, tool: string, input: Record<string, unknown>): void {
    const same = JSON.stringify(input);
    const held = session.held.find((h) => h.tool === tool && JSON.stringify(h.input) === same) ?? session.held.find((h) => h.tool === tool);
    if (held) this.release(session, held, ANSWERED_THERE);
  }

  /** Put the first held request on the device and start its clock. */
  private show(session: Session): void {
    const head = session.held[0];
    if (!head) return;
    const now = this.now();
    if (head.ask.kind === 'approve') head.ask.until = now + this.options.holdSeconds;
    head.cancelTimer = this.clock.after(this.options.holdSeconds * 1000, () => {
      this.release(session, head, '没等到设备回话，回电脑确认');
    });
    this.change(session.id, (s) => {
      s.state = head.ask.kind === 'approve' ? 'approve' : 'question';
      s.since = now;
      s.ask = head.ask;
      if (head.ask.kind === 'approve') s.now = { verb: head.ask.verb, target: head.ask.target, add: head.ask.add, del: head.ask.del };
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

  /** Hand a held request back to the terminal. */
  private release(session: Session, held: Held, why: string): void {
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
        s.say = why;
      });
    }
  }

  private releaseAll(session: Session, why: string): void {
    for (const held of [...session.held].reverse()) this.release(session, held, why);
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
  ): Promise<PostReply> {
    if (this.hub.devices() === 0) return Promise.resolve(NO_DECISION);
    const body = this.tools.askOf(tool, input, cwd);
    const snapshot = this.hub.get(session.id);
    if (!body.why && snapshot?.say) body.why = snapshot.say;
    const req = `r${this.nextReq++}`;
    const held = { req, ask: { kind: 'approve', req, ...body } as ApproveAsk, tool, target: body.target, input };
    if (this.options.terminalKeys && session.token && this.options.runs?.has(session.token)) {
      // The agent would not draw its own prompt while this hook waits. Let it draw it
      // now; the device answers it by pressing keys in the terminal.
      void this.hold(session, { ...held, viaKeys: true });
      return Promise.resolve(NO_DECISION);
    }
    return this.hold(session, held, gone);
  }

  private holdQuestion(session: Session, input: Record<string, unknown>, gone?: AbortSignal): Promise<PostReply> {
    if (this.hub.devices() === 0) return Promise.resolve(NO_DECISION);
    const questions = (Array.isArray(input.questions) ? input.questions : [])
      .map(obj)
      .filter((q) => typeof q.question === 'string' && Array.isArray(q.options))
      .map((q) => ({
        question: q.question as string,
        header: str(q.header),
        options: (q.options as unknown[]).map(obj).map((o) => ({ label: str(o.label) ?? '', description: str(o.description) })),
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
    const ask: QuestionAsk = {
      kind: 'question',
      req,
      text: q.question,
      options: q.options.map((o) => (o.description ? { label: o.label, desc: o.description } : { label: o.label })),
    };
    const note = [questions.length > 1 ? `第 ${index + 1}/${questions.length} 题` : '', q.header ?? ''].filter(Boolean).join(' · ');
    if (note) ask.note = note;
    return ask;
  }

  private decide(id: string, req: string, allow: boolean): void {
    const session = this.sessions.get(id);
    const head = session?.held[0];
    if (!session || !head || head.req !== req || head.ask.kind !== 'approve') return;
    if (head.viaKeys) {
      const keys = this.options.terminalKeys!;
      const token = session.token;
      head.finish(NO_DECISION);
      this.change(id, (s) => {
        if (!allow) this.log(s, { verb: this.tools.verbOf(head.tool), target: head.target, res: '已拒绝', bad: true });
      });
      this.advance(session);
      const pressed = token ? this.options.runs!.press(token, allow ? keys.allow : keys.deny, keys.expect) : Promise.resolve(false);
      void pressed.then((ok) => {
        this.change(id, (s) => {
          if (!ok) {
            s.say = '终端里已经没有这个确认框了，没有按';
          } else if (!allow && s.state === 'running' && session.held.length === 0) {
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

  private answer(id: string, req: string, option: number): void {
    const session = this.sessions.get(id);
    const head = session?.held[0];
    if (!session || !head || head.req !== req || !head.questions || head.index === undefined || !head.answers) return;
    const q = head.questions[head.index]!;
    const chosen = q.options[option];
    if (!chosen) return;
    head.answers[q.question] = chosen.label;
    this.change(id, (s) => this.log(s, { verb: '答', target: chosen.label }));
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

  private forget(id: string): void {
    this.sessions.delete(id);
    this.hub.remove(id);
  }

  private scheduleSweep(): () => void {
    return this.clock.after(SWEEP_EVERY_MS, () => {
      const cutoff = this.now() - FORGET_AFTER_S;
      for (const [id, session] of this.sessions) {
        if (session.lastEvent < cutoff && session.held.length === 0) this.forget(id);
      }
      this.cancelSweep = this.scheduleSweep();
    });
  }
}
