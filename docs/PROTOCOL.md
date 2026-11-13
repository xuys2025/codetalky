# 设备和电脑之间的协议（第 1 版）

设备（真机或仿真器）连到电脑端服务 `bridge`，地址是 `ws://<电脑>:8137/device`。走 WebSocket，每条消息是一段 UTF-8 的 JSON 文本，用 `t` 字段区分类型。

每台跑 agent 的电脑各开一个 `bridge`，设备同时连所有电脑（最多 4 台），每台一条连接。下面说的都是一条连接上的事；会话号只在一台电脑上唯一，设备用“哪条连接 + 会话号”认会话，动作发回会话所在的那条连接。

类型定义在 `bridge/src/protocol.ts`，设备端的解析在 `ui/src/ct_proto.c`。改协议时两边一起改，并把 `proto` 加一。

## 连接过程

1. 设备连上后先发 `hello`。
2. 电脑回 `hello`（带当前时间和快速回复），接着把每个会话各发一条 `session`，最后发 `ready`。
3. 之后哪个会话变了，电脑就再发一条它的 `session`；会话没了发 `gone`。
4. 设备上点了什么，就发一条动作消息，电脑回一条 `ack`。

设备收到 `hello` 时不清空旧数据，等到 `ready` 才把这次没重新发来的会话删掉。这样断线重连时屏幕不会闪一下空列表。

一台电脑断线后，它的会话在设备上保留 5 分钟，电脑名后面标“（离线）”；5 分钟内重连就接着用，超过了才移走。

## 电脑发给设备

```jsonc
{ "t": "hello", "proto": 1, "host": "台式机", "hostId": "6f1c…:8137",
  "time": 1794637920, "tz": 480, "quick": ["继续下一步", "跑一下测试"] }
{ "t": "session", "s": { /* 一个会话的完整快照，见下 */ } }
{ "t": "gone", "id": "会话号" }
{ "t": "ready" }
{ "t": "ack", "seq": 7, "ok": false, "err": "stale" }
```

- `host` 是这台电脑在设备上显示的名字（`bridge --name` 设置，默认电脑名）。设备连着不止一台电脑时，列表、详情、批准页都会写出会话在哪台电脑上。
- `hostId` 是这台电脑上这个 `bridge` 的固定编号（存在 `~/.codetalky/bridge-id`，加端口号），换了 IP 也不变，以后配对用它记住电脑。
- `time` 是 Unix 秒，`tz` 是本地时间比 UTC 快多少分钟。设备没有别的时间来源，时钟和“等了几分钟”都靠它；连着几台电脑时用最近一次 `hello` 的。
- `quick` 是这台电脑的快速回复，每台可以不一样。
- `ack.err` 的取值：`gone` 会话不在了；`stale` 这个请求已经处理过或换了一个；`unsupported` 这个会话不能这么操作；`bad` 消息格式不对。

电脑先发变化后的 `session`，再发 `ack`。设备收到 `ack` 时手里已经是最新状态，可以只刷一次屏。

### 会话快照

每次都发完整快照，不发增量。设备整个替换，不用合并。

```jsonc
{
  "id": "f3a1…",            // 会话号，最长 47 字节
  "name": "firmware",       // 项目名
  "agent": "claude",        // claude 或 codex
  "model": "sonnet-5.5",
  "branch": "fix/refresh",  // 可省
  "state": "running",       // idle running approve question done error
  "since": 1794637800,      // 进入当前状态的时间
  "started": 1794637440,    // 这一轮任务开始的时间
  "reply": true,            // 能不能从设备给它发新指令
  "now": { "verb": "Edit", "target": "display/epd_driver.c", "add": 18, "del": 7 },
  "say": "局刷后残影没清干净……",   // agent 最近说的一段话
  "n": { "read": 21, "edit": 4, "new": 1, "cmd": 6, "add": 132, "del": 40 },
  "ctx": 46,                // 上下文用了百分之几，可省
  "todos": { "done": 3, "items": ["复现残影问题", "读刷新相关代码"] },
  "log": [                  // 做过的事，新的在前，电脑端最多留 48 条
    { "at": 1794637860, "verb": "Edit", "target": "epd_driver.c", "add": 18, "del": 7 },
    { "at": 1794637800, "verb": "Bash", "target": "pytest tests/refresh", "res": "失败 2", "bad": true }
  ],
  "files": [ { "st": "M", "path": "display/epd_driver.c", "add": 54, "del": 28 } ],
  "hunks": {                // 改动片段，total 是总数，list 最多 6 段
    "total": 4,
    "list": [ { "file": "display/epd_driver.c", "line": 214, "add": 5, "del": 1,
                "lines": [" static int partial_n;", "-  epd_refresh(PARTIAL);", "+  if (++partial_n >= 8) {"] } ]
  },
  "ask": { /* state 是 approve 或 question 时才有，见下 */ },
  "report": [               // state 是 done 时的完成汇报，一段一项
    { "text": "给订单列表接口加了分页。" },
    { "b": true, "lead": "接口", "text": "：新增 page 和 size 两个参数。" }
  ],
  "err": "接口限流，已停在第 4 步"   // state 是 error 时的原因
}
```

`log` 里一条记录有 `add`、`del` 就显示成“+18 −7”，否则显示 `res`。`lines` 每行的第一个字符是空格、`+` 或 `-`。

等批准：

```jsonc
"ask": { "kind": "approve", "req": "r12", "verb": "Edit", "target": "src/bridge/hooks.ts",
         "add": 4, "del": 1, "line": 41, "lines": ["-const TIMEOUT_S = 60;", "+const TIMEOUT_S = 600;"],
         "why": "60 秒太短，在设备上来不及点。", "until": 1794638400, "risky": false }
```

`until` 之后设备上就点不了了，要回电脑确认。`risky` 为真时设备要求长按才批准。`verb` 是 `Bash` 时 `target` 是整条命令，没有 `lines`。

等回答：

```jsonc
"ask": { "kind": "question", "req": "r13", "text": "用户保存的筛选条件，存在哪里？",
         "note": "三种做法成本不一样。",
         "options": [ { "label": "浏览器本地", "desc": "最简单，换设备就没了" } ] }
```

## 配对（局域网里的设备）

从别的机器连进来的设备要先证明自己配对过；从电脑本机连的（仿真器页面）不用。

1. 设备的 `hello` 带上自己的固定编号 `deviceId`（16 到 32 位十六进制，第一次开机时随机生成并保存）。
2. 电脑不回 `hello`，先回 `{ "t": "auth", "host": "台式机", "hostId": "…" }`。
3. 设备若保存过这台电脑（按 `hostId`）给的令牌，回 `{ "t": "auth", "token": "…" }`；令牌对，电脑照常发 `hello`、全部会话、`ready`。令牌不对，电脑再发一次 `auth` 并带 `"bad": true`，设备删掉这个令牌。
4. 没有令牌：设备随机生成 6 位配对码，显示在屏幕上，并发 `{ "t": "pair", "code": "482159" }`。用户在那台电脑上运行 `codetalky pair 482159` 确认后，电脑发 `{ "t": "paired", "token": "…" }`（64 位十六进制），设备按 `hostId` 存起来，然后照常同步。
5. 配对码在电脑上 5 分钟内有效；设备在 4 分 40 秒时自动换一个新码重新申请。

配对前设备发的动作一律不算数。电脑只保存令牌的哈希（`~/.codetalky/devices.json`），`codetalky devices` 列出已配对的设备，`codetalky unpair <编号或名字>` 撤销。

已知局限：令牌走的是不加密的 WebSocket，同一网段里能抓包的人可以拿去重放。以后改成挑战应答（电脑发随机数，设备回令牌对它的 HMAC），令牌就不必在网上传了。

## 设备发给电脑

```jsonc
{ "t": "hello", "proto": 1, "device": "sim", "deviceId": "212762a261d37f1f" }
{ "t": "approve", "seq": 7, "id": "会话号", "req": "r12", "allow": true }
{ "t": "answer",  "seq": 8, "id": "会话号", "req": "r13", "option": 0 }
{ "t": "reply",   "seq": 9, "id": "会话号", "text": "继续下一步" }
{ "t": "seen",    "seq": 10, "id": "会话号" }
```

- `seq` 由设备自己编号，电脑在 `ack` 里原样带回。
- `approve` 和 `answer` 必须带上屏幕上显示的那个 `req`。电脑发现它和当前等待的请求对不上就拒绝（`stale`），防止批准到另一个请求上。
- `reply` 是发一句新指令，快速回复和语音识别出的文字都走它。
- `seen` 表示完成汇报看过了，会话从 `done` 变成 `idle`。

## 还没有的

- 语音：设备上传音频、电脑回识别文字。第 3 阶段做，音频走二进制帧。
- 按需取详情：一条活动记录的完整输出、一个文件的全部改动。
