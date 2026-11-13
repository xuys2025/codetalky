// The six demo sessions: the same projects as the design mockups. Each one opens
// with a history that adds up (counters, files and hunks come from replaying it),
// and a script that carries on when you approve, deny, answer or reply on the device.

import type { Hunk, Para, SessionSnapshot } from '../protocol.ts';
import { recordSay, recordTool, type FakeScript, type Step, type ToolStep } from './engine.ts';

const MIN = 60;

// ---- step builders --------------------------------------------------------

function hunk(path: string, line: number, lines: string[], add?: number, del?: number): Hunk {
  return {
    file: path,
    line,
    add: add ?? lines.filter((l) => l.startsWith('+')).length,
    del: del ?? lines.filter((l) => l.startsWith('-')).length,
    lines,
  };
}

const read = (path: string, lines: number, takes = 2): ToolStep => ({
  do: 'tool',
  verb: 'Read',
  target: path,
  takes,
  res: `${lines} 行`,
});
const grep = (pattern: string, hits: number): ToolStep => ({
  do: 'tool',
  verb: 'Grep',
  target: pattern,
  takes: 2,
  res: `${hits} 处`,
});
const glob = (pattern: string, files: number): ToolStep => ({
  do: 'tool',
  verb: 'Glob',
  target: pattern,
  takes: 1,
  res: `${files} 个`,
});

function edit(path: string, add: number, del: number, at?: { line: number; lines: string[] }, takes = 4): ToolStep {
  const step: ToolStep = { do: 'tool', verb: 'Edit', target: path, takes, add, del };
  if (at) step.hunk = hunk(path, at.line, at.lines);
  return step;
}

/** A new file; `lines` is how it starts, all of them '+' lines. */
function write(path: string, add: number, lines?: string[], takes = 5): ToolStep {
  const step: ToolStep = { do: 'tool', verb: 'Write', target: path, takes, add };
  if (lines) step.hunk = hunk(path, 1, lines, add, 0);
  return step;
}

function bash(command: string, res: string, takes = 6, bad = false): ToolStep {
  const step: ToolStep = { do: 'tool', verb: 'Bash', target: command, takes, res };
  if (bad) step.bad = true;
  return step;
}

type SayStep = Extract<Step, { do: 'say' }>;
const say = (text: string): SayStep => ({ do: 'say', text });
const todo = (done: number): Step => ({ do: 'todo', done });
const done = (report: Para[], ago?: number): Step => (ago ? { do: 'done', report, ago } : { do: 'done', report });

/** Report helpers: a plain paragraph, and a bullet with a bold lead. */
const p = (text: string): Para => ({ text });
const li = (lead: string, text: string): Para => (lead ? { b: true, lead, text: `：${text}` } : { b: true, text });

// ---- session history ------------------------------------------------------

type Past = [secondsAgo: number, step: ToolStep | SayStep];

interface Info {
  id: string;
  agent: 'claude' | 'codex';
  model: string;
  branch: string;
  reply?: boolean;
}

/** Build the opening snapshot by replaying what the agent did before t0, oldest first. */
function opening(t0: number, info: Info, past: Past[], extra: Partial<SessionSnapshot>): SessionSnapshot {
  const s: SessionSnapshot = {
    id: info.id,
    name: info.id,
    agent: info.agent,
    model: info.model,
    branch: info.branch,
    state: 'running',
    since: t0,
    started: t0 - (past[0]?.[0] ?? 0) - 30,
    reply: info.reply ?? true,
    n: { read: 0, edit: 0, new: 0, cmd: 0, add: 0, del: 0 },
    log: [],
    files: [],
    hunks: { total: 0, list: [] },
  };
  for (const [ago, step] of past) {
    if (step.do === 'tool') {
      recordTool(s, t0 - ago, step);
      s.now = { verb: step.verb, target: step.target, add: step.add, del: step.del };
    } else {
      recordSay(s, t0 - ago, step.text);
    }
  }
  return Object.assign(s, extra);
}

// ---- what happens after the script runs out ------------------------------

interface Follow {
  test: string;
  commit: string;
  /** The natural next task, done the first time the user says to carry on. */
  next: Step[];
}

function followUp(f: Follow): (text: string) => Step[] {
  let next: Step[] | null = f.next.length > 0 ? f.next : null;
  return (text) => {
    switch (text) {
      case '跑一下测试':
        return [say('好，把测试全部跑一遍。'), bash(f.test, '全部通过', 10), done([p('测试全部通过。'), p('这次没有改动代码。')])];
      case '提交这些改动':
        return [
          bash('git diff --stat', '看过了', 2),
          bash(`git commit -am "${f.commit}"`, '已提交', 2),
          done([p('改动已经提交，还没推送。'), li('提交说明', f.commit)]),
        ];
      case '先停一下，等我回电脑':
        return [say('好，停在这里，等你回来。'), done([p('已经停下，没有再改东西。'), p('回到电脑后在终端里接着说就行。')])];
      case '撤销刚才的修改':
        return [
          say('好，把还没提交的修改撤掉。'),
          bash('git restore .', '已撤销', 2),
          bash(f.test, '全部通过', 10),
          done([p('还没提交的修改都撤掉了，测试照样通过。')]),
        ];
      default: {
        const echo = text === '继续下一步' ? [] : [say(`收到：${text}`)];
        if (next) {
          const steps = next;
          next = null;
          return [...echo, ...steps];
        }
        return [
          ...echo,
          say('手上没有别的待办了，我把改动再检查一遍。'),
          bash('git diff --stat', '看过了', 2),
          bash(f.test, '全部通过', 10),
          done([p('检查了一遍，没发现问题。'), p('要做别的就直接告诉我。')]),
        ];
      }
    }
  };
}

// ---- codetalky: waiting for approval -------------------------------------

const HOOKS_TIMEOUT = [
  ' // 等设备回话的最长时间',
  '-const TIMEOUT_S = 60;',
  '+const TIMEOUT_S = 600;',
  '+// 没带会话号的请求分不清是哪个终端发来的，直接拒绝，免得在设备上批准到别处去',
  ' export async function onAsk(req) {',
  '+  if (!req.sessionId) {',
  "+    return deny('no session: this request did not say which terminal it came from');",
  '+  }',
  '   const card = toCard(req);',
  '-  const answer = await device.ask(card);',
  '+  const answer = await device.ask(card, { timeoutMs: TIMEOUT_S * 1000, onTimeout: () => backToTerminal(req, card.id) });',
  '+  log.info(`answered ${card.id} from ${answer.from} after ${answer.tookMs} ms: ${answer.allow ? "allow" : "deny"}`);',
  '   return answer;',
  ' }',
];

const HOOKS_SESSION_ONLY = [
  ' export async function onAsk(req) {',
  '+  if (!req.sessionId) {',
  "+    return deny('no session');",
  '+  }',
  '   const card = toCard(req);',
];

function codetalky(): FakeScript {
  return {
    initial: (t0) =>
      opening(
        t0,
        { id: 'codetalky', agent: 'claude', model: 'opus-5.5', branch: 'feat/hooks' },
        [
          [26 * MIN, say('先把钩子的进出数据理清楚，再接设备。')],
          [25.5 * MIN, read('src/bridge/hooks.ts', 142)],
          [25 * MIN, read('src/bridge/server.ts', 230)],
          [24.5 * MIN, grep('TIMEOUT', 6)],
          [24 * MIN, read('docs/hooks.md', 88)],
          [23 * MIN, read('src/bridge/session.ts', 176)],
          [22.5 * MIN, glob('src/bridge/**/*.ts', 9)],
          [22 * MIN, read('src/bridge/types.ts', 64)],
          [
            21 * MIN,
            edit('src/bridge/types.ts', 8, 2, {
              line: 12,
              lines: [
                ' export interface Session {',
                '   id: string;',
                '-  status: string;',
                '+  state: SessionState;',
                '+  since: number;',
                '+  ask?: PendingAsk;',
                '   cwd: string;',
                ' }',
              ],
            }),
          ],
          [
            19 * MIN,
            write('src/bridge/cards.ts', 38, [
              '+// 把会话转成设备上的一张卡片',
              "+import { Session } from './types.ts';",
              '+',
              '+export function toCard(s: Session) {',
              '+  return {',
              '+    id: s.id,',
              '+    state: s.state,',
              '+    since: s.since,',
              '+    now: s.now && pick(s.now),',
              '+  };',
              '+}',
            ]),
          ],
          [
            17 * MIN,
            edit('src/bridge/session.ts', 8, 9, {
              line: 88,
              lines: [
                '   onHook(evt) {',
                '-    const s = this.find(evt.cwd);',
                '-    if (!s) return;',
                '-    s.status = evt.type;',
                '+    const s = this.byId.get(evt.id);',
                '+    if (!s) return this.adopt(evt);',
                '+    s.state = toState(evt);',
                '+    s.since = now();',
                '     this.emit(s);',
                '   }',
              ],
            }),
          ],
          [
            14 * MIN,
            edit('src/bridge/server.ts', 32, 10, {
              line: 57,
              lines: [
                " r.post('/hook', async (req, res) => {",
                '-  const evt = req.body;',
                '+  const evt = parseHook(req.body);',
                '+  if (!evt) return bad(res);',
                '   sessions.onHook(evt);',
                '-  res.json({});',
                '+  res.json(await sessions.wait(evt));',
                ' });',
              ],
            }),
          ],
          [12 * MIN, bash('npm run check', '通过', 8)],
          [11 * MIN, read('test/session.test.ts', 96)],
          [10 * MIN, bash('npm test', '14 个全过', 9)],
          [8 * MIN, read('src/bridge/hooks.ts', 142)],
          [7 * MIN, grep('sessionId', 11)],
          [6 * MIN, read('docs/permission-hook.md', 54)],
          [4 * MIN, read('src/bridge/device.ts', 120)],
          [3 * MIN, say('等待时间只有 60 秒，在设备上来不及点。准备改成 600 秒，顺便拒绝没带会话号的请求。')],
        ],
        {
          ctx: 38,
          todos: { done: 2, items: ['读钩子和服务端代码', '把会话转成设备卡片', '延长批准的等待时间', '补测试', '跑测试并提交'] },
        },
      ),
    steps: [
      {
        do: 'approve',
        ago: 2 * MIN,
        ask: {
          verb: 'Edit',
          target: 'src/bridge/hooks.ts',
          add: 7,
          del: 2,
          line: 41,
          lines: HOOKS_TIMEOUT,
          why: '60 秒太短，在设备上来不及点。改成 600 秒，并拒绝没带会话号的请求。',
        },
        allow: [
          edit('src/bridge/hooks.ts', 7, 2, { line: 41, lines: HOOKS_TIMEOUT }, 3),
          todo(3),
          say('改好了。再补两条测试：超时之内能批准，没带会话号会被拒绝。'),
          write(
            'test/hooks.test.ts',
            46,
            [
              "+import { test } from 'node:test';",
              "+import assert from 'node:assert';",
              "+import { hook } from './helpers.ts';",
              '+',
              "+test('没有会话号', async () => {",
              "+  const r = await hook({});",
              "+  assert.equal(r.decision, 'allow');",
              '+});',
            ],
            6,
          ),
          bash('npm test', '失败 1', 9, true),
          say('有一条断言写反了，应该是拒绝。'),
          edit(
            'test/hooks.test.ts',
            1,
            1,
            {
              line: 6,
              lines: [
                "   const r = await hook({});",
                "-  assert.equal(r.decision, 'allow');",
                "+  assert.equal(r.decision, 'deny');",
                ' });',
              ],
            },
            3,
          ),
          bash('npm test', '16 个全过', 8),
          todo(4),
          bash('git commit -am "钩子等待改为 600 秒"', '已提交', 2),
          todo(5),
          done([
            p('设备上的批准现在来得及点了。'),
            p('这次改了这些：'),
            li('等待时间', '钩子等设备回话从 60 秒改成 600 秒，超时后照旧回到终端确认。'),
            li('会话号', '没带会话号的请求直接拒绝，不会批准到别的会话上。'),
            li('测试', '新增 2 个，共 16 个，全部通过。'),
            p('已经提交到 feat/hooks，还没推送。要推吗？'),
          ]),
        ],
        deny: [
          say('好，等待时间先不动。只加会话号检查，这一处不影响现有流程。'),
          {
            do: 'approve',
            ask: {
              verb: 'Edit',
              target: 'src/bridge/hooks.ts',
              add: 3,
              del: 0,
              line: 44,
              lines: HOOKS_SESSION_ONLY,
              why: '只拒绝没带会话号的请求，等待时间保持 60 秒。',
            },
            allow: [
              edit('src/bridge/hooks.ts', 3, 0, { line: 44, lines: HOOKS_SESSION_ONLY }, 3),
              edit('test/session.test.ts', 12, 0),
              bash('npm test', '15 个全过', 8),
              todo(5),
              done([
                p('按你的意思，等待时间没改。'),
                p('这次改了这些：'),
                li('会话号', '没带会话号的请求直接拒绝。'),
                li('测试', '新增 1 个，共 15 个，全部通过。'),
                p('60 秒在设备上可能来不及点，之后想改随时说。'),
              ]),
            ],
            deny: [
              say('这一处也先不动，想法记在 TODO.md 里。'),
              write('TODO.md', 4),
              done([
                p('钩子代码没有改。'),
                p('两个想法记在 TODO.md：'),
                li('', '等待时间从 60 秒改成 600 秒。'),
                li('', '拒绝没带会话号的请求。'),
                p('回到电脑后可以再看。'),
              ]),
            ],
          },
        ],
      },
    ],
    followUp: followUp({
      test: 'npm test',
      commit: '钩子等待改为 600 秒',
      next: [
        say('接下来把设备上的回答传回终端。'),
        read('src/bridge/device.ts', 120),
        edit('src/bridge/device.ts', 14, 3, {
          line: 66,
          lines: [
            "   ws.on('message', (data) => {",
            '-    log(data);',
            '+    const act = parseAction(data);',
            '+    if (!act) return;',
            '+    sessions.resolve(act.id, act);',
            '   });',
          ],
        }),
        bash('npm test', '16 个全过', 8),
        done([
          p('设备上点的批准和回答，现在会传回对应的终端。'),
          li('设备连接', '收到动作先核对会话号，再交给那个会话。'),
          li('测试', '16 个全部通过。'),
          p('还没提交。'),
        ]),
      ],
    }),
  };
}

// ---- blog-engine: waiting for an answer ----------------------------------

function blogEngine(): FakeScript {
  return {
    initial: (t0) =>
      opening(
        t0,
        { id: 'blog-engine', agent: 'codex', model: 'gpt-5', branch: 'main' },
        [
          [14 * MIN, say('先看列表页的筛选现在是怎么存的。')],
          [13.5 * MIN, read('src/pages/posts/List.tsx', 210)],
          [13 * MIN, grep('useFilters', 5)],
          [12.5 * MIN, read('src/hooks/useFilters.ts', 74)],
          [12 * MIN, read('src/api/posts.ts', 130)],
          [11 * MIN, glob('src/**/*filter*', 4)],
          [10 * MIN, read('prisma/schema.prisma', 96)],
          [9 * MIN, read('docs/ARCHITECTURE.md', 140)],
          [8 * MIN, bash('git log --oneline -5', '5 条', 2)],
          [6 * MIN, say('筛选条件现在只在内存里，刷新页面就丢了。存哪里有三种做法，先问一下再动手。')],
        ],
        {
          ctx: 21,
          todos: { done: 1, items: ['看列表页的筛选是怎么做的', '定下存在哪里', '实现保存和恢复', '补测试'] },
        },
      ),
    steps: [
      {
        do: 'question',
        ago: 5 * MIN,
        text: '用户保存的筛选条件，存在哪里？',
        note: '列表页要记住每个用户上次的筛选，三种做法成本不一样。',
        options: [
          {
            label: '浏览器本地',
            desc: '最简单，换设备就没了',
            then: [
              todo(2),
              say('用浏览器本地存储，按用户分开存。'),
              write('src/lib/filterStore.ts', 31, [
                '+// 按用户分开存筛选条件',
                '+const key = (uid: string) =>',
                '+  `filters:${uid}`;',
                '+',
                '+export function load(uid: string) {',
                '+  const raw =',
                '+    localStorage.getItem(key(uid));',
                '+  try {',
                '+    return JSON.parse(raw ?? "");',
                '+  } catch {',
                '+    return null;',
                '+  }',
                '+}',
              ]),
              edit('src/hooks/useFilters.ts', 18, 6, {
                line: 9,
                lines: [
                  ' export function useFilters(uid) {',
                  '-  const [f, setF] = useState(EMPTY);',
                  '+  const [f, setF] = useState(',
                  '+    () => load(uid) ?? EMPTY);',
                  '+  useEffect(() => save(uid, f), [f]);',
                  '   return [f, setF];',
                ],
              }),
              {
                do: 'question',
                text: '除了筛选条件，列表页还要记住哪些？',
                note: '可以多选，存的方法一样。',
                multi: true,
                options: [
                  { label: '排序方式', desc: '按时间还是按热度', then: [] },
                  { label: '每页条数', then: [] },
                  { label: '展开的分组', desc: '左侧哪些分组是打开的', then: [] },
                ],
              },
              say('好，这几样一起存。'),
              todo(3),
              write('src/lib/filterStore.test.ts', 40),
              bash('pnpm test', '9 个全过', 9),
              todo(4),
              done([
                p('列表页会记住上次的筛选了，存在浏览器本地。'),
                p('这次改了这些：'),
                li('存储', '新增 filterStore，按用户分开存，坏数据直接丢弃。'),
                li('列表页', '打开时读回上次的筛选，改动时自动保存。'),
                li('测试', '新增 3 个，共 9 个，全部通过。'),
                p('换浏览器或清缓存就会丢，这是这种做法本来的限制。'),
              ]),
            ],
          },
          {
            label: '数据库里加一张表',
            desc: '跨设备，要写迁移',
            then: [
              todo(2),
              say('加一张 saved_filters 表，先写迁移。'),
              edit('prisma/schema.prisma', 11, 0, {
                line: 88,
                lines: [
                  '+model SavedFilter {',
                  '+  userId    String   @id',
                  '+  filters   Json',
                  '+  updatedAt DateTime @updatedAt',
                  '+  user      User     @relation(',
                  '+    fields: [userId],',
                  '+    references: [id])',
                  '+}',
                ],
              }),
              bash('pnpm prisma migrate dev', '已迁移', 10),
              write('src/api/filters.ts', 52),
              edit('src/hooks/useFilters.ts', 26, 9),
              todo(3),
              write('src/api/filters.test.ts', 48),
              bash('pnpm test', '11 个全过', 12),
              todo(4),
              done([
                p('换设备也能读到上次的筛选了。'),
                p('这次改了这些：'),
                li('数据库', '新增 saved_filters 表和对应的迁移。'),
                li('接口', '新增读取和保存两个接口，只能读写自己的。'),
                li('列表页', '打开时向接口要上次的筛选，改动后半秒内保存。'),
                li('测试', '新增 5 个，共 11 个，全部通过。'),
                p('上线前要先跑一次迁移。'),
              ]),
            ],
          },
          {
            label: '放进网址参数',
            desc: '能分享链接，不记住上次',
            then: [
              todo(2),
              say('筛选条件放进网址参数，复制链接就能分享。'),
              edit('src/hooks/useFilters.ts', 22, 10, {
                line: 9,
                lines: [
                  ' export function useFilters() {',
                  '-  const [f, setF] = useState(EMPTY);',
                  '+  const [params, setParams] =',
                  '+    useSearchParams();',
                  '+  const f = decode(params);',
                  '+  const setF = (v) =>',
                  '+    setParams(encode(v));',
                  '   return [f, setF];',
                ],
              }),
              edit('src/pages/posts/List.tsx', 6, 2),
              todo(3),
              write('src/hooks/useFilters.test.ts', 34),
              bash('pnpm test', '8 个全过', 9),
              todo(4),
              done([
                p('筛选条件现在在网址里，复制链接就能分享。'),
                p('这次改了这些：'),
                li('列表页', '筛选一变就更新网址，打开带参数的链接会还原筛选。'),
                li('兼容', '旧链接没有参数，照常显示全部文章。'),
                li('测试', '新增 2 个，共 8 个，全部通过。'),
                p('这种做法不会记住上次的筛选，要记住的话还得再加本地存储。'),
              ]),
            ],
          },
        ],
      },
    ],
    followUp: followUp({
      test: 'pnpm test',
      commit: '列表页记住筛选条件',
      next: [
        say('接下来给筛选栏加一个“清空”按钮。'),
        read('src/components/FilterBar.tsx', 88),
        edit('src/components/FilterBar.tsx', 9, 1),
        bash('pnpm test', '全部通过', 9),
        done([p('筛选栏加了“清空”按钮，一下回到默认筛选。'), li('测试', '全部通过。'), p('还没提交。')]),
      ],
    }),
  };
}

// ---- firmware: running, then asks to push --------------------------------

const DRIVER_COUNTER = [
  ' static int partial_n;',
  ' void epd_flush(rect_t r) {',
  '-  epd_refresh(PARTIAL);',
  '+  if (++partial_n >= 8) {',
  '+    epd_refresh(FULL);',
  '+    partial_n = 0;',
  '+  } else {',
  '+    epd_refresh(PARTIAL);',
  '   }',
  '   epd_wait_busy();',
  ' }',
];

function firmwareReport(last: string): Para[] {
  return [
    p('局刷后的残影问题修好了。'),
    p('这次改了这些：'),
    li('刷新分级', '连续局刷 8 次后自动做一次全刷，清掉残影。'),
    li('计数器', '任何一次全刷之后都清零。'),
    li('配置', '等屏幕忙信号的超时从 2 秒改成 4 秒，全刷不再误报超时。'),
    li('测试', '新增 6 个刷新测试，全部通过；固件编译通过。'),
    p(last),
  ];
}

function firmware(): FakeScript {
  return {
    initial: (t0) =>
      opening(
        t0,
        { id: 'firmware', agent: 'claude', model: 'sonnet-5.5', branch: 'fix/refresh' },
        [
          [19 * MIN, say('先看刷新是怎么分级的。')],
          [18 * MIN, read('README.md', 96)],
          [17 * MIN, grep('PARTIAL', 9)],
          [16 * MIN, bash('git status', '干净', 1)],
          [15 * MIN, read('display/epd_driver.c', 412)],
          [
            14 * MIN,
            edit('boards/config.h', 8, 3, {
              line: 31,
              lines: [
                ' #define EPD_WIDTH  480',
                ' #define EPD_HEIGHT 800',
                '-#define EPD_BUSY_TIMEOUT_MS 2000',
                '+/* 全刷最长要 3.2 秒 */',
                '+#define EPD_BUSY_TIMEOUT_MS 4000',
              ],
            }),
          ],
          [13 * MIN, grep('epd_refresh', 14)],
          [12 * MIN, read('docs/epd-dither.md', 120)],
          [11 * MIN, read('display/epd_lut_partial.h', 64)],
          [
            10 * MIN,
            write('tests/test_refresh.py', 58, [
              '+import pytest',
              '+from epd_sim import Panel',
              '+',
              '+def test_full_after_8_partials():',
              '+    p = Panel()',
              '+    for _ in range(8):',
              '+        p.flush(partial=True)',
              "+    assert p.last_mode == 'FULL'",
              '+',
              '+def test_counter_resets():',
              '+    p = Panel()',
              '+    p.flush(partial=False)',
              '+    assert p.partial_n == 0',
            ]),
          ],
          [
            8 * MIN,
            edit('display/lv_adapter.cc', 12, 9, {
              line: 57,
              lines: [
                ' void flush_cb(lv_display_t *d,',
                '               const lv_area_t *a,',
                '               uint8_t *px) {',
                '   epd_draw(a, px);',
                '-  epd_refresh(PARTIAL);',
                '+  epd_flush(to_rect(a));',
                '   lv_display_flush_ready(d);',
                ' }',
              ],
            }),
          ],
          [7 * MIN, bash('pytest tests/refresh', '失败 2', 9, true)],
          [
            5 * MIN,
            edit('display/epd_driver.c', 36, 21, {
              line: 172,
              lines: [
                ' void epd_refresh(epd_mode_t m) {',
                '-  epd_lut_load(LUT_PARTIAL);',
                '+  switch (m) {',
                '+  case FULL: epd_lut_load(LUT_FULL);',
                '+    break;',
                '+  case FAST: epd_lut_load(LUT_FAST);',
                '+    break;',
                '+  default: epd_lut_load(LUT_PARTIAL);',
                '+  }',
                '   epd_send(CMD_UPDATE);',
              ],
            }),
          ],
          [3 * MIN, read('display/lv_adapter.cc', 88)],
          [2 * MIN, bash('idf.py build', '通过', 14)],
          [1 * MIN, edit('display/epd_driver.c', 18, 7, { line: 214, lines: DRIVER_COUNTER })],
          [0.5 * MIN, say('局刷后残影没清干净。加了一个计数器，累计 8 次强制全刷，再跑一遍刷新测试。')],
        ],
        {
          ctx: 46,
          todos: { done: 3, items: ['复现残影问题', '读刷新相关代码', '改刷新分级', '写刷新计数器', '跑测试并回归'] },
        },
      ),
    steps: [
      bash('pytest tests/refresh', '失败 1', 9, true),
      say('计数器在全刷之后没有清零，补一行。'),
      read('display/epd_driver.c', 40),
      edit(
        'display/epd_driver.c',
        1,
        0,
        {
          line: 226,
          lines: ['   if (m == FULL) {', '     epd_lut_load(LUT_FULL);', '+    partial_n = 0;', '   }'],
        },
        3,
      ),
      bash('pytest tests/refresh', '6 个全过', 8),
      todo(4),
      bash('idf.py build', '通过', 14),
      todo(5),
      bash('git commit -am "局刷累计 8 次后自动全刷"', '已提交', 2),
      {
        do: 'approve',
        ask: {
          verb: 'Bash',
          target: 'git push origin fix/refresh',
          why: '测试和编译都过了，推到远端好开合并请求。',
          risky: true,
        },
        allow: [bash('git push origin fix/refresh', '已推送', 4), done(firmwareReport('已推送到 fix/refresh，可以开合并请求了。'))],
        deny: [say('好，先不推，改动都在本地提交里。'), done(firmwareReport('提交在本地，还没推送。'))],
      },
    ],
    followUp: followUp({
      test: 'pytest tests/refresh',
      commit: '局刷累计 8 次后自动全刷',
      next: [
        say('接下来把全刷的次数放进配置，按屏调。'),
        read('boards/config.h', 48),
        edit('boards/config.h', 2, 0, {
          line: 34,
          lines: ['+/* 连续局刷多少次后全刷一次 */', '+#define EPD_FULL_EVERY 8'],
        }),
        edit('display/epd_driver.c', 1, 1, {
          line: 216,
          lines: ['-  if (++partial_n >= 8) {', '+  if (++partial_n >= EPD_FULL_EVERY) {'],
        }),
        bash('pytest tests/refresh', '6 个全过', 8),
        done([p('全刷次数改成了配置项 EPD_FULL_EVERY，默认还是 8。'), li('测试', '6 个全部通过。'), p('还没提交。')]),
      ],
    }),
  };
}

// ---- landing: running, finishes by itself --------------------------------

function landing(): FakeScript {
  return {
    initial: (t0) =>
      opening(
        t0,
        { id: 'landing', agent: 'claude', model: 'haiku-5.5', branch: 'main' },
        [
          [170, say('先改文案，再压首屏大图。')],
          [160, read('src/pages/index.astro', 64)],
          [140, read('src/components/Hero.astro', 48)],
          [
            120,
            edit('src/components/Hero.astro', 10, 4, {
              line: 12,
              lines: [
                ' <h1 class="title">',
                '-  Build faster',
                '+  写代码，不用守着电脑',
                ' </h1>',
                '-<a href="/signup">Get started</a>',
                '+<a href="/signup">免费试用</a>',
              ],
            }),
          ],
          [90, grep('立即开始', 3)],
          [70, read('src/i18n/zh.json', 52)],
          [
            40,
            edit('src/i18n/zh.json', 8, 2, {
              line: 5,
              lines: ['   "nav.docs": "文档",', '-  "cta": "立即开始",', '+  "cta": "免费试用",', '+  "cta.note": "不用绑卡",'],
            }),
          ],
        ],
        {
          ctx: 12,
          now: { verb: 'Bash', target: 'pnpm build' },
          todos: { done: 1, items: ['改首页标题和按钮文案', '压缩首屏大图', '构建并检查'] },
        },
      ),
    steps: [
      bash('pnpm build', '通过', 14),
      say('文案改好了，再压首屏大图。'),
      bash('npx sharp -i public/hero.png -f webp', '1.8 MB → 240 KB', 6),
      edit('src/components/Hero.astro', 1, 1, {
        line: 4,
        lines: ['-<img src="/hero.png" alt="" />', '+<img src="/hero.webp" alt="" />'],
      }, 3),
      todo(2),
      bash('pnpm build', '通过', 12),
      bash('pnpm test:e2e', '4 个全过', 10),
      todo(3),
      done([
        p('首页文案和首屏图片都改好了。'),
        p('这次改了这些：'),
        li('文案', '标题改成“写代码，不用守着电脑”，按钮改成“免费试用”。'),
        li('图片', '首屏大图转成 WebP，从 1.8 MB 降到 240 KB。'),
        li('检查', '构建通过，4 个页面测试全过。'),
        p('还没提交，要我提交吗？'),
      ]),
    ],
    followUp: followUp({
      test: 'pnpm test:e2e',
      commit: '首页文案和首屏图片',
      next: [
        say('接下来给英文页同步改文案。'),
        read('src/i18n/en.json', 52),
        edit('src/i18n/en.json', 2, 2, {
          line: 5,
          lines: ['-  "cta": "Get started",', '+  "cta": "Try it free",', '+  "cta.note": "No card needed",'],
        }),
        bash('pnpm build', '通过', 12),
        done([p('英文页的按钮文案也同步了。'), li('检查', '构建通过。'), p('还没提交。')]),
      ],
    }),
  };
}

// ---- api-server: already done --------------------------------------------

function apiServer(): FakeScript {
  return {
    initial: (t0) =>
      opening(
        t0,
        { id: 'api-server', agent: 'codex', model: 'gpt-5', branch: 'feat/paging' },
        [
          [13 * MIN, say('先看订单列表接口和现有测试。')],
          [12.8 * MIN, read('src/routes/orders.ts', 118)],
          [12.5 * MIN, read('src/db/orders.ts', 96)],
          [12.2 * MIN, grep('findMany', 7)],
          [12 * MIN, read('test/orders.test.ts', 140)],
          [11.5 * MIN, read('src/schemas/orders.ts', 42)],
          [11 * MIN, read('package.json', 58)],
          [
            10 * MIN,
            edit('src/schemas/orders.ts', 12, 2, {
              line: 8,
              lines: [
                ' export const listQuery = z.object({',
                '   status: z.enum(STATUS).optional(),',
                '+  page: int().min(1).default(1),',
                '+  size: int().max(100).default(20),',
                ' });',
              ],
            }),
          ],
          [
            9 * MIN,
            edit('src/routes/orders.ts', 14, 4, {
              line: 23,
              lines: [
                " r.get('/orders', async (req) => {",
                '-  const q = req.query;',
                '-  return listOrders(q);',
                '+  const q = parseQuery(req.query);',
                '+  const rows = await listOrders(q);',
                '+  return { rows, next: last(rows) };',
                ' });',
              ],
            }),
          ],
          [
            7.5 * MIN,
            edit('src/db/orders.ts', 18, 6, {
              line: 31,
              lines: [
                ' return db.order.findMany({',
                '   where: q.where,',
                '-  orderBy: { createdAt: "desc" },',
                '+  orderBy: { id: "desc" },',
                '+  cursor: q.after && { id: q.after },',
                '+  skip: q.after ? 1 : 0,',
                '+  take: q.size,',
                ' });',
              ],
            }),
          ],
          [7 * MIN, read('src/db/index.ts', 40)],
          [6.5 * MIN, glob('test/**/*.test.ts', 6)],
          [5.5 * MIN, edit('test/orders.test.ts', 16, 0)],
          [4.5 * MIN, bash('npm test', '失败 1', 9, true)],
          [4 * MIN, read('src/db/orders.ts', 102)],
          [
            3 * MIN,
            edit('src/db/orders.ts', 4, 0, {
              line: 28,
              lines: [' export async function listOrders(q) {', '+  if (q.size > 100) {', '+    q.size = 100;', '+  }'],
            }),
          ],
          [2 * MIN, bash('npm test', '12 个全过', 9)],
        ],
        { ctx: 33 },
      ),
    steps: [
      done(
        [
          p('给订单列表接口加了分页，默认每页 20 条，最多 100 条。'),
          p('这次改了这些：'),
          li('接口', '新增 page 和 size 两个参数，不传时结果和原来一样。'),
          li('查询', '改成按主键翻页，十万条以上也不会变慢。'),
          li('测试', '补了 4 个，连同原来的共 12 个，全部通过。'),
          p('两点说明：'),
          li('', '接口文档还没改，需要的话说一声。'),
          li('', '旧客户端不用动，新参数都是可选的。'),
          p('下一步建议把前端列表页接上分页，要我继续吗？'),
        ],
        1 * MIN,
      ),
    ],
    followUp: followUp({
      test: 'npm test',
      commit: '订单列表接口加分页',
      next: [
        say('接着把前端订单列表接上分页。'),
        read('web/src/pages/Orders.tsx', 156),
        edit('web/src/pages/Orders.tsx', 28, 6, {
          line: 40,
          lines: [
            '-const rows = useOrders();',
            '+const [after, go] = useState();',
            '+const { rows, next } = useOrders({',
            '+  after, size: 20 });',
            ' return (',
            '   <Table rows={rows} />',
            '+  <Pager next={next} onNext={go} />',
          ],
        }),
        write('web/src/components/Pager.tsx', 44),
        bash('pnpm --dir web test', '7 个全过', 9),
        done([
          p('前端订单列表接上分页了，每页 20 条。'),
          p('这次改了这些：'),
          li('列表页', '底部加了“上一页、下一页”，翻页时保留筛选。'),
          li('组件', '新增 Pager，别的列表也能用。'),
          li('测试', '前端 7 个全部通过。'),
          p('接口文档还没改。'),
        ]),
      ],
    }),
  };
}

// ---- docs-site: stopped by an error, can't take instructions -------------

/** The end of docs-site's work, whichever way its plan went. */
function docsFinish(): Step[] {
  return [
    bash('pnpm docs:build', '通过', 15),
    todo(5),
    done([
      p('文档站整理完了，可以发布。'),
      p('这次改了这些：'),
      li('安装说明', '写明要 Node 22，补了全局安装和检查版本两步。'),
      li('死链', '修了 2 处，现在全站没有死链。'),
      li('构建', '站点生成通过。'),
      p('中途被接口限流停了一次，恢复后从第 4 步接着做的。'),
    ]),
  ];
}

function docsSite(): FakeScript {
  return {
    initial: (t0) =>
      opening(
        t0,
        { id: 'docs-site', agent: 'claude', model: 'sonnet-5.5', branch: 'main', reply: false },
        [
          [46 * MIN, say('先把文档目录过一遍。')],
          [45 * MIN, glob('docs/**/*.md', 42)],
          [44 * MIN, read('docs/index.md', 60)],
          [43 * MIN, read('docs/install.md', 85)],
          [
            41 * MIN,
            edit('docs/install.md', 9, 2, {
              line: 14,
              lines: [
                ' ## 安装',
                ' ',
                '-npm i codetalky',
                '+需要 Node 22 或更新版本：',
                '+',
                '+    npm install -g codetalky',
                '+    codetalky --version',
              ],
            }),
          ],
          [40 * MIN, read('docs/guide/config.md', 140)],
          [38 * MIN, read('docs/guide/deploy.md', 96)],
          [36 * MIN, read('docs/api/client.md', 210)],
          [34 * MIN, read('docs/api/server.md', 188)],
          [32 * MIN, read('examples/basic/index.ts', 40)],
          [31 * MIN, read('examples/hooks/index.ts', 52)],
          [29 * MIN, grep('](./', 126)],
          [27 * MIN, read('docs/guide/faq.md', 70)],
          [25 * MIN, read('docs/changelog.md', 300)],
          [24 * MIN, read('docs/.vitepress/config.ts', 90)],
          [23 * MIN, read('docs/guide/upgrade.md', 64)],
          [22 * MIN, grep('localhost:3000', 7)],
          [21 * MIN, say('示例代码都核对过了，接下来检查死链。')],
        ],
        {
          ctx: 64,
          todos: { done: 3, items: ['整理目录结构', '补安装说明', '核对示例代码', '检查死链', '生成站点'] },
        },
      ),
    steps: [
      { do: 'error', text: '接口限流，已停在第 4 步', retryAfter: 50, ago: 20 * MIN },
      say('限流解除了，接着检查死链。'),
      bash('pnpm docs:links', '死链 2', 12, true),
      edit('docs/guide/deploy.md', 1, 1, {
        line: 33,
        lines: ['-见[配置说明](./configure.md)。', '+见[配置说明](./config.md)。'],
      }),
      edit('docs/api/client.md', 1, 1, {
        line: 118,
        lines: ['-[服务端](../server.md)', '+[服务端](./server.md)'],
      }),
      bash('pnpm docs:links', '没有死链', 10),
      todo(4),
      say('死链修好了。目录要重排，动的文件多，我先写个计划给你看。'),
      {
        do: 'plan',
        plan: [
          { lead: '重排文档目录的计划', text: '' },
          p('1. 把“指南”拆成“上手”和“进阶”两组，上手放安装、配置、部署，进阶放钩子、API 和升级。'),
          p('2. 侧边栏按新分组重写，首页的入口链接跟着改。'),
          p('3. 旧地址加跳转，免得别处链过来的地址失效。'),
          p('4. 重新检查死链，再生成站点。'),
          p('要动 14 个文件，只挪位置，不改正文内容。'),
        ],
        approve: [
          edit('docs/.vitepress/config.ts', 22, 9, {
            line: 18,
            lines: [" sidebar: {", "-  '/guide/': guide,", "+  '/start/': start,", "+  '/advanced/': advanced,", ' },'],
          }),
          bash('pnpm docs:links', '没有死链', 10),
          ...docsFinish(),
        ],
        sendBack: [say('好，目录先不动，只交付死链的修复。'), ...docsFinish()],
      },
    ],
    followUp: followUp({ test: 'pnpm docs:build', commit: '整理文档站', next: [] }),
  };
}

/** Fresh scripts for one demo run (follow-ups keep a little state, so don't share them). */
export function demoScripts(): FakeScript[] {
  return [codetalky(), blogEngine(), firmware(), landing(), apiServer(), docsSite()];
}

/** 2026-11-14 14:32 in UTC+8: the moment the mockups show. Used by the headless snapshots. */
export const DEMO_T0 = 1794637920;
