# 设备和电脑之间的协议（第 1 版）

设备（真机或仿真器）连到电脑端服务 `bridge`，地址是 `ws://<电脑>:8137/device`。走 WebSocket，每条消息是一段 UTF-8 的 JSON 文本，用 `t` 字段区分类型。

类型定义在 `bridge/src/protocol.ts`，设备端的解析在 `ui/src/ct_proto.c`。改协议时两边一起改，并把 `proto` 加一。

## 连接过程

1. 设备连上后先发 `hello`。
2. 电脑回 `hello`（带当前时间和快速回复），接着把每个会话各发一条 `session`，最后发 `ready`。
3. 之后哪个会话变了，电脑就再发一条它的 `session`；会话没了发 `gone`。
4. 设备上点了什么，就发一条动作消息，电脑回一条 `ack`。

设备收到 `hello` 时不清空旧数据，等到 `ready` 才把这次没重新发来的会话删掉。这样断线重连时屏幕不会闪一下空列表。

## 电脑发给设备

```jsonc
{ "t": "hello", "proto": 1, "time": 1794637920, "tz": 480, "quick": ["继续下一步", "跑一下测试"] }
{ "t": "session", "s": { /* 一个会话的完整快照，见下 */ } }
{ "t": "gone", "id": "会话号" }
{ "t": "ready" }
{ "t": "ack", "seq": 7, "ok": false, "err": "stale" }
```

- `time` 是 Unix 秒，`tz` 是本地时间比 UTC 快多少分钟。设备没有别的时间来源，时钟和“等了几分钟”都靠它。
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
    "list": [ { "file": "epd_driver.c", "line": 214, "add": 5, "del": 1,
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

## 设备发给电脑

```jsonc
{ "t": "hello", "proto": 1, "device": "sim" }
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
- 配对口令：现在电脑端只监听本机地址，仿真器够用。让真机从局域网连进来之前必须先做配对，否则同一个 Wi-Fi 下的任何人都能替你点批准。
